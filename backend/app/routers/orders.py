from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.access import (
    CANCELLABLE,
    assert_bort_assignable,
    get_order_or_404,
    get_owned_order,
    get_owned_vehicle,
    get_usable_point,
    release_bort,
    require_roles,
    visible_orders_query,
)
from app.auth import get_current_user
from app.database import get_db
from app.models import Order, User, Vehicle
from app.roles import CARRIER, DRIVER, SENDER
from app.schemas import OrderAssignIn, OrderCreate, OrderOut, OrderUpdate, QuoteOut, TakeOrderIn
from app.services.events import bus
from app.services.matching import match_for_vehicle, match_orders
from app.services.osrm import ensure_route, get_cached_route, route_coords
from app.services.pricing import price_model
from app.services.simulator import publish_vehicles

router = APIRouter(prefix="/api/orders", tags=["orders"])

DbDep = Annotated[Session, Depends(get_db)]
UserDep = Annotated[User, Depends(get_current_user)]


def _out(o: Order, plate: str | None = None) -> OrderOut:
    return OrderOut(
        id=o.id,
        sender_id=o.sender_id,
        origin_id=o.origin_id,
        dest_id=o.dest_id,
        origin_name=o.origin.name,
        dest_name=o.dest.name,
        cargo_type=o.cargo_type,
        cargo_title=o.cargo_title,
        weight_kg=o.weight_kg,
        price_offered=o.price_offered,
        price_recommended=o.price_recommended,
        status=o.status,
        carrier_id=o.carrier_id,
        vehicle_id=o.vehicle_id,
        distance_km=o.distance_km,
        empty_km_saved=o.empty_km_saved,
        is_backhaul=o.is_backhaul,
        created_at=o.created_at,
        origin_lat=o.origin.lat,
        origin_lon=o.origin.lon,
        dest_lat=o.dest.lat,
        dest_lon=o.dest.lon,
        sender_name=o.sender.name if o.sender else None,
        plate=plate,
    )


def _plate(db: Session, o: Order) -> str | None:
    if not o.vehicle_id:
        return None
    v = db.get(Vehicle, o.vehicle_id)
    return v.plate if v else None


@router.get("/quote", response_model=QuoteOut)
async def quote(
    origin_id: int,
    dest_id: int,
    db: DbDep,
    user: UserDep,
    weight_kg: int = 1000,
    cargo_type: str = "general",
):
    origin = get_usable_point(db, user, origin_id)
    dest = get_usable_point(db, user, dest_id)
    if origin.id == dest.id:
        raise HTTPException(400, "Откуда и куда совпадают")
    route = await ensure_route(db, origin, dest)
    price = price_model.predict(route.distance_km, weight_kg, cargo_type)
    return QuoteOut(
        distance_km=route.distance_km,
        duration_min=round(route.duration_s / 60, 0),
        price_recommended=price,
        geometry=route_coords(route),
    )


@router.get("", response_model=list[OrderOut])
def list_orders(
    db: DbDep,
    user: UserDep,
    status: str | None = None,
):
    q = visible_orders_query(db, user)
    if status:
        q = q.filter(Order.status == status)
    rows = q.order_by(Order.id.desc()).all()
    return [_out(o, _plate(db, o)) for o in rows]


@router.get("/hints/backhaul")
def backhaul(db: DbDep, user: Annotated[User, Depends(require_roles(CARRIER))]):
    open_orders = visible_orders_query(db, user).filter(Order.status == "open").all()
    fleet = db.query(Vehicle).filter(Vehicle.owner_id == user.id, Vehicle.active.is_(True)).all()
    best: dict[int, dict] = {}
    for v in fleet:
        for h in match_for_vehicle(db, v, open_orders):
            prev = best.get(h["order_id"])
            if not prev or h["empty_km_saved"] > prev["empty_km_saved"]:
                best[h["order_id"]] = h
    return list(best.values())


@router.get("/hints/leg")
def leg_hints(
    origin_id: int,
    dest_id: int,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(CARRIER, SENDER))],
):
    origin = get_usable_point(db, user, origin_id)
    dest = get_usable_point(db, user, dest_id)
    open_orders = visible_orders_query(db, user).filter(Order.status == "open").all()
    return match_orders(db, origin, dest, open_orders)


@router.get("/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: DbDep, user: UserDep):
    o = get_order_or_404(db, user, order_id)
    return _out(o, _plate(db, o))


@router.post("", response_model=OrderOut)
async def create_order(
    body: OrderCreate,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(SENDER))],
):
    origin = get_usable_point(db, user, body.origin_id)
    dest = get_usable_point(db, user, body.dest_id)
    if origin.id == dest.id:
        raise HTTPException(400, "Откуда и куда совпадают")
    route = await ensure_route(db, origin, dest)
    rec = price_model.predict(route.distance_km, body.weight_kg, body.cargo_type)
    offered = body.price_offered or rec
    o = Order(
        sender_id=user.id,
        origin_id=origin.id,
        dest_id=dest.id,
        cargo_type=body.cargo_type,
        cargo_title=body.cargo_title,
        weight_kg=body.weight_kg,
        price_offered=offered,
        price_recommended=rec,
        status="open",
        distance_km=route.distance_km,
    )
    db.add(o)
    db.commit()
    o = get_order_or_404(db, user, o.id)
    bus.publish({"type": "order_new", "id": o.id})
    return _out(o)


@router.patch("/{order_id}", response_model=OrderOut)
async def update_order(
    order_id: int,
    body: OrderUpdate,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(SENDER))],
):
    o = get_owned_order(db, user, order_id, as_sender=True)
    if o.status != "open":
        raise HTTPException(409, "Редактировать можно только открытую заявку")
    origin_id = body.origin_id or o.origin_id
    dest_id = body.dest_id or o.dest_id
    origin = get_usable_point(db, user, origin_id)
    dest = get_usable_point(db, user, dest_id)
    if origin.id == dest.id:
        raise HTTPException(400, "Откуда и куда совпадают")
    if body.origin_id or body.dest_id or body.weight_kg or body.cargo_type:
        route = await ensure_route(db, origin, dest)
        o.origin_id = origin.id
        o.dest_id = dest.id
        o.distance_km = route.distance_km
        weight = body.weight_kg or o.weight_kg
        cargo = body.cargo_type or o.cargo_type
        o.price_recommended = price_model.predict(route.distance_km, weight, cargo)
    for field in ("cargo_type", "cargo_title", "weight_kg", "price_offered"):
        value = getattr(body, field)
        if value is not None:
            setattr(o, field, value)
    db.commit()
    o = get_order_or_404(db, user, o.id)
    return _out(o, _plate(db, o))


@router.post("/{order_id}/cancel", response_model=OrderOut)
def cancel_order(
    order_id: int,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(SENDER))],
):
    o = get_owned_order(db, user, order_id, as_sender=True)
    if o.status not in CANCELLABLE:
        raise HTTPException(409, "Отменить можно только до прибытия на погрузку")
    release_bort(db, o)
    o.status = "cancelled"
    db.commit()
    bus.publish({"type": "order", "id": o.id, "status": "cancelled"})
    publish_vehicles(db)
    o = get_order_or_404(db, user, o.id)
    return _out(o)


@router.delete("/{order_id}")
def delete_order(
    order_id: int,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(SENDER))],
):
    o = get_owned_order(db, user, order_id, as_sender=True)
    if o.status != "open":
        raise HTTPException(409, "Удалить можно только заявку, которую ещё не взяли")
    oid = o.id
    db.delete(o)
    db.commit()
    bus.publish({"type": "order", "id": oid, "status": "deleted"})
    return {"ok": True}


@router.post("/{order_id}/take", response_model=OrderOut)
def take_order(
    order_id: int,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(CARRIER))],
    body: TakeOrderIn | None = None,
):
    o = get_order_or_404(db, user, order_id)
    if o.status != "open":
        raise HTTPException(409, "Заявка уже занята")
    o.status = "taken"
    o.carrier_id = user.id
    o.taken_at = datetime.utcnow()
    db.commit()
    bus.publish({"type": "order", "id": o.id, "status": "taken"})
    o = get_order_or_404(db, user, o.id)
    return _out(o)


def _assign_to_vehicle(db: Session, o: Order, v: Vehicle) -> None:
    assert_bort_assignable(v, o)
    hints = match_for_vehicle(db, v, [o])
    if hints:
        o.empty_km_saved = hints[0]["empty_km_saved"]
        o.is_backhaul = True
    if o.vehicle_id and o.vehicle_id != v.id:
        old = db.get(Vehicle, o.vehicle_id)
        if old and old.current_order_id == o.id:
            old.current_order_id = None
            old.status = "idle"
    o.vehicle_id = v.id
    o.status = "assigned"
    v.current_order_id = o.id
    v.status = "assigned"


@router.post("/{order_id}/assign", response_model=OrderOut)
def assign_order(
    order_id: int,
    body: OrderAssignIn,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(CARRIER))],
):
    o = get_owned_order(db, user, order_id, as_carrier=True)
    if o.status not in {"taken", "assigned"}:
        raise HTTPException(409, "Назначить борт можно только до прибытия на погрузку")
    v = get_owned_vehicle(db, user, body.vehicle_id)
    _assign_to_vehicle(db, o, v)
    db.commit()
    bus.publish({"type": "order", "id": o.id, "status": o.status})
    o = get_order_or_404(db, user, o.id)
    return _out(o, v.plate)


@router.get("/{order_id}/route")
def order_route(order_id: int, db: DbDep, user: UserDep):
    o = get_order_or_404(db, user, order_id)
    cached = get_cached_route(db, o.origin_id, o.dest_id)
    if not cached:
        return {"geometry": [], "distance_km": o.distance_km}
    return {"geometry": route_coords(cached), "distance_km": cached.distance_km}

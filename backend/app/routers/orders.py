from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from app.auth import get_current_user, get_optional_user
from app.database import get_db
from app.models import Order, Settlement, User, Vehicle
from app.schemas import OrderCreate, OrderOut, QuoteOut, TakeOrderIn
from app.services.events import bus
from app.services.matching import match_for_vehicle, match_orders
from app.services.osrm import ensure_route, get_cached_route, route_coords
from app.services.pricing import price_model
from app.services.simulator import assign_route

router = APIRouter(prefix="/api/orders", tags=["orders"])


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


def _load(db: Session, q):
    return q.options(
        joinedload(Order.origin),
        joinedload(Order.dest),
        joinedload(Order.sender),
    )


@router.get("/quote", response_model=QuoteOut)
async def quote(
    origin_id: int,
    dest_id: int,
    db: Annotated[Session, Depends(get_db)],
    weight_kg: int = 1000,
    cargo_type: str = "general",
):
    origin, dest = db.get(Settlement, origin_id), db.get(Settlement, dest_id)
    if not origin or not dest:
        raise HTTPException(404, "Населённый пункт не найден")
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
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User | None, Depends(get_optional_user)] = None,
    status: str | None = None,
    mine: bool = False,
):
    q = _load(db, db.query(Order))
    if status:
        q = q.filter(Order.status == status)
    if mine and user:
        if user.role == "sender":
            q = q.filter(Order.sender_id == user.id)
        elif user.role == "carrier":
            q = q.filter(Order.carrier_id == user.id)
    rows = q.order_by(Order.id.desc()).all()
    plates = {v.id: v.plate for v in db.query(Vehicle).all()}
    return [_out(o, plates.get(o.vehicle_id) if o.vehicle_id else None) for o in rows]


@router.get("/hints/backhaul")
def backhaul(
    vehicle_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    v = db.get(Vehicle, vehicle_id)
    if not v:
        raise HTTPException(404, "Машина не найдена")
    open_orders = _load(db, db.query(Order).filter(Order.status == "open")).all()
    return match_for_vehicle(db, v, open_orders)


@router.get("/hints/leg")
def leg_hints(
    origin_id: int,
    dest_id: int,
    db: Annotated[Session, Depends(get_db)],
):
    origin, dest = db.get(Settlement, origin_id), db.get(Settlement, dest_id)
    if not origin or not dest:
        raise HTTPException(404)
    open_orders = _load(db, db.query(Order).filter(Order.status == "open")).all()
    return match_orders(db, origin, dest, open_orders)


@router.get("/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: Annotated[Session, Depends(get_db)]):
    o = _load(db, db.query(Order).filter(Order.id == order_id)).one_or_none()
    if not o:
        raise HTTPException(404, "Заявка не найдена")
    plate = None
    if o.vehicle_id:
        v = db.get(Vehicle, o.vehicle_id)
        plate = v.plate if v else None
    return _out(o, plate)


@router.post("", response_model=OrderOut)
async def create_order(
    body: OrderCreate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    origin, dest = db.get(Settlement, body.origin_id), db.get(Settlement, body.dest_id)
    if not origin or not dest:
        raise HTTPException(404, "Пункт не найден")
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
    o = _load(db, db.query(Order).filter(Order.id == o.id)).one()
    bus.publish({"type": "order_new", "id": o.id})
    return _out(o)


@router.post("/{order_id}/take", response_model=OrderOut)
def take_order(
    order_id: int,
    body: TakeOrderIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    if user.role not in {"carrier", "admin", "dispatcher", "driver"}:
        raise HTTPException(403, "Только перевозчик может брать заказ")
    o = _load(db, db.query(Order).filter(Order.id == order_id)).one_or_none()
    if not o:
        raise HTTPException(404, "Заявка не найдена")
    if o.status != "open":
        raise HTTPException(409, "Заявка уже занята")
    v = db.get(Vehicle, body.vehicle_id)
    if not v:
        raise HTTPException(404, "Машина не найдена")
    if v.capacity_kg < o.weight_kg:
        raise HTTPException(400, "Груз тяжелее грузоподъёмности")

    hints = match_for_vehicle(db, v, [o])
    if hints:
        o.empty_km_saved = hints[0]["empty_km_saved"]
        o.is_backhaul = True

    o.status = "transit"
    o.carrier_id = v.owner_id
    o.vehicle_id = v.id
    o.taken_at = datetime.utcnow()
    v.current_order_id = o.id
    v.status = "enroute"
    assign_route(db, v, o.origin_id, o.dest_id)
    db.commit()
    bus.publish({"type": "order", "id": o.id, "status": "transit"})
    o = _load(db, db.query(Order).filter(Order.id == o.id)).one()
    return _out(o, v.plate)


@router.get("/{order_id}/route")
def order_route(order_id: int, db: Annotated[Session, Depends(get_db)]):
    o = db.get(Order, order_id)
    if not o:
        raise HTTPException(404, "Заявка не найдена")
    cached = get_cached_route(db, o.origin_id, o.dest_id)
    if not cached:
        return {"geometry": [], "distance_km": o.distance_km}
    return {"geometry": route_coords(cached), "distance_km": cached.distance_km}

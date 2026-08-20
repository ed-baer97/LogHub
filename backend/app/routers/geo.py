import os
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from app.access import get_owned_point, require_roles, visible_settlements_query, visible_vehicles_query
from app.auth import get_current_user
from app.database import get_db
from app.models import Order, RouteCache, Settlement, User, Vehicle
from app.paging import page_params, paginate
from app.roles import SENDER
from app.schemas import CorridorOut, Page, SettlementCreate, SettlementOut, SettlementUpdate, VehicleOut
from app.services.fleet import to_vehicle_out
from app.services.geo import load_coords, looks_like_road
from app.services.osrm import ensure_road_route, get_cached_route

DEMO_CORRIDORS = [
    ("Актау", "Жанаозен"),
    ("Актау", "Шетпе"),
    ("Шетпе", "Бейнеу"),
    ("Актау", "Форт-Шевченко"),
    ("Актау", "Курык"),
    ("Жанаозен", "Шетпе"),
]

router = APIRouter(prefix="/api/geo", tags=["geo"])

DbDep = Annotated[Session, Depends(get_db)]
UserDep = Annotated[User, Depends(get_current_user)]


@router.get("/catalog", response_model=list[SettlementOut])
def catalog(db: DbDep):
    """Публичный справочник пунктов платформы (без точек отправителей)."""
    return (
        db.query(Settlement)
        .filter(Settlement.sender_id.is_(None))
        .order_by(Settlement.kind, Settlement.name)
        .all()
    )


@router.get("/corridors", response_model=list[CorridorOut])
def corridors(db: DbDep):
    """Демо-маршруты лендинга: геометрия по дорогам (OSRM), без операционных данных."""
    by_name = {
        s.name: s
        for s in db.query(Settlement).filter(Settlement.sender_id.is_(None)).all()
    }
    testing = bool(os.getenv("TESTING"))
    out: list[CorridorOut] = []
    for a_name, b_name in DEMO_CORRIDORS:
        a, b = by_name.get(a_name), by_name.get(b_name)
        if not a or not b:
            continue
        if testing:
            row = get_cached_route(db, a.id, b.id) or get_cached_route(db, b.id, a.id)
        else:
            row = ensure_road_route(db, a, b)
        if not row:
            continue
        coords = load_coords(row.geometry)
        if not looks_like_road(coords):
            continue
        if row.origin_id != a.id:
            coords = list(reversed(coords))
        out.append(CorridorOut(id=f"{a_name}-{b_name}", origin=a_name, dest=b_name, coords=coords))
    return out


@router.get("/settlements", response_model=list[SettlementOut])
def settlements(db: DbDep, user: UserDep):
    return visible_settlements_query(db, user).order_by(Settlement.kind, Settlement.name).all()


@router.post("/settlements", response_model=SettlementOut)
def create_settlement(
    body: SettlementCreate,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(SENDER))],
):
    if db.query(Settlement).filter(Settlement.name == body.name).first():
        raise HTTPException(409, "Пункт с таким названием уже есть")
    s = Settlement(
        name=body.name.strip(),
        kind=body.kind,
        lat=body.lat,
        lon=body.lon,
        population=body.population,
        note=body.note,
        sender_id=user.id,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


@router.patch("/settlements/{settlement_id}", response_model=SettlementOut)
def update_settlement(
    settlement_id: int,
    body: SettlementUpdate,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(SENDER))],
):
    s = get_owned_point(db, user, settlement_id)
    moved = body.lat is not None or body.lon is not None
    for field in ("name", "kind", "lat", "lon", "population", "note"):
        value = getattr(body, field)
        if value is not None:
            setattr(s, field, value)
    if moved:
        db.query(RouteCache).filter(
            (RouteCache.origin_id == s.id) | (RouteCache.dest_id == s.id)
        ).delete()
    db.commit()
    db.refresh(s)
    return s


@router.delete("/settlements/{settlement_id}")
def delete_settlement(
    settlement_id: int,
    db: DbDep,
    user: Annotated[User, Depends(require_roles(SENDER))],
):
    s = get_owned_point(db, user, settlement_id)
    used_orders = db.query(Order).filter(
        (Order.origin_id == s.id) | (Order.dest_id == s.id)
    ).count()
    used_vehicles = db.query(Vehicle).filter(Vehicle.home_id == s.id).count()
    if used_orders or used_vehicles:
        raise HTTPException(409, "Пункт используется в заявках")
    db.query(RouteCache).filter(
        (RouteCache.origin_id == s.id) | (RouteCache.dest_id == s.id)
    ).delete()
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.get("/vehicles", response_model=Page[VehicleOut])
def vehicles(db: DbDep, user: UserDep, paging: Annotated[tuple[int, int], Depends(page_params)]):
    limit, offset = paging
    q = visible_vehicles_query(db, user).options(joinedload(Vehicle.assigned_driver))
    rows, total, limit, offset = paginate(q, order_by=Vehicle.plate, limit=limit, offset=offset)
    return Page(items=[to_vehicle_out(v) for v in rows], total=total, limit=limit, offset=offset)

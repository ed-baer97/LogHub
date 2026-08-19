from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from app.access import get_owned_point, require_roles, visible_settlements_query, visible_vehicles_query
from app.auth import get_current_user
from app.database import get_db
from app.models import Order, RouteCache, Settlement, User, Vehicle
from app.roles import SENDER
from app.schemas import SettlementCreate, SettlementOut, SettlementUpdate, VehicleOut
from app.services.fleet import to_vehicle_out

router = APIRouter(prefix="/api/geo", tags=["geo"])

DbDep = Annotated[Session, Depends(get_db)]
UserDep = Annotated[User, Depends(get_current_user)]


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


@router.get("/vehicles", response_model=list[VehicleOut])
def vehicles(db: DbDep, user: UserDep):
    rows = (
        visible_vehicles_query(db, user)
        .options(joinedload(Vehicle.assigned_driver))
        .order_by(Vehicle.plate)
        .all()
    )
    return [to_vehicle_out(v) for v in rows]

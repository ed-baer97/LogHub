from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from app.access import get_owned_vehicle, require_roles
from app.auth import hash_password
from app.database import get_db
from app.models import Settlement, User, Vehicle
from app.roles import CARRIER
from app.schemas import BortCreate, BortUpdate, UserOut, VehicleOut
from app.services.fleet import attach_driver, require_carrier, to_vehicle_out
from app.services.simulator import publish_vehicles

router = APIRouter(prefix="/api/fleet", tags=["fleet"])

CarrierDep = Annotated[User, Depends(require_roles(CARRIER))]
DbDep = Annotated[Session, Depends(get_db)]


def _vehicle_out(v: Vehicle, initial_password: str | None = None) -> VehicleOut:
    return to_vehicle_out(v, initial_password)


def _user_out(u: User, initial: str | None = None) -> UserOut:
    item = UserOut.model_validate(u)
    item.initial_password = initial
    return item


@router.get("/drivers", response_model=list[UserOut])
def list_drivers(db: DbDep, user: CarrierDep):
    require_carrier(user)
    rows = (
        db.query(User)
        .filter(User.role == "driver", User.carrier_id == user.id)
        .order_by(User.name)
        .all()
    )
    return [_user_out(d) for d in rows]


@router.get("/vehicles", response_model=list[VehicleOut])
def list_vehicles(db: DbDep, user: CarrierDep):
    require_carrier(user)
    rows = (
        db.query(Vehicle)
        .options(joinedload(Vehicle.assigned_driver))
        .filter(Vehicle.owner_id == user.id)
        .order_by(Vehicle.plate)
        .all()
    )
    return [_vehicle_out(v) for v in rows]


@router.post("/borts", response_model=VehicleOut)
def create_bort(body: BortCreate, db: DbDep, user: CarrierDep):
    require_carrier(user)
    if db.query(Vehicle).filter(Vehicle.plate == body.plate).first():
        raise HTTPException(409, "Госномер уже есть в парке")
    if db.query(User).filter(User.email == body.driver_email).first():
        raise HTTPException(409, "Email водителя уже занят")
    home = db.get(Settlement, body.home_id)
    if not home or home.sender_id is not None:
        raise HTTPException(404, "База (пункт) не найдена")
    driver = User(
        email=body.driver_email,
        name=body.driver_name,
        role="driver",
        company=user.company,
        phone=body.driver_phone,
        password_hash=hash_password(body.driver_password),
        password_plain=body.driver_password,
        carrier_id=user.id,
        is_active=True,
    )
    db.add(driver)
    db.flush()
    v = Vehicle(
        plate=body.plate,
        kind=body.kind,
        capacity_kg=body.capacity_kg,
        owner_id=user.id,
        home_id=home.id,
        status="idle",
        lat=home.lat,
        lon=home.lon,
        heading=90,
        driver_name=driver.name,
        active=True,
    )
    attach_driver(db, v, driver.id, user.id)
    db.add(v)
    db.commit()
    v = db.query(Vehicle).options(joinedload(Vehicle.assigned_driver)).filter(Vehicle.id == v.id).one()
    publish_vehicles(db)
    return _vehicle_out(v, body.driver_password)


@router.patch("/borts/{vehicle_id}", response_model=VehicleOut)
def update_bort(vehicle_id: int, body: BortUpdate, db: DbDep, user: CarrierDep):
    v = get_owned_vehicle(db, user, vehicle_id)
    if body.home_id is not None:
        home = db.get(Settlement, body.home_id)
        if not home or home.sender_id is not None:
            raise HTTPException(404, "Пункт не найден")
        v.home_id = body.home_id
    for field in ("plate", "kind", "capacity_kg"):
        value = getattr(body, field)
        if value is not None:
            setattr(v, field, value)
    if body.active is not None:
        if body.active is False and v.current_order_id:
            raise HTTPException(409, "Нельзя отключить борт в рейсе")
        v.active = body.active
    if body.driver_name and v.driver_id:
        driver = db.get(User, v.driver_id)
        if driver:
            driver.name = body.driver_name
            v.driver_name = body.driver_name
    if body.driver_phone is not None and v.driver_id:
        driver = db.get(User, v.driver_id)
        if driver:
            driver.phone = body.driver_phone
    if body.driver_email and v.driver_id:
        taken = db.query(User).filter(User.email == body.driver_email, User.id != v.driver_id).first()
        if taken:
            raise HTTPException(409, "Email водителя уже занят")
        driver = db.get(User, v.driver_id)
        if driver:
            driver.email = body.driver_email
    initial = None
    if body.driver_password and v.driver_id:
        driver = db.get(User, v.driver_id)
        if driver:
            driver.password_hash = hash_password(body.driver_password)
            driver.password_plain = body.driver_password
            initial = body.driver_password
    if body.driver_active is not None and v.driver_id:
        if body.driver_active is False and v.current_order_id:
            raise HTTPException(409, "Нельзя заблокировать водителя в рейсе")
        driver = db.get(User, v.driver_id)
        if driver:
            driver.is_active = body.driver_active
    db.commit()
    v = db.query(Vehicle).options(joinedload(Vehicle.assigned_driver)).filter(Vehicle.id == v.id).one()
    publish_vehicles(db)
    return _vehicle_out(v, initial)


@router.post("/borts/{vehicle_id}/disable", response_model=VehicleOut)
def disable_bort(vehicle_id: int, db: DbDep, user: CarrierDep):
    v = get_owned_vehicle(db, user, vehicle_id)
    if v.current_order_id:
        raise HTTPException(409, "Нельзя отключить борт в рейсе")
    v.active = False
    db.commit()
    db.refresh(v)
    publish_vehicles(db)
    return _vehicle_out(v)

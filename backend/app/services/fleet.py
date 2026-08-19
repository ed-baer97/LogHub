from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.auth import hash_password
from app.models import User, Vehicle
from app.schemas import VehicleOut


def to_vehicle_out(v: Vehicle, initial_password: str | None = None) -> VehicleOut:
    item = VehicleOut.model_validate(v)
    item.live = bool(v.live_until and v.live_until > datetime.utcnow())
    driver = v.assigned_driver
    if driver:
        item.driver_email = driver.email
        item.driver_phone = driver.phone
        item.driver_active = bool(getattr(driver, "is_active", True))
    item.initial_password = initial_password
    return item


def attach_driver(db: Session, v: Vehicle, driver_id: int, owner_id: int) -> None:
    driver = db.get(User, driver_id)
    if not driver or driver.role != "driver":
        raise HTTPException(400, "Нужна учётка с ролью «водитель»")
    if driver.carrier_id and driver.carrier_id != owner_id:
        raise HTTPException(403, "Водитель принадлежит другой компании")
    q = db.query(Vehicle).filter(Vehicle.driver_id == driver.id)
    if v.id:
        q = q.filter(Vehicle.id != v.id)
    other = q.first()
    if other:
        raise HTTPException(409, f"Водитель уже закреплён за бортом {other.plate}")
    driver.carrier_id = owner_id
    v.driver_id = driver.id
    v.driver_name = driver.name


def require_carrier(user: User) -> User:
    if user.role != "carrier":
        raise HTTPException(403, "Только для перевозчика")
    return user

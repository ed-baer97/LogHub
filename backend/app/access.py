"""RBAC + ownership + status gates. Prefer 404 over 403 so IDs of others stay hidden."""
from __future__ import annotations

from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from app.auth import get_current_user
from app.models import Order, Settlement, User, Vehicle
from app.roles import ADMIN, CARRIER, DRIVER, SENDER, SUPERADMIN, is_staff, normalize_role

AuthUser = Annotated[User, Depends(get_current_user)]


def role_of(user: User) -> str:
    return normalize_role(user.role)


def require_roles(*allowed: str) -> Callable[..., User]:
    allowed_norm = {normalize_role(r) for r in allowed}

    def dep(user: AuthUser) -> User:
        if role_of(user) not in allowed_norm:
            raise HTTPException(403, "Недостаточно прав")
        return user

    return dep


def require_staff(user: AuthUser) -> User:
    if not is_staff(user.role):
        raise HTTPException(403, "Доступно только администратору")
    return user


def require_superadmin(user: AuthUser) -> User:
    if role_of(user) != SUPERADMIN:
        raise HTTPException(403, "Только супер-админ")
    return user


def require_admin_users(user: AuthUser) -> User:
    if role_of(user) != ADMIN:
        raise HTTPException(403, "Только админ управляет отправителями и перевозчиками")
    return user


def _driver_vehicle(db: Session, user: User) -> Vehicle | None:
    return db.query(Vehicle).filter(Vehicle.driver_id == user.id).one_or_none()


def can_read_order(db: Session, user: User, order: Order) -> bool:
    r = role_of(user)
    if is_staff(user.role):
        return True
    if r == SENDER:
        return order.sender_id == user.id
    if r == CARRIER:
        return order.status == "open" or order.carrier_id == user.id
    if r == DRIVER:
        v = _driver_vehicle(db, user)
        return bool(v and order.vehicle_id == v.id)
    return False


def can_read_vehicle(db: Session, user: User, v: Vehicle) -> bool:
    r = role_of(user)
    if is_staff(user.role):
        return True
    if r == CARRIER:
        return v.owner_id == user.id
    if r == DRIVER:
        return v.driver_id == user.id
    if r == SENDER:
        if not v.current_order_id:
            return False
        order = db.get(Order, v.current_order_id)
        return bool(order and order.sender_id == user.id)
    return False


def visible_settlements_query(db: Session, user: User):
    q = db.query(Settlement)
    r = role_of(user)
    if is_staff(user.role):
        return q
    if r == SENDER:
        return q.filter((Settlement.sender_id.is_(None)) | (Settlement.sender_id == user.id))
    if r == CARRIER:
        order_ids = db.query(Order.origin_id).filter(
            (Order.status == "open") | (Order.carrier_id == user.id)
        )
        dest_ids = db.query(Order.dest_id).filter(
            (Order.status == "open") | (Order.carrier_id == user.id)
        )
        return q.filter(
            (Settlement.sender_id.is_(None))
            | Settlement.id.in_(order_ids)
            | Settlement.id.in_(dest_ids)
        )
    if r == DRIVER:
        v = _driver_vehicle(db, user)
        if not v or not v.current_order_id:
            return q.filter(Settlement.sender_id.is_(None))
        order = db.get(Order, v.current_order_id)
        if not order:
            return q.filter(Settlement.sender_id.is_(None))
        return q.filter(
            (Settlement.sender_id.is_(None))
            | (Settlement.id.in_([order.origin_id, order.dest_id]))
        )
    return q.filter(Settlement.sender_id.is_(None))


def visible_vehicles_query(db: Session, user: User):
    q = db.query(Vehicle)
    r = role_of(user)
    if is_staff(user.role):
        return q
    if r == CARRIER:
        return q.filter(Vehicle.owner_id == user.id)
    if r == DRIVER:
        return q.filter(Vehicle.driver_id == user.id)
    if r == SENDER:
        mine = db.query(Order.id).filter(Order.sender_id == user.id)
        return q.filter(
            (Vehicle.current_order_id.in_(mine))
            | (
                Vehicle.id.in_(
                    db.query(Order.vehicle_id).filter(
                        Order.sender_id == user.id, Order.vehicle_id.isnot(None)
                    )
                )
            )
        )
    return q.filter(Vehicle.id == -1)


def visible_orders_query(db: Session, user: User):
    q = db.query(Order).options(
        joinedload(Order.origin),
        joinedload(Order.dest),
        joinedload(Order.sender),
    )
    r = role_of(user)
    if is_staff(user.role):
        return q
    if r == SENDER:
        return q.filter(Order.sender_id == user.id)
    if r == CARRIER:
        return q.filter((Order.status == "open") | (Order.carrier_id == user.id))
    if r == DRIVER:
        v = _driver_vehicle(db, user)
        if not v:
            return q.filter(Order.id == -1)
        return q.filter(Order.vehicle_id == v.id)
    return q.filter(Order.id == -1)


def get_order_or_404(db: Session, user: User, order_id: int) -> Order:
    order = (
        db.query(Order)
        .options(joinedload(Order.origin), joinedload(Order.dest), joinedload(Order.sender))
        .filter(Order.id == order_id)
        .one_or_none()
    )
    if not order or not can_read_order(db, user, order):
        raise HTTPException(404, "Заявка не найдена")
    return order


def get_owned_order(db: Session, user: User, order_id: int, *, as_sender: bool = False, as_carrier: bool = False) -> Order:
    order = get_order_or_404(db, user, order_id)
    if as_sender and order.sender_id != user.id:
        raise HTTPException(404, "Заявка не найдена")
    if as_carrier and order.carrier_id != user.id:
        raise HTTPException(404, "Заявка не найдена")
    return order


def get_owned_vehicle(db: Session, user: User, vehicle_id: int) -> Vehicle:
    v = db.get(Vehicle, vehicle_id)
    if not v or v.owner_id != user.id:
        raise HTTPException(404, "Борт не найден")
    return v


def get_driver_vehicle(db: Session, user: User, vehicle_id: int | None = None) -> Vehicle:
    v = _driver_vehicle(db, user)
    if vehicle_id is not None:
        cand = db.get(Vehicle, vehicle_id)
        if not cand or cand.driver_id != user.id:
            raise HTTPException(404, "Борт не найден")
        v = cand
    if not v:
        raise HTTPException(404, "Борт не найден")
    return v


def get_owned_point(db: Session, user: User, settlement_id: int) -> Settlement:
    s = db.get(Settlement, settlement_id)
    if not s or s.sender_id != user.id:
        raise HTTPException(404, "Пункт не найден")
    return s


def get_usable_point(db: Session, user: User, settlement_id: int) -> Settlement:
    s = db.get(Settlement, settlement_id)
    if not s:
        raise HTTPException(404, "Пункт не найден")
    if s.sender_id is None:
        return s
    if role_of(user) == SENDER and s.sender_id == user.id:
        return s
    if is_staff(user.role):
        return s
    raise HTTPException(404, "Пункт не найден")


# Sender may cancel until loading actually starts (ARRIVED is already on site).
CANCELLABLE = {"open", "taken", "assigned"}
ACTIVE_TRIP = {"assigned", "arrived", "loading", "transit"}
IN_TRANSIT = "transit"


def release_bort(db: Session, order: Order) -> None:
    from app.services.simulator import clear_plan

    if not order.vehicle_id:
        return
    v = db.get(Vehicle, order.vehicle_id)
    if not v or v.current_order_id != order.id:
        return
    clear_plan(v.id)
    v.current_order_id = None
    v.status = "idle"
    v.live_until = None


def assert_bort_assignable(v: Vehicle, order: Order) -> None:
    if not v.active:
        raise HTTPException(409, "Борт отключён")
    if not v.driver_id:
        raise HTTPException(400, "На борте нет водителя")
    if v.current_order_id and v.current_order_id != order.id:
        raise HTTPException(409, "Борт уже в рейсе")
    if v.capacity_kg < order.weight_kg:
        raise HTTPException(400, "Груз тяжелее грузоподъёмности")


def filter_fleet_event(user: User, event: dict, db: Session) -> dict | None:
    kind = event.get("type")
    if kind == "fleet":
        rows = event.get("vehicles") or []
        kept = []
        for item in rows:
            vid = item.get("id")
            v = db.get(Vehicle, vid) if vid else None
            if v and can_read_vehicle(db, user, v):
                kept.append(item)
        return {**event, "vehicles": kept}
    if kind == "vehicle":
        vid = event.get("id")
        v = db.get(Vehicle, vid) if vid else None
        if v and can_read_vehicle(db, user, v):
            return event
        return None
    if kind in {"order", "order_new"}:
        oid = event.get("id")
        if oid is None:
            return event
        order = db.get(Order, oid)
        if order and can_read_order(db, user, order):
            return event
        return None
    return event

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user, hash_password
from app.database import get_db
from app.models import Order, RouteCache, Settlement, TrackPoint, User, Vehicle
from app.roles import ROLE_LABELS, creatable_roles, is_operator, is_staff, normalize_role
from app.schemas import (
    OrderAssignIn,
    SettlementCreate,
    SettlementUpdate,
    UserCreate,
    UserOut,
    UserUpdate,
    VehicleCreate,
    VehicleOut,
    VehicleUpdate,
)
from app.services.events import bus
from app.services.simulator import assign_route, clear_plan, publish_vehicles

router = APIRouter(prefix="/api/admin", tags=["admin"])


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if not is_staff(user.role):
        raise HTTPException(403, "Доступно только администратору")
    return user


AdminDep = Annotated[User, Depends(require_admin)]
DbDep = Annotated[Session, Depends(get_db)]


def require_operator(user: Annotated[User, Depends(get_current_user)]) -> User:
    if not is_operator(user.role):
        raise HTTPException(403, "Супер-админ не вносит правки — только дашборд и создание админов")
    return user


OperatorDep = Annotated[User, Depends(require_operator)]


def _assert_can_assign_role(actor: User, role: str) -> None:
    allowed = creatable_roles(actor.role)
    if role not in allowed:
        raise HTTPException(
            403,
            "Админ не может создавать админов" if normalize_role(actor.role) == "admin" and role in {"admin", "superadmin", "dispatcher"}
            else f"Нельзя назначить роль «{ROLE_LABELS.get(role, role)}»",
        )


# ---------- users ----------

@router.get("/role-options")
def role_options(actor: AdminDep):
    ids = creatable_roles(actor.role)
    return [{"id": r, "label": ROLE_LABELS[r]} for r in ids]


@router.get("/users", response_model=list[UserOut])
def list_users(db: DbDep, actor: AdminDep):
    q = db.query(User).order_by(User.role, User.name)
    if normalize_role(actor.role) == "admin":
        q = q.filter(User.role.notin_(["superadmin"]))
    return q.all()


@router.post("/users", response_model=UserOut)
def create_user(body: UserCreate, db: DbDep, actor: AdminDep):
    _assert_can_assign_role(actor, body.role)
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(409, "Email уже занят")
    user = User(
        email=body.email,
        name=body.name,
        role=body.role,
        company=body.company,
        phone=body.phone,
        password_hash=hash_password(body.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, db: DbDep, actor: OperatorDep):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    if normalize_role(actor.role) == "admin" and user.role in {"superadmin", "admin"}:
        raise HTTPException(403, "Админ не может менять учётные записи админов")
    if body.role is not None:
        _assert_can_assign_role(actor, body.role)
    for field in ("name", "company", "phone", "role"):
        value = getattr(body, field)
        if value is not None:
            setattr(user, field, value)
    db.commit()
    db.refresh(user)
    return user


# ---------- vehicles ----------

def _vehicle_out(v: Vehicle) -> VehicleOut:
    item = VehicleOut.model_validate(v)
    item.live = bool(v.live_until and v.live_until > datetime.utcnow())
    return item


@router.post("/vehicles", response_model=VehicleOut)
def create_vehicle(body: VehicleCreate, db: DbDep, _: OperatorDep):
    if db.query(Vehicle).filter(Vehicle.plate == body.plate).first():
        raise HTTPException(409, "Госномер уже есть в парке")
    owner = db.get(User, body.owner_id)
    if not owner or owner.role != "carrier":
        raise HTTPException(400, "Владелец должен быть перевозчиком")
    home = db.get(Settlement, body.home_id)
    if not home:
        raise HTTPException(404, "База (пункт) не найдена")
    v = Vehicle(
        plate=body.plate,
        kind=body.kind,
        capacity_kg=body.capacity_kg,
        owner_id=owner.id,
        driver_name=body.driver_name,
        home_id=home.id,
        status="idle",
        lat=home.lat,
        lon=home.lon,
        heading=90,
    )
    db.add(v)
    db.commit()
    db.refresh(v)
    publish_vehicles(db)
    return _vehicle_out(v)


@router.patch("/vehicles/{vehicle_id}", response_model=VehicleOut)
def update_vehicle(vehicle_id: int, body: VehicleUpdate, db: DbDep, _: OperatorDep):
    v = db.get(Vehicle, vehicle_id)
    if not v:
        raise HTTPException(404, "Машина не найдена")
    if body.owner_id is not None:
        owner = db.get(User, body.owner_id)
        if not owner or owner.role != "carrier":
            raise HTTPException(400, "Владелец должен быть перевозчиком")
    if body.home_id is not None and not db.get(Settlement, body.home_id):
        raise HTTPException(404, "Пункт не найден")
    for field in ("plate", "kind", "capacity_kg", "owner_id", "driver_name", "home_id", "status"):
        value = getattr(body, field)
        if value is not None:
            setattr(v, field, value)
    db.commit()
    db.refresh(v)
    publish_vehicles(db)
    return _vehicle_out(v)


@router.delete("/vehicles/{vehicle_id}")
def delete_vehicle(vehicle_id: int, db: DbDep, _: OperatorDep):
    v = db.get(Vehicle, vehicle_id)
    if not v:
        raise HTTPException(404, "Машина не найдена")
    if v.current_order_id:
        raise HTTPException(409, "Машина в рейсе — сначала завершите или отмените заявку")
    db.query(TrackPoint).filter(TrackPoint.vehicle_id == v.id).delete()
    db.query(Order).filter(Order.vehicle_id == v.id).update({Order.vehicle_id: None})
    clear_plan(v.id)
    db.delete(v)
    db.commit()
    publish_vehicles(db)
    return {"ok": True}


# ---------- settlements ----------

@router.post("/settlements")
def create_settlement(body: SettlementCreate, db: DbDep, _: OperatorDep):
    if db.query(Settlement).filter(Settlement.name == body.name).first():
        raise HTTPException(409, "Пункт с таким названием уже есть")
    s = Settlement(**body.model_dump())
    db.add(s)
    db.commit()
    db.refresh(s)
    return {"id": s.id, "name": s.name}


@router.patch("/settlements/{settlement_id}")
def update_settlement(settlement_id: int, body: SettlementUpdate, db: DbDep, _: OperatorDep):
    s = db.get(Settlement, settlement_id)
    if not s:
        raise HTTPException(404, "Пункт не найден")
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
    return {"ok": True}


@router.delete("/settlements/{settlement_id}")
def delete_settlement(settlement_id: int, db: DbDep, _: OperatorDep):
    s = db.get(Settlement, settlement_id)
    if not s:
        raise HTTPException(404, "Пункт не найден")
    used_orders = db.query(Order).filter(
        (Order.origin_id == s.id) | (Order.dest_id == s.id)
    ).count()
    used_vehicles = db.query(Vehicle).filter(Vehicle.home_id == s.id).count()
    if used_orders or used_vehicles:
        raise HTTPException(409, "Пункт используется в заявках или как база машин")
    db.query(RouteCache).filter(
        (RouteCache.origin_id == s.id) | (RouteCache.dest_id == s.id)
    ).delete()
    db.delete(s)
    db.commit()
    return {"ok": True}


# ---------- orders control ----------

def _free_vehicle(db: Session, order: Order) -> None:
    if order.vehicle_id:
        v = db.get(Vehicle, order.vehicle_id)
        if v and v.current_order_id == order.id:
            v.current_order_id = None
            v.status = "idle"
            clear_plan(v.id)


@router.post("/orders/{order_id}/assign")
def assign_order(order_id: int, body: OrderAssignIn, db: DbDep, _: OperatorDep):
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(404, "Заявка не найдена")
    if order.status not in {"open", "taken"}:
        raise HTTPException(409, f"Нельзя назначить машину на заявку в статусе {order.status}")
    v = db.get(Vehicle, body.vehicle_id)
    if not v:
        raise HTTPException(404, "Машина не найдена")
    if v.current_order_id:
        raise HTTPException(409, "Машина уже в рейсе")
    if v.capacity_kg < order.weight_kg:
        raise HTTPException(400, "Груз тяжелее грузоподъёмности")
    order.status = "transit"
    order.carrier_id = v.owner_id
    order.vehicle_id = v.id
    order.taken_at = datetime.utcnow()
    v.current_order_id = order.id
    v.status = "enroute"
    assign_route(db, v, order.origin_id, order.dest_id)
    db.commit()
    bus.publish({"type": "order", "id": order.id, "status": "transit"})
    publish_vehicles(db)
    return {"ok": True, "status": order.status, "plate": v.plate}


@router.post("/orders/{order_id}/cancel")
def cancel_order(order_id: int, db: DbDep, _: OperatorDep):
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(404, "Заявка не найдена")
    if order.status in {"delivered", "cancelled"}:
        raise HTTPException(409, f"Заявка уже в статусе {order.status}")
    _free_vehicle(db, order)
    order.status = "cancelled"
    db.commit()
    bus.publish({"type": "order", "id": order.id, "status": "cancelled"})
    publish_vehicles(db)
    return {"ok": True}


@router.post("/orders/{order_id}/deliver")
def deliver_order(order_id: int, db: DbDep, _: OperatorDep):
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(404, "Заявка не найдена")
    if order.status not in {"taken", "pickup", "transit"}:
        raise HTTPException(409, "Заявка не в пути")
    _free_vehicle(db, order)
    order.status = "delivered"
    order.delivered_at = datetime.utcnow()
    db.commit()
    bus.publish({"type": "order", "id": order.id, "status": "delivered"})
    publish_vehicles(db)
    return {"ok": True}


@router.post("/orders/{order_id}/reopen")
def reopen_order(order_id: int, db: DbDep, _: OperatorDep):
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(404, "Заявка не найдена")
    if order.status not in {"cancelled", "taken", "transit"}:
        raise HTTPException(409, "Вернуть на биржу можно отменённую или взятую заявку")
    _free_vehicle(db, order)
    order.status = "open"
    order.carrier_id = None
    order.vehicle_id = None
    order.taken_at = None
    db.commit()
    bus.publish({"type": "order", "id": order.id, "status": "open"})
    publish_vehicles(db)
    return {"ok": True}

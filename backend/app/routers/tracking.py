import json
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.access import can_read_vehicle, filter_fleet_event, get_driver_vehicle, require_roles
from app.auth import get_current_user, user_id_from_token
from app.database import SessionLocal, get_db
from app.models import Order, TrackPoint, User, Vehicle
from app.roles import DRIVER
from app.schemas import TrackPingIn, VehicleIdIn
from app.services.events import bus
from app.services.simulator import clear_plan, mark_live, publish_vehicles, start_navigation

router = APIRouter(prefix="/api/tracking", tags=["tracking"])

DbDep = Annotated[Session, Depends(get_db)]
DriverDep = Annotated[User, Depends(require_roles(DRIVER))]
UserDep = Annotated[User, Depends(get_current_user)]


def _user_from_token(db: Session, authorization: str | None, token: str | None) -> User:
    raw = token
    if not raw and authorization and authorization.lower().startswith("bearer "):
        raw = authorization.split(" ", 1)[1].strip()
    if not raw:
        raise HTTPException(401, "Нужна авторизация")
    user_id = user_id_from_token(raw)
    if not user_id:
        raise HTTPException(401, "Сессия истекла")
    user = db.get(User, user_id)
    if not user or not getattr(user, "is_active", True):
        raise HTTPException(401, "Пользователь не найден")
    return user


@router.get("/stream")
async def stream(
    token: str | None = Query(default=None),
    authorization: Annotated[str | None, Header()] = None,
):
    db = SessionLocal()
    try:
        user = _user_from_token(db, authorization, token)
        user_id = user.id
    finally:
        db.close()

    async def gen():
        q = bus.subscribe()
        try:
            yield f"data: {json.dumps({'type': 'hello'})}\n\n"
            while True:
                event = await q.get()
                session = SessionLocal()
                try:
                    actor = session.get(User, user_id)
                    if not actor:
                        continue
                    filtered = filter_fleet_event(actor, event, session)
                finally:
                    session.close()
                if filtered is None:
                    continue
                yield f"data: {json.dumps(filtered, default=str)}\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _trip_order(db: Session, user: User, vehicle_id: int) -> tuple[Vehicle, Order]:
    v = get_driver_vehicle(db, user, vehicle_id)
    if not v.current_order_id:
        raise HTTPException(409, "Нет назначенного рейса")
    order = db.get(Order, v.current_order_id)
    if not order:
        raise HTTPException(409, "Нет назначенного рейса")
    return v, order


def _advance(db: Session, order: Order, expected: str, nxt: str, vehicle: Vehicle | None = None, vehicle_status: str | None = None) -> Order:
    if order.status != expected:
        raise HTTPException(409, "Нельзя пропустить этап рейса")
    order.status = nxt
    if vehicle is not None and vehicle_status:
        vehicle.status = vehicle_status
    db.commit()
    bus.publish({"type": "order", "id": order.id, "status": nxt})
    publish_vehicles(db)
    return order


@router.post("/arrive")
def arrive(body: VehicleIdIn, db: DbDep, user: DriverDep):
    v, order = _trip_order(db, user, body.vehicle_id)
    _advance(db, order, "assigned", "arrived", v, "assigned")
    return {"ok": True, "status": "arrived"}


@router.post("/start-loading")
def start_loading(body: VehicleIdIn, db: DbDep, user: DriverDep):
    v, order = _trip_order(db, user, body.vehicle_id)
    _advance(db, order, "arrived", "loading", v, "loading")
    return {"ok": True, "status": "loading"}


@router.post("/start-route")
async def start_route(body: VehicleIdIn, db: DbDep, user: DriverDep):
    v, order = _trip_order(db, user, body.vehicle_id)
    if order.status != "loading":
        raise HTTPException(409, "Сначала зафиксируйте погрузку")
    if not await start_navigation(db, v):
        raise HTTPException(409, "Не удалось построить маршрут")
    db.refresh(v)
    return {"ok": True, "lat": v.lat, "lon": v.lon, "order_id": v.current_order_id, "status": "transit"}


@router.post("/complete-route")
def complete_route(body: VehicleIdIn, db: DbDep, user: DriverDep):
    v, order = _trip_order(db, user, body.vehicle_id)
    if order.status != "transit":
        raise HTTPException(409, "Завершить можно только рейс в пути")
    clear_plan(v.id)
    v.live_until = None
    v.status = "idle"
    v.current_order_id = None
    order.status = "delivered"
    order.delivered_at = datetime.utcnow()
    db.commit()
    bus.publish({"type": "order", "id": order.id, "status": "delivered"})
    publish_vehicles(db)
    return {"ok": True}


@router.post("/stop-route")
def stop_route(body: VehicleIdIn, db: DbDep, user: DriverDep):
    v, order = _trip_order(db, user, body.vehicle_id)
    if order.status != "transit":
        raise HTTPException(409, "Остановить можно только движение в пути")
    clear_plan(v.id)
    v.live_until = None
    v.status = "enroute"
    db.commit()
    publish_vehicles(db)
    return {"ok": True}


@router.post("/ping")
def ping(body: TrackPingIn, db: DbDep, user: DriverDep):
    v = get_driver_vehicle(db, user, body.vehicle_id)
    mark_live(v, body.lat, body.lon)
    db.add(TrackPoint(vehicle_id=v.id, lat=body.lat, lon=body.lon, source="live", ts=datetime.utcnow()))
    db.commit()
    publish_vehicles(db)
    return {"ok": True, "lat": v.lat, "lon": v.lon}


@router.get("/{vehicle_id}/trail")
def trail(vehicle_id: int, db: DbDep, user: UserDep, limit: int = 80):
    v = db.get(Vehicle, vehicle_id)
    if not v or not can_read_vehicle(db, user, v):
        raise HTTPException(404, "Борт не найден")
    rows = (
        db.query(TrackPoint)
        .filter(TrackPoint.vehicle_id == vehicle_id)
        .order_by(TrackPoint.id.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()
    return [{"lat": r.lat, "lon": r.lon, "ts": r.ts.isoformat(), "source": r.source} for r in rows]

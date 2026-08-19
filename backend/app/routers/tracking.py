import json
from datetime import datetime
from types import SimpleNamespace
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.access import (
    _driver_vehicle,
    can_read_vehicle,
    event_visible,
    get_driver_vehicle,
    require_roles,
    sse_channels,
    visible_vehicles_query,
)
from app.auth import get_current_user, user_id_from_token
from app.database import SessionLocal, get_db
from app.models import Order, TrackPoint, User, Vehicle
from app.roles import DRIVER
from app.schemas import TrackPingIn, VehicleIdIn
from app.services.events import iter_channel_events, publish_order_event
from app.services.live import persist_track
from app.services.simulator import (
    clear_plan,
    fleet_snapshot,
    mark_live,
    publish_vehicle,
    start_navigation,
)

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
        actor = SimpleNamespace(id=user.id, role=user.role)
        channels = sse_channels(db, user)
        board = _driver_vehicle(db, user)
        driver_vid = board.id if board else None
        snapshot = fleet_snapshot(db, visible_vehicles_query(db, user).all())
    finally:
        db.close()

    async def gen():
        from app.services.metrics import sse_close, sse_open

        sse_open()
        try:
            yield f"data: {json.dumps({'type': 'hello'})}\n\n"
            yield f"data: {json.dumps(snapshot, default=str)}\n\n"
            async for event in iter_channel_events(channels):
                if not event_visible(actor, event, vehicle_id=driver_vid):
                    continue
                yield f"data: {json.dumps(event, default=str)}\n\n"
        finally:
            sse_close()

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
    publish_order_event(order, status=nxt)
    if vehicle is not None:
        publish_vehicle(db, vehicle)
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
    persist_track(db, v, "live", force=True)
    v.live_until = None
    v.status = "idle"
    v.current_order_id = None
    order.status = "delivered"
    order.delivered_at = datetime.utcnow()
    db.commit()
    publish_order_event(order, status="delivered")
    publish_vehicle(db, v)
    return {"ok": True}


@router.post("/stop-route")
def stop_route(body: VehicleIdIn, db: DbDep, user: DriverDep):
    v, order = _trip_order(db, user, body.vehicle_id)
    if order.status != "transit":
        raise HTTPException(409, "Остановить можно только движение в пути")
    clear_plan(v.id)
    persist_track(db, v, "nav", force=True)
    v.live_until = None
    v.status = "enroute"
    db.commit()
    publish_vehicle(db, v)
    return {"ok": True}


@router.post("/ping")
def ping(body: TrackPingIn, db: DbDep, user: DriverDep):
    from app.services.live import acquire_ping_slot

    v = get_driver_vehicle(db, user, body.vehicle_id)
    mark_live(v, body.lat, body.lon)
    if not acquire_ping_slot(v.id):
        db.commit()
        raise HTTPException(429, "Слишком часто")
    persist_track(db, v, "live")
    db.commit()
    publish_vehicle(db, v)
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

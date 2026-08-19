from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import Order, Settlement, Vehicle
from app.services.events import bus, publish_order_event
from app.services.geo import advance_along
from app.services.live import (
    apply_live,
    clear_nav,
    get_nav_plan,
    get_nav_progress,
    is_live,
    nav_stopped,
    persist_track,
    set_nav_plan,
    set_nav_progress,
    set_position,
    stop_nav,
)
from app.services.osrm import ensure_route, get_cached_route, route_coords
from app.services.redisutil import redis_enabled

_tasks: dict[int, asyncio.Task] = {}


def vehicle_payload(db: Session, v: Vehicle) -> dict:
    apply_live(v)
    sender_id = None
    if v.current_order_id:
        order = db.get(Order, v.current_order_id)
        if order:
            sender_id = order.sender_id
    return {
        "type": "vehicle",
        "id": v.id,
        "plate": v.plate,
        "kind": v.kind,
        "status": v.status,
        "lat": v.lat,
        "lon": v.lon,
        "heading": v.heading,
        "current_order_id": v.current_order_id,
        "driver_name": v.driver_name,
        "driver_id": v.driver_id,
        "owner_id": v.owner_id,
        "sender_id": sender_id,
        "live": is_live(v.id, v.live_until),
        "active": v.active,
    }


def fleet_snapshot(db: Session, vehicles: list[Vehicle]) -> dict:
    return {"type": "fleet", "vehicles": [vehicle_payload(db, v) for v in vehicles]}


def publish_vehicle(db: Session, vehicle: Vehicle) -> None:
    bus.publish(vehicle_payload(db, vehicle))


def publish_vehicles(db: Session) -> None:
    """Compatibility: emit one vehicle event per board (no full-fleet broadcast)."""
    for v in db.query(Vehicle).all():
        publish_vehicle(db, v)


def clear_plan(vehicle_id: int) -> None:
    stop_nav(vehicle_id)
    task = _tasks.pop(vehicle_id, None)
    if task and not task.done():
        task.cancel()


def assign_route(db: Session, vehicle: Vehicle, origin_id: int, dest_id: int) -> None:
    cached = get_cached_route(db, origin_id, dest_id)
    if not cached:
        return
    set_nav_plan(vehicle.id, route_coords(cached), 0.0)


def mark_live(vehicle: Vehicle, lat: float, lon: float) -> None:
    vehicle.lat = lat
    vehicle.lon = lon
    vehicle.live_until = datetime.utcnow() + timedelta(seconds=45)
    set_position(vehicle.id, lat, lon, vehicle.heading, live=True)


async def prepare_plan(db: Session, vehicle: Vehicle) -> bool:
    if not vehicle.current_order_id:
        return False
    order = db.get(Order, vehicle.current_order_id)
    if not order or order.status not in {"loading", "pickup", "transit"}:
        return False
    origin = db.get(Settlement, order.origin_id)
    dest = db.get(Settlement, order.dest_id)
    if not origin or not dest:
        return False
    cached = await ensure_route(db, origin, dest)
    coords = route_coords(cached)
    if len(coords) < 2:
        return False
    set_nav_plan(vehicle.id, coords, 0.0)
    lon, lat = coords[0]
    vehicle.lat, vehicle.lon = lat, lon
    set_position(vehicle.id, lat, lon, vehicle.heading, live=False)
    vehicle.status = "enroute"
    if order.status in {"loading", "pickup", "transit"}:
        order.status = "transit"
    return True


def _spawn(vehicle_id: int) -> None:
    old = _tasks.get(vehicle_id)
    if old and not old.done():
        return
    _tasks[vehicle_id] = asyncio.create_task(run_follow_loop(vehicle_id))


async def _enqueue_follow(vehicle_id: int) -> None:
    from arq import create_pool
    from arq.connections import RedisSettings

    from app.config import settings

    pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    try:
        await pool.enqueue_job("follow_vehicle", vehicle_id, _job_id=f"follow:{vehicle_id}")
    finally:
        await pool.close(close_connection_pool=True)


async def start_navigation(db: Session, vehicle: Vehicle) -> bool:
    ok = await prepare_plan(db, vehicle)
    if not ok:
        return False
    db.commit()
    publish_vehicle(db, vehicle)
    if vehicle.current_order_id:
        order = db.get(Order, vehicle.current_order_id)
        if order:
            publish_order_event(order, status="transit")
    if redis_enabled():
        await _enqueue_follow(vehicle.id)
    else:
        _spawn(vehicle.id)
    return True


async def run_follow_loop(vehicle_id: int) -> None:
    step_km = settings.sim_speed_kmh * (settings.sim_tick_s / 3600.0)
    try:
        while True:
            await asyncio.sleep(settings.sim_tick_s)
            if nav_stopped(vehicle_id):
                break
            db: Session = SessionLocal()
            try:
                v = db.get(Vehicle, vehicle_id)
                if not v or not v.current_order_id:
                    break
                now = datetime.utcnow()
                if is_live(v.id, v.live_until):
                    continue
                coords = get_nav_plan(vehicle_id)
                if not coords:
                    break
                travelled = get_nav_progress(vehicle_id) + step_km
                lat, lon, heading, done = advance_along(coords, travelled)
                v.lat, v.lon, v.heading = lat, lon, heading
                v.status = "enroute"
                set_nav_progress(vehicle_id, travelled)
                set_position(v.id, lat, lon, heading, live=False)
                persist_track(db, v, "nav", force=done)
                if done:
                    order = db.get(Order, v.current_order_id)
                    if order and order.status in {"taken", "pickup", "assigned", "transit"}:
                        order.status = "delivered"
                        order.delivered_at = now
                        publish_order_event(order, status="delivered")
                    v.current_order_id = None
                    v.status = "idle"
                    clear_nav(vehicle_id)
                    db.commit()
                    publish_vehicle(db, v)
                    break
                db.commit()
                publish_vehicle(db, v)
            except Exception:
                db.rollback()
                break
            finally:
                db.close()
    except asyncio.CancelledError:
        pass
    finally:
        _tasks.pop(vehicle_id, None)

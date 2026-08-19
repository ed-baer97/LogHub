from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import Order, TrackPoint, Vehicle
from app.services.events import bus
from app.services.geo import advance_along, haversine_km
from app.services.osrm import get_cached_route, route_coords

_task: asyncio.Task | None = None
_progress: dict[int, float] = {}  # vehicle_id -> km travelled on current polyline
_plan: dict[int, list[list[float]]] = {}


def _vehicle_payload(v: Vehicle) -> dict:
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
        "live": bool(v.live_until and v.live_until > datetime.utcnow()),
    }


def publish_vehicles(db: Session) -> None:
    vehicles = db.query(Vehicle).all()
    bus.publish({"type": "fleet", "vehicles": [_vehicle_payload(v) for v in vehicles]})


def clear_plan(vehicle_id: int) -> None:
    _plan.pop(vehicle_id, None)
    _progress.pop(vehicle_id, None)


def assign_route(db: Session, vehicle: Vehicle, origin_id: int, dest_id: int) -> None:
    cached = get_cached_route(db, origin_id, dest_id)
    if not cached:
        return
    _plan[vehicle.id] = route_coords(cached)
    _progress[vehicle.id] = 0.0
    vehicle.status = "enroute"


def _pick_idle_target(db: Session, vehicle: Vehicle) -> None:
    from app.models import Settlement
    import random

    settlements = db.query(Settlement).all()
    if not settlements:
        return
    dest = random.choice(settlements)
    origin = min(settlements, key=lambda s: haversine_km(vehicle.lat, vehicle.lon, s.lat, s.lon))
    if origin.id == dest.id:
        return
    cached = get_cached_route(db, origin.id, dest.id) or get_cached_route(db, dest.id, origin.id)
    if not cached:
        return
    coords = route_coords(cached)
    if cached.origin_id != origin.id:
        coords = list(reversed(coords))
    _plan[vehicle.id] = coords
    _progress[vehicle.id] = 0.0
    vehicle.status = "idle"


def tick(db: Session) -> None:
    now = datetime.utcnow()
    step_km = settings.sim_speed_kmh * (settings.sim_tick_s / 3600.0)
    changed = False
    for v in db.query(Vehicle).all():
        if v.live_until and v.live_until > now:
            continue
        coords = _plan.get(v.id)
        if not coords:
            if v.current_order_id:
                order = db.get(Order, v.current_order_id)
                if order:
                    assign_route(db, v, order.origin_id, order.dest_id)
                    coords = _plan.get(v.id)
            if not coords:
                _pick_idle_target(db, v)
                coords = _plan.get(v.id)
            if not coords:
                continue
        travelled = _progress.get(v.id, 0.0) + step_km
        lat, lon, heading, done = advance_along(coords, travelled)
        v.lat, v.lon, v.heading = lat, lon, heading
        _progress[v.id] = travelled
        db.add(
            TrackPoint(vehicle_id=v.id, lat=lat, lon=lon, source="sim", ts=now)
        )
        changed = True
        if done:
            order = db.get(Order, v.current_order_id) if v.current_order_id else None
            if order and order.status in {"taken", "pickup", "transit"}:
                order.status = "delivered"
                order.delivered_at = now
                v.current_order_id = None
                v.status = "idle"
                bus.publish({"type": "order", "id": order.id, "status": "delivered"})
            _plan.pop(v.id, None)
            _progress.pop(v.id, None)
    if changed:
        db.commit()
        publish_vehicles(db)


async def simulator_loop() -> None:
    # give seed a moment
    await asyncio.sleep(2)
    while True:
        db: Session = SessionLocal()
        try:
            tick(db)
        except Exception:
            db.rollback()
        finally:
            db.close()
        await asyncio.sleep(settings.sim_tick_s)


def start_simulator() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(simulator_loop())


def mark_live(vehicle: Vehicle, lat: float, lon: float) -> None:
    vehicle.lat = lat
    vehicle.lon = lon
    vehicle.live_until = datetime.utcnow() + timedelta(seconds=45)
    vehicle.status = "enroute"
    bus.publish(_vehicle_payload(vehicle) | {"type": "vehicle"})

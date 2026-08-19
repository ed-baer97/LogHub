from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import Order, Settlement, TrackPoint, Vehicle
from app.services.events import bus
from app.services.geo import advance_along
from app.services.osrm import ensure_route, get_cached_route, route_coords

_progress: dict[int, float] = {}
_plan: dict[int, list[list[float]]] = {}
_tasks: dict[int, asyncio.Task] = {}


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
        "driver_id": v.driver_id,
        "live": bool(v.live_until and v.live_until > datetime.utcnow()),
    }


def publish_vehicles(db: Session) -> None:
    vehicles = db.query(Vehicle).all()
    bus.publish({"type": "fleet", "vehicles": [_vehicle_payload(v) for v in vehicles]})


def clear_plan(vehicle_id: int) -> None:
    _plan.pop(vehicle_id, None)
    _progress.pop(vehicle_id, None)
    task = _tasks.pop(vehicle_id, None)
    if task and not task.done():
        task.cancel()


def assign_route(db: Session, vehicle: Vehicle, origin_id: int, dest_id: int) -> None:
    """Load polyline into memory. Does not start movement."""
    cached = get_cached_route(db, origin_id, dest_id)
    if not cached:
        return
    _plan[vehicle.id] = route_coords(cached)
    _progress[vehicle.id] = 0.0


def mark_live(vehicle: Vehicle, lat: float, lon: float) -> None:
    vehicle.lat = lat
    vehicle.lon = lon
    vehicle.live_until = datetime.utcnow() + timedelta(seconds=45)
    bus.publish(_vehicle_payload(vehicle) | {"type": "vehicle"})


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
    _plan[vehicle.id] = coords
    _progress[vehicle.id] = 0.0
    lon, lat = coords[0]
    vehicle.lat, vehicle.lon = lat, lon
    vehicle.status = "enroute"
    if order.status in {"loading", "pickup", "transit"}:
        order.status = "transit"
    return True

def _spawn(vehicle_id: int) -> None:
    old = _tasks.get(vehicle_id)
    if old and not old.done():
        return
    _tasks[vehicle_id] = asyncio.create_task(_follow_loop(vehicle_id))


async def start_navigation(db: Session, vehicle: Vehicle) -> bool:
    ok = await prepare_plan(db, vehicle)
    if not ok:
        return False
    db.commit()
    publish_vehicles(db)
    bus.publish({"type": "order", "id": vehicle.current_order_id, "status": "transit"})
    _spawn(vehicle.id)
    return True


async def _follow_loop(vehicle_id: int) -> None:
    step_km = settings.sim_speed_kmh * (settings.sim_tick_s / 3600.0)
    try:
        while True:
            await asyncio.sleep(settings.sim_tick_s)
            db: Session = SessionLocal()
            try:
                v = db.get(Vehicle, vehicle_id)
                if not v or not v.current_order_id:
                    break
                now = datetime.utcnow()
                if v.live_until and v.live_until > now:
                    continue
                coords = _plan.get(vehicle_id)
                if not coords:
                    break
                travelled = _progress.get(vehicle_id, 0.0) + step_km
                lat, lon, heading, done = advance_along(coords, travelled)
                v.lat, v.lon, v.heading = lat, lon, heading
                v.status = "enroute"
                _progress[vehicle_id] = travelled
                db.add(TrackPoint(vehicle_id=v.id, lat=lat, lon=lon, source="nav", ts=now))
                if done:
                    order = db.get(Order, v.current_order_id)
                    if order and order.status in {"taken", "pickup", "assigned", "transit"}:
                        order.status = "delivered"
                        order.delivered_at = now
                        bus.publish({"type": "order", "id": order.id, "status": "delivered"})
                    v.current_order_id = None
                    v.status = "idle"
                    _plan.pop(vehicle_id, None)
                    _progress.pop(vehicle_id, None)
                    db.commit()
                    publish_vehicles(db)
                    break
                db.commit()
                publish_vehicles(db)
            except Exception:
                db.rollback()
                break
            finally:
                db.close()
    except asyncio.CancelledError:
        pass
    finally:
        _tasks.pop(vehicle_id, None)

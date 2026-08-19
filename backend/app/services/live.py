from __future__ import annotations

import json
import time
from datetime import datetime

from sqlalchemy.orm import Session

from app.config import settings
from app.models import TrackPoint, Vehicle
from app.services.redisutil import redis_enabled, sync_redis

_mem_pos: dict[int, dict] = {}
_mem_ping: dict[int, float] = {}
_mem_flush: dict[int, float] = {}
_mem_plan: dict[int, list[list[float]]] = {}
_mem_progress: dict[int, float] = {}
_mem_stop: set[int] = set()


def pos_key(vid: int) -> str:
    return f"vehicle:pos:{vid}"


def set_position(vehicle_id: int, lat: float, lon: float, heading: float | None = None, live: bool = False) -> None:
    payload = {
        "lat": lat,
        "lon": lon,
        "heading": heading if heading is not None else 0,
        "ts": datetime.utcnow().isoformat(),
        "live": live,
    }
    r = sync_redis()
    if r is not None:
        r.hset(pos_key(vehicle_id), mapping={k: str(v) for k, v in payload.items()})
        r.expire(pos_key(vehicle_id), int(settings.live_ttl_s))
        return
    _mem_pos[vehicle_id] = payload


def get_position(vehicle_id: int) -> dict | None:
    r = sync_redis()
    if r is not None:
        raw = r.hgetall(pos_key(vehicle_id))
        if not raw:
            return None
        return {
            "lat": float(raw["lat"]),
            "lon": float(raw["lon"]),
            "heading": float(raw.get("heading") or 0),
            "ts": raw.get("ts"),
            "live": raw.get("live") in {"True", "true", "1"},
        }
    return _mem_pos.get(vehicle_id)


def apply_live(v: Vehicle) -> None:
    pos = get_position(v.id)
    if not pos:
        return
    v.lat = pos["lat"]
    v.lon = pos["lon"]
    v.heading = pos["heading"]
    if pos.get("live"):
        v.live_until = datetime.utcnow()


def is_live(vehicle_id: int, live_until: datetime | None) -> bool:
    pos = get_position(vehicle_id)
    if pos and pos.get("live"):
        return True
    return bool(live_until and live_until > datetime.utcnow())


def acquire_ping_slot(vehicle_id: int) -> bool:
    interval = settings.ping_min_interval_s
    r = sync_redis()
    if r is not None:
        return bool(r.set(f"vehicle:ping:{vehicle_id}", "1", nx=True, ex=max(1, int(interval))))
    now = time.monotonic()
    last = _mem_ping.get(vehicle_id, 0.0)
    if now - last < interval:
        return False
    _mem_ping[vehicle_id] = now
    return True


def should_flush(vehicle_id: int) -> bool:
    interval = settings.track_flush_s
    r = sync_redis()
    if r is not None:
        return bool(r.set(f"vehicle:flush:{vehicle_id}", "1", nx=True, ex=max(1, int(interval))))
    now = time.monotonic()
    last = _mem_flush.get(vehicle_id, 0.0)
    if now - last < interval:
        return False
    _mem_flush[vehicle_id] = now
    return True


def persist_track(db: Session, vehicle: Vehicle, source: str, *, force: bool = False) -> None:
    if not force and not should_flush(vehicle.id):
        return
    pos = get_position(vehicle.id)
    lat = pos["lat"] if pos else vehicle.lat
    lon = pos["lon"] if pos else vehicle.lon
    heading = pos["heading"] if pos else vehicle.heading
    vehicle.lat, vehicle.lon, vehicle.heading = lat, lon, heading
    db.add(TrackPoint(vehicle_id=vehicle.id, lat=lat, lon=lon, source=source, ts=datetime.utcnow()))


def set_nav_plan(vehicle_id: int, coords: list[list[float]], progress: float = 0.0) -> None:
    r = sync_redis()
    if r is not None:
        r.set(f"nav:plan:{vehicle_id}", json.dumps(coords))
        r.set(f"nav:progress:{vehicle_id}", str(progress))
        r.delete(f"nav:stop:{vehicle_id}")
        return
    _mem_plan[vehicle_id] = coords
    _mem_progress[vehicle_id] = progress
    _mem_stop.discard(vehicle_id)


def get_nav_plan(vehicle_id: int) -> list[list[float]] | None:
    r = sync_redis()
    if r is not None:
        raw = r.get(f"nav:plan:{vehicle_id}")
        return json.loads(raw) if raw else None
    return _mem_plan.get(vehicle_id)


def get_nav_progress(vehicle_id: int) -> float:
    r = sync_redis()
    if r is not None:
        raw = r.get(f"nav:progress:{vehicle_id}")
        return float(raw) if raw is not None else 0.0
    return _mem_progress.get(vehicle_id, 0.0)


def set_nav_progress(vehicle_id: int, travelled: float) -> None:
    r = sync_redis()
    if r is not None:
        r.set(f"nav:progress:{vehicle_id}", str(travelled))
        return
    _mem_progress[vehicle_id] = travelled


def nav_stopped(vehicle_id: int) -> bool:
    r = sync_redis()
    if r is not None:
        return bool(r.get(f"nav:stop:{vehicle_id}"))
    return vehicle_id in _mem_stop


def stop_nav(vehicle_id: int) -> None:
    r = sync_redis()
    if r is not None:
        r.set(f"nav:stop:{vehicle_id}", "1", ex=86400)
        r.delete(f"nav:plan:{vehicle_id}", f"nav:progress:{vehicle_id}")
        return
    _mem_stop.add(vehicle_id)
    _mem_plan.pop(vehicle_id, None)
    _mem_progress.pop(vehicle_id, None)


def clear_nav(vehicle_id: int) -> None:
    stop_nav(vehicle_id)
    r = sync_redis()
    if r is not None:
        r.delete(f"nav:stop:{vehicle_id}")
    else:
        _mem_stop.discard(vehicle_id)

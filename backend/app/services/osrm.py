from __future__ import annotations

import asyncio
from typing import Any

import httpx
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models import RouteCache, Settlement
from app.services.geo import dump_coords, haversine_km, interpolate_line, load_coords, looks_like_road


def _osrm_bases() -> list[str]:
    bases: list[str] = []
    for raw in (settings.osrm_url, settings.osrm_fallback_url):
        url = (raw or "").strip().rstrip("/")
        if url and url not in bases:
            bases.append(url)
    return bases


def _timeout_for(base: str) -> float:
    return 8.0 if base.startswith("https://") else 2.0


def _osrm_url(base: str, olon: float, olat: float, dlon: float, dlat: float) -> str:
    return (
        f"{base}/route/v1/driving/"
        f"{olon},{olat};{dlon},{dlat}?overview=full&geometries=geojson"
    )


def _parse_osrm(data: dict[str, Any]) -> dict[str, Any] | None:
    if data.get("code") != "Ok":
        return None
    route = data["routes"][0]
    coords = route["geometry"]["coordinates"]
    return {
        "distance_km": route["distance"] / 1000.0,
        "duration_s": route["duration"],
        "geometry": coords,
    }


async def fetch_osrm_route(olon: float, olat: float, dlon: float, dlat: float) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            for base in _osrm_bases():
                try:
                    r = await client.get(_osrm_url(base, olon, olat, dlon, dlat), timeout=_timeout_for(base))
                    r.raise_for_status()
                    parsed = _parse_osrm(r.json())
                    if parsed:
                        return parsed
                except Exception:
                    continue
    except Exception:
        return None
    return None


def fetch_osrm_route_sync(olon: float, olat: float, dlon: float, dlat: float) -> dict[str, Any] | None:
    try:
        with httpx.Client(timeout=8.0) as client:
            for base in _osrm_bases():
                try:
                    r = client.get(_osrm_url(base, olon, olat, dlon, dlat), timeout=_timeout_for(base))
                    r.raise_for_status()
                    parsed = _parse_osrm(r.json())
                    if parsed:
                        return parsed
                except Exception:
                    continue
    except Exception:
        return None
    return None


def fallback_route(olat: float, olon: float, dlat: float, dlon: float) -> dict[str, Any]:
    air = haversine_km(olat, olon, dlat, dlon)
    road = air * 1.32
    return {
        "distance_km": road,
        "duration_s": (road / 70.0) * 3600,
        "geometry": interpolate_line(olat, olon, dlat, dlon, n=max(8, int(air / 12))),
    }


def get_cached_route(db: Session, origin_id: int, dest_id: int) -> RouteCache | None:
    return (
        db.query(RouteCache)
        .filter(RouteCache.origin_id == origin_id, RouteCache.dest_id == dest_id)
        .one_or_none()
    )


def _store_route(db: Session, origin: Settlement, dest: Settlement, data: dict[str, Any]) -> RouteCache:
    row = RouteCache(
        origin_id=origin.id,
        dest_id=dest.id,
        distance_km=round(data["distance_km"], 1),
        duration_s=data["duration_s"],
        geometry=dump_coords(data["geometry"]),
    )
    try:
        db.add(row)
        db.commit()
        db.refresh(row)
        return row
    except IntegrityError:
        db.rollback()
        cached = get_cached_route(db, origin.id, dest.id)
        if cached:
            return cached
        raise


async def ensure_route(db: Session, origin: Settlement, dest: Settlement) -> RouteCache:
    cached = get_cached_route(db, origin.id, dest.id)
    if cached:
        return cached
    fetched = await fetch_osrm_route(origin.lon, origin.lat, dest.lon, dest.lat)
    data = fetched or fallback_route(origin.lat, origin.lon, dest.lat, dest.lon)
    return _store_route(db, origin, dest, data)


def ensure_route_sync(db: Session, origin: Settlement, dest: Settlement) -> RouteCache:
    cached = get_cached_route(db, origin.id, dest.id)
    if cached:
        return cached
    fetched = fetch_osrm_route_sync(origin.lon, origin.lat, dest.lon, dest.lat)
    data = fetched or fallback_route(origin.lat, origin.lon, dest.lat, dest.lon)
    return _store_route(db, origin, dest, data)


def route_coords(row: RouteCache) -> list[list[float]]:
    return load_coords(row.geometry)


def _apply_fetched(db: Session, row: RouteCache, data: dict[str, Any]) -> RouteCache:
    row.distance_km = round(data["distance_km"], 1)
    row.duration_s = data["duration_s"]
    row.geometry = dump_coords(data["geometry"])
    db.commit()
    db.refresh(row)
    return row


def ensure_road_route(db: Session, origin: Settlement, dest: Settlement) -> RouteCache | None:
    """Return a road-following cache row, refreshing a straight-line fallback when OSRM answers."""
    cached = get_cached_route(db, origin.id, dest.id)
    if cached and looks_like_road(load_coords(cached.geometry)):
        return cached
    reverse = get_cached_route(db, dest.id, origin.id)
    if reverse and looks_like_road(load_coords(reverse.geometry)):
        return reverse
    fetched = fetch_osrm_route_sync(origin.lon, origin.lat, dest.lon, dest.lat)
    if not fetched:
        return cached or reverse
    if cached:
        return _apply_fetched(db, cached, fetched)
    return _store_route(db, origin, dest, fetched)


async def prefetch_pair_matrix(db: Session, settlements: list[Settlement], pairs: list[tuple[int, int]]) -> None:
    by_id = {s.id: s for s in settlements}
    for a, b in pairs:
        if a == b:
            continue
        if get_cached_route(db, a, b):
            continue
        await ensure_route(db, by_id[a], by_id[b])
        await asyncio.sleep(0.15)

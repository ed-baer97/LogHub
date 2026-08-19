from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.config import settings
from app.models import RouteCache, Settlement
from app.services.geo import dump_coords, haversine_km, interpolate_line, load_coords
from sqlalchemy.orm import Session


async def fetch_osrm_route(olon: float, olat: float, dlon: float, dlat: float) -> dict[str, Any] | None:
    url = (
        f"{settings.osrm_url}/route/v1/driving/"
        f"{olon},{olat};{dlon},{dlat}?overview=full&geometries=geojson"
    )
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.json()
        if data.get("code") != "Ok":
            return None
        route = data["routes"][0]
        coords = route["geometry"]["coordinates"]
        return {
            "distance_km": route["distance"] / 1000.0,
            "duration_s": route["duration"],
            "geometry": coords,
        }
    except Exception:
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


async def ensure_route(db: Session, origin: Settlement, dest: Settlement) -> RouteCache:
    cached = get_cached_route(db, origin.id, dest.id)
    if cached:
        return cached
    fetched = await fetch_osrm_route(origin.lon, origin.lat, dest.lon, dest.lat)
    data = fetched or fallback_route(origin.lat, origin.lon, dest.lat, dest.lon)
    row = RouteCache(
        origin_id=origin.id,
        dest_id=dest.id,
        distance_km=round(data["distance_km"], 1),
        duration_s=data["duration_s"],
        geometry=dump_coords(data["geometry"]),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def route_coords(row: RouteCache) -> list[list[float]]:
    return load_coords(row.geometry)


async def prefetch_pair_matrix(db: Session, settlements: list[Settlement], pairs: list[tuple[int, int]]) -> None:
    by_id = {s.id: s for s in settlements}
    for a, b in pairs:
        if a == b:
            continue
        if get_cached_route(db, a, b):
            continue
        await ensure_route(db, by_id[a], by_id[b])
        await asyncio.sleep(0.15)

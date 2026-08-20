from __future__ import annotations

import json
import math


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlmb = math.radians(lon2 - lon1)
    y = math.sin(dlmb) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlmb)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def interpolate_line(lat1: float, lon1: float, lat2: float, lon2: float, n: int = 24) -> list[list[float]]:
    return [
        [lon1 + (lon2 - lon1) * i / n, lat1 + (lat2 - lat1) * i / n]
        for i in range(n + 1)
    ]


def looks_like_road(coords: list[list[float]], min_dev_km: float = 0.4) -> bool:
    """OSRM polyline leaves the origin–dest chord; a straight interpolation does not."""
    if len(coords) >= 32:
        return True
    if len(coords) < 8:
        return False
    a_lon, a_lat = coords[0]
    b_lon, b_lat = coords[-1]
    step = max(1, len(coords) // 48)
    for lon, lat in coords[1:-1:step]:
        if point_to_segment_km(lat, lon, a_lat, a_lon, b_lat, b_lon) >= min_dev_km:
            return True
    return False


def point_to_segment_km(
    lat: float, lon: float, alat: float, alon: float, blat: float, blon: float
) -> float:
    # Equirectangular local projection for short regional segments
    kx = 111.32 * math.cos(math.radians((alat + blat) / 2))
    ky = 110.57
    ax, ay = alon * kx, alat * ky
    bx, by = blon * kx, blat * ky
    px, py = lon * kx, lat * ky
    abx, aby = bx - ax, by - ay
    denom = abx * abx + aby * aby
    if denom == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / denom))
    return math.hypot(px - (ax + t * abx), py - (ay + t * aby))


def distance_to_polyline_km(lat: float, lon: float, coords: list[list[float]]) -> float:
    best = 1e9
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        best = min(best, point_to_segment_km(lat, lon, lat1, lon1, lat2, lon2))
    return best


def coords_length_km(coords: list[list[float]]) -> float:
    total = 0.0
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        total += haversine_km(lat1, lon1, lat2, lon2)
    return total


def advance_along(coords: list[list[float]], km: float) -> tuple[float, float, float, bool]:
    """Return lat, lon, heading, finished."""
    remaining = km
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        seg = haversine_km(lat1, lon1, lat2, lon2)
        if remaining <= seg:
            t = 0 if seg == 0 else remaining / seg
            lat = lat1 + (lat2 - lat1) * t
            lon = lon1 + (lon2 - lon1) * t
            return lat, lon, bearing(lat1, lon1, lat2, lon2), False
        remaining -= seg
    lon, lat = coords[-1]
    if len(coords) >= 2:
        lon0, lat0 = coords[-2]
        return lat, lon, bearing(lat0, lon0, lat, lon), True
    return lat, lon, 0.0, True


def dump_coords(coords: list[list[float]]) -> str:
    return json.dumps(coords)


def load_coords(raw: str) -> list[list[float]]:
    return json.loads(raw)

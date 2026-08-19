from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import Order, RouteCache, Settlement, Vehicle
from app.services.geo import distance_to_polyline_km, haversine_km
from app.services.osrm import get_cached_route, route_coords

DIESEL_L_PER_100KM = 32.0
DIESEL_KZT_PER_L = 295.0
CORRIDOR_KM = 55.0
MAX_DETOUR_KM = 90.0


def _dist(db: Session, a: Settlement, b: Settlement) -> float:
    cached = get_cached_route(db, a.id, b.id)
    if cached:
        return cached.distance_km
    cached_rev = get_cached_route(db, b.id, a.id)
    if cached_rev:
        return cached_rev.distance_km
    return haversine_km(a.lat, a.lon, b.lat, b.lon) * 1.32


def match_orders(
    db: Session,
    origin: Settlement,
    dest: Settlement,
    orders: list[Order],
) -> list[dict]:
    """Find cargo that fits the corridor origin->dest (backhaul / попутка)."""
    direct = _dist(db, origin, dest)
    cached: RouteCache | None = get_cached_route(db, origin.id, dest.id)
    coords = route_coords(cached) if cached else None
    results: list[dict] = []
    for order in orders:
        pickup_to_line = (
            distance_to_polyline_km(order.origin.lat, order.origin.lon, coords)
            if coords
            else haversine_km(origin.lat, origin.lon, order.origin.lat, order.origin.lon)
        )
        drop_to_line = (
            distance_to_polyline_km(order.dest.lat, order.dest.lon, coords)
            if coords
            else haversine_km(dest.lat, dest.lon, order.dest.lat, order.dest.lon)
        )
        via = (
            _dist(db, origin, order.origin)
            + _dist(db, order.origin, order.dest)
            + _dist(db, order.dest, dest)
        )
        detour = max(0.0, via - direct)
        near_start = haversine_km(origin.lat, origin.lon, order.origin.lat, order.origin.lon) < 40
        near_end = haversine_km(dest.lat, dest.lon, order.dest.lat, order.dest.lon) < 45
        backhaul = near_start or (
            haversine_km(origin.lat, origin.lon, order.origin.lat, order.origin.lon) < 70
            and near_end
        )
        in_corridor = pickup_to_line <= CORRIDOR_KM and drop_to_line <= CORRIDOR_KM and detour <= MAX_DETOUR_KM
        if not (backhaul or in_corridor):
            continue
        loaded = _dist(db, order.origin, order.dest)
        empty_without = direct  # return empty along this leg
        empty_with = max(0.0, detour)
        saved = max(0.0, empty_without - empty_with)
        # if it's an extra loaded trip on the return, saved ~= min(loaded, direct) - detour
        saved = max(saved, max(0.0, min(loaded, direct) - detour * 0.35))
        fuel = saved * DIESEL_L_PER_100KM / 100.0
        money = fuel * DIESEL_KZT_PER_L
        if backhaul and near_end:
            reason = "Обратная загрузка: вместо порожнего возврата машина везёт груз к базе"
        elif in_corridor:
            reason = "Попутный груз в коридоре маршрута, крюк в пределах нормы"
        else:
            reason = "Подбор рядом со стартом, мало дополнительного пробега"
        results.append(
            {
                "order_id": order.id,
                "detour_km": round(detour, 1),
                "empty_km_saved": round(saved, 1),
                "fuel_saved_l": round(fuel, 1),
                "money_saved_kzt": int(money),
                "reason": reason,
                "loaded_km": round(loaded, 1),
            }
        )
    results.sort(key=lambda x: -x["empty_km_saved"])
    return results


def match_for_vehicle(db: Session, vehicle: Vehicle, open_orders: list[Order]) -> list[dict]:
    home = vehicle.home
    # Prefer current destination as origin of the empty return
    if vehicle.current_order_id:
        current = db.get(Order, vehicle.current_order_id)
        if current:
            return match_orders(db, current.dest, home, open_orders)
    # Idle truck: from current position nearest settlement toward home
    here = min(
        db.query(Settlement).all(),
        key=lambda s: haversine_km(vehicle.lat, vehicle.lon, s.lat, s.lon),
    )
    return match_orders(db, here, home, open_orders)

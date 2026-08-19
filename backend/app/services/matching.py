from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import Order, RouteCache, Settlement, User, Vehicle
from app.services.geo import distance_to_polyline_km, haversine_km
from app.services.osrm import get_cached_route, route_coords

DIESEL_L_PER_100KM = 32.0
DIESEL_KZT_PER_L = 295.0
CORRIDOR_KM = 55.0
MAX_DETOUR_KM = 90.0
BBOX_PAD_DEG = 0.85


def _route_map(db: Session, pairs: set[tuple[int, int]]) -> dict[tuple[int, int], RouteCache]:
    if not pairs:
        return {}
    ids = {a for a, b in pairs} | {b for a, b in pairs}
    rows = (
        db.query(RouteCache)
        .filter(RouteCache.origin_id.in_(ids), RouteCache.dest_id.in_(ids))
        .all()
    )
    return {(r.origin_id, r.dest_id): r for r in rows}


def _dist(
    db: Session,
    a: Settlement,
    b: Settlement,
    routes: dict[tuple[int, int], RouteCache] | None = None,
) -> float:
    if routes is not None:
        cached = routes.get((a.id, b.id)) or routes.get((b.id, a.id))
        if cached:
            return cached.distance_km
        return haversine_km(a.lat, a.lon, b.lat, b.lon) * 1.32
    cached = get_cached_route(db, a.id, b.id)
    if cached:
        return cached.distance_km
    cached_rev = get_cached_route(db, b.id, a.id)
    if cached_rev:
        return cached_rev.distance_km
    return haversine_km(a.lat, a.lon, b.lat, b.lon) * 1.32


def candidate_open_orders(db: Session, user: User, origin: Settlement, dest: Settlement) -> list[Order]:
    """Open orders whose origin or dest sits in the corridor bounding box."""
    from app.access import visible_orders_query

    min_lat = min(origin.lat, dest.lat) - BBOX_PAD_DEG
    max_lat = max(origin.lat, dest.lat) + BBOX_PAD_DEG
    min_lon = min(origin.lon, dest.lon) - BBOX_PAD_DEG
    max_lon = max(origin.lon, dest.lon) + BBOX_PAD_DEG
    box_ids = [
        row[0]
        for row in db.query(Settlement.id)
        .filter(Settlement.lat.between(min_lat, max_lat), Settlement.lon.between(min_lon, max_lon))
        .all()
    ]
    if not box_ids:
        return []
    return (
        visible_orders_query(db, user)
        .filter(Order.status == "open")
        .filter(or_(Order.origin_id.in_(box_ids), Order.dest_id.in_(box_ids)))
        .all()
    )


def match_orders(
    db: Session,
    origin: Settlement,
    dest: Settlement,
    orders: list[Order],
) -> list[dict]:
    """Find cargo that fits the corridor origin->dest (backhaul / попутка)."""
    pairs: set[tuple[int, int]] = {(origin.id, dest.id)}
    for order in orders:
        pairs.add((origin.id, order.origin.id))
        pairs.add((order.origin.id, order.dest.id))
        pairs.add((order.dest.id, dest.id))
    routes = _route_map(db, pairs)
    direct = _dist(db, origin, dest, routes)
    cached = routes.get((origin.id, dest.id)) or get_cached_route(db, origin.id, dest.id)
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
            _dist(db, origin, order.origin, routes)
            + _dist(db, order.origin, order.dest, routes)
            + _dist(db, order.dest, dest, routes)
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
        loaded = _dist(db, order.origin, order.dest, routes)
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


def _nearest_settlement(db: Session, vehicle: Vehicle) -> Settlement:
    dlat = Settlement.lat - vehicle.lat
    dlon = Settlement.lon - vehicle.lon
    here = db.query(Settlement).order_by(dlat * dlat + dlon * dlon).first()
    if here:
        return here
    home = vehicle.home or db.get(Settlement, vehicle.home_id)
    if not home:
        raise RuntimeError("у борта нет базы")
    return home


def match_for_vehicle(db: Session, vehicle: Vehicle, open_orders: list[Order] | None = None) -> list[dict]:
    home = vehicle.home or db.get(Settlement, vehicle.home_id)
    if not home:
        return []
    origin = home
    if vehicle.current_order_id:
        current = db.get(Order, vehicle.current_order_id)
        if current:
            origin = current.dest
        else:
            origin = _nearest_settlement(db, vehicle)
    else:
        origin = _nearest_settlement(db, vehicle)
    if open_orders is None:
        owner = db.get(User, vehicle.owner_id)
        open_orders = candidate_open_orders(db, owner, origin, home) if owner else []
    return match_orders(db, origin, home, open_orders)

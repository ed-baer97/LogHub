from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session, aliased

from app.access import require_staff
from app.config import settings
from app.database import get_db
from app.models import HistoricalTrip, Order, Settlement, User, Vehicle
from app.roles import is_superadmin
from app.services.cache import cache_get, cache_set, track_points_count
from app.services.matching import DIESEL_KZT_PER_L, DIESEL_L_PER_100KM
from app.services.metrics import arq_queue_len, instance_id, sse_total

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

EMPTY_SHARE_WITHOUT = 0.40
ACTIVE_STATUSES = ("open", "taken", "assigned", "arrived", "loading", "pickup", "transit")
CORRIDOR_STATUSES = ("delivered", "transit")

StaffDep = Annotated[User, Depends(require_staff)]
DbDep = Annotated[Session, Depends(get_db)]


def _f(value) -> float:
    return float(value or 0)


def _build_summary(db: Session) -> dict:
    loaded_km = _f(
        db.query(func.coalesce(func.sum(Order.distance_km), 0)).filter(Order.status == "delivered").scalar()
    )
    saved_km = _f(
        db.query(func.coalesce(func.sum(Order.empty_km_saved), 0))
        .filter(Order.status.in_(("delivered",) + ACTIVE_STATUSES))
        .scalar()
    )
    baseline_empty = loaded_km * EMPTY_SHARE_WITHOUT
    platform_empty = max(0.0, baseline_empty - saved_km)
    fuel_l = saved_km * DIESEL_L_PER_100KM / 100.0
    money = fuel_l * DIESEL_KZT_PER_L

    origin_s = aliased(Settlement)
    dest_s = aliased(Settlement)
    corridor_rows = (
        db.query(
            origin_s.name,
            dest_s.name,
            func.count(Order.id),
            func.coalesce(func.sum(Order.distance_km), 0),
        )
        .join(origin_s, Order.origin_id == origin_s.id)
        .join(dest_s, Order.dest_id == dest_s.id)
        .filter(Order.status.in_(CORRIDOR_STATUSES))
        .group_by(origin_s.name, dest_s.name)
        .order_by(func.sum(Order.distance_km).desc())
        .limit(8)
        .all()
    )
    corridors = [
        {"from": origin_name, "to": dest_name, "trips": int(trips), "km": round(_f(km), 1)}
        for origin_name, dest_name, trips, km in corridor_rows
    ]

    hist_empty = _f(
        db.query(func.sum(HistoricalTrip.distance_km)).filter(HistoricalTrip.empty_return.is_(True)).scalar()
    )
    hist_all = _f(db.query(func.sum(HistoricalTrip.distance_km)).scalar()) or 1.0

    return {
        "settlements": int(db.query(func.count(Settlement.id)).scalar() or 0),
        "vehicles": int(db.query(func.count(Vehicle.id)).scalar() or 0),
        "open_orders": int(db.query(func.count(Order.id)).filter(Order.status == "open").scalar() or 0),
        "in_transit": int(db.query(func.count(Order.id)).filter(Order.status == "transit").scalar() or 0),
        "delivered": int(db.query(func.count(Order.id)).filter(Order.status == "delivered").scalar() or 0),
        "loaded_km": round(loaded_km, 1),
        "empty_km_without_platform": round(baseline_empty, 1),
        "empty_km_with_platform": round(platform_empty, 1),
        "empty_km_saved": round(saved_km, 1),
        "fuel_saved_l": round(fuel_l, 1),
        "money_saved_kzt": int(money),
        "empty_share_history": round(hist_empty / hist_all, 3),
        "corridors": corridors,
        "assumptions": {
            "diesel_l_per_100km": DIESEL_L_PER_100KM,
            "diesel_kzt_per_l": DIESEL_KZT_PER_L,
            "empty_share_without": EMPTY_SHARE_WITHOUT,
        },
    }


@router.get("/summary")
def summary(db: DbDep, user: StaffDep):
    scope = "super" if is_superadmin(user.role) else "staff"
    cache_key = f"analytics:summary:{scope}"
    cached = cache_get(cache_key)
    if isinstance(cached, dict):
        return cached

    payload = _build_summary(db)
    if not is_superadmin(user.role):
        payload.pop("empty_km_without_platform", None)
        payload.pop("empty_share_history", None)
        payload["assumptions"] = {}
        payload["live_gps"] = None
    cache_set(cache_key, payload, settings.cache_ttl_s)
    return payload


@router.get("/ops")
def ops(db: DbDep, user: StaffDep):
    tracks = track_points_count(db) or 0
    return {
        "instance": instance_id(),
        "track_points": tracks,
        "sse_connections": sse_total(),
        "arq_queue": arq_queue_len(),
        "db_pool_size": settings.db_pool_size,
        "db_max_overflow": settings.db_max_overflow,
    }

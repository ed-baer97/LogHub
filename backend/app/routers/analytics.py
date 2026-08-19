from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.access import require_staff
from app.database import get_db
from app.models import HistoricalTrip, Order, Settlement, User, Vehicle
from app.roles import is_superadmin
from app.services.matching import DIESEL_KZT_PER_L, DIESEL_L_PER_100KM

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

EMPTY_SHARE_WITHOUT = 0.40

StaffDep = Annotated[User, Depends(require_staff)]
DbDep = Annotated[Session, Depends(get_db)]


@router.get("/summary")
def summary(db: DbDep, user: StaffDep):
    delivered = (
        db.query(Order)
        .options(joinedload(Order.origin), joinedload(Order.dest))
        .filter(Order.status == "delivered")
        .all()
    )
    active = (
        db.query(Order)
        .options(joinedload(Order.origin), joinedload(Order.dest))
        .filter(Order.status.in_(["open", "taken", "assigned", "arrived", "loading", "pickup", "transit"]))
        .all()
    )
    loaded_km = sum(o.distance_km for o in delivered)
    saved_km = sum(o.empty_km_saved for o in delivered) + sum(o.empty_km_saved for o in active)
    baseline_empty = loaded_km * EMPTY_SHARE_WITHOUT
    platform_empty = max(0.0, baseline_empty - saved_km)
    fuel_l = saved_km * DIESEL_L_PER_100KM / 100.0
    money = fuel_l * DIESEL_KZT_PER_L

    by_pair: dict[tuple[str, str], dict] = {}
    for o in delivered + [x for x in active if x.status == "transit"]:
        key = (o.origin.name if o.origin else "?", o.dest.name if o.dest else "?")
        slot = by_pair.setdefault(key, {"from": key[0], "to": key[1], "trips": 0, "km": 0.0})
        slot["trips"] += 1
        slot["km"] += o.distance_km
    corridors = sorted(by_pair.values(), key=lambda x: -x["km"])[:8]

    hist_empty = db.query(func.sum(HistoricalTrip.distance_km)).filter(HistoricalTrip.empty_return.is_(True)).scalar() or 0
    hist_all = db.query(func.sum(HistoricalTrip.distance_km)).scalar() or 1

    payload = {
        "settlements": db.query(Settlement).count(),
        "vehicles": db.query(Vehicle).count(),
        "open_orders": db.query(Order).filter(Order.status == "open").count(),
        "in_transit": db.query(Order).filter(Order.status == "transit").count(),
        "delivered": len(delivered),
        "loaded_km": round(loaded_km, 1),
        "empty_km_without_platform": round(baseline_empty, 1),
        "empty_km_with_platform": round(platform_empty, 1),
        "empty_km_saved": round(saved_km, 1),
        "fuel_saved_l": round(fuel_l, 1),
        "money_saved_kzt": int(money),
        "empty_share_history": round(float(hist_empty) / float(hist_all), 3),
        "corridors": corridors,
        "assumptions": {
            "diesel_l_per_100km": DIESEL_L_PER_100KM,
            "diesel_kzt_per_l": DIESEL_KZT_PER_L,
            "empty_share_without": EMPTY_SHARE_WITHOUT,
        },
    }
    if not is_superadmin(user.role):
        payload.pop("empty_km_without_platform", None)
        payload.pop("empty_share_history", None)
        payload["assumptions"] = {}
        payload["live_gps"] = None
    return payload

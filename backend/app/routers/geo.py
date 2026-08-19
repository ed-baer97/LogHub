from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Settlement, Vehicle
from app.schemas import SettlementOut, VehicleOut

router = APIRouter(prefix="/api/geo", tags=["geo"])


@router.get("/settlements", response_model=list[SettlementOut])
def settlements(db: Annotated[Session, Depends(get_db)]):
    return db.query(Settlement).order_by(Settlement.kind, Settlement.name).all()


@router.get("/vehicles", response_model=list[VehicleOut])
def vehicles(db: Annotated[Session, Depends(get_db)]):
    now = datetime.utcnow()
    rows = db.query(Vehicle).order_by(Vehicle.plate).all()
    out = []
    for v in rows:
        item = VehicleOut.model_validate(v)
        item.live = bool(v.live_until and v.live_until > now)
        out.append(item)
    return out

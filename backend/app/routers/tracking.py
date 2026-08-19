from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import TrackPoint, User, Vehicle
from app.schemas import TrackPingIn
from app.services.events import sse_stream
from app.services.simulator import mark_live, publish_vehicles

router = APIRouter(prefix="/api/tracking", tags=["tracking"])


@router.get("/stream")
async def stream():
    return StreamingResponse(
        sse_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/ping")
def ping(
    body: TrackPingIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    v = db.get(Vehicle, body.vehicle_id)
    if not v:
        raise HTTPException(404, "Машина не найдена")
    mark_live(v, body.lat, body.lon)
    db.add(TrackPoint(vehicle_id=v.id, lat=body.lat, lon=body.lon, source="live", ts=datetime.utcnow()))
    db.commit()
    publish_vehicles(db)
    return {"ok": True, "lat": v.lat, "lon": v.lon}


@router.get("/{vehicle_id}/trail")
def trail(vehicle_id: int, db: Annotated[Session, Depends(get_db)], limit: int = 80):
    rows = (
        db.query(TrackPoint)
        .filter(TrackPoint.vehicle_id == vehicle_id)
        .order_by(TrackPoint.id.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()
    return [{"lat": r.lat, "lon": r.lon, "ts": r.ts.isoformat(), "source": r.source} for r in rows]

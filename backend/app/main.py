from contextlib import asynccontextmanager
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func

from app.config import settings
from app.database import Base, SessionLocal, engine
from app.models import TrackPoint
from app.routers import admin, analytics, auth, fleet, geo, orders, tracking
from app.seed import seed_if_empty
from app.services.events import bus
from app.services.metrics import RequestMetricsMiddleware, instance_id, prometheus_response


@asynccontextmanager
async def lifespan(_: FastAPI):
    if os.getenv("TESTING"):
        Base.metadata.create_all(bind=engine)
    await bus.start()
    if not os.getenv("TESTING"):
        db = SessionLocal()
        try:
            await seed_if_empty(db)
        finally:
            db.close()
    yield
    await bus.stop()


app = FastAPI(title="Caspian LogHub", version="1.0.0", lifespan=lifespan)
app.add_middleware(RequestMetricsMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list + ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(geo.router)
app.include_router(orders.router)
app.include_router(fleet.router)
app.include_router(tracking.router)
app.include_router(analytics.router)
app.include_router(admin.router)


@app.get("/api/health")
def health():
    return {"ok": True, "name": "Caspian LogHub", "instance": instance_id()}


@app.get("/metrics")
def metrics():
    db = SessionLocal()
    try:
        n = int(db.query(func.count(TrackPoint.id)).scalar() or 0)
    except Exception:
        n = None
    finally:
        db.close()
    return prometheus_response(n)

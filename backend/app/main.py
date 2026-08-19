from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import Base, SessionLocal, engine
from app.routers import admin, analytics, auth, geo, orders, tracking
from app.seed import seed_if_empty
from app.services.simulator import start_simulator


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        await seed_if_empty(db)
    finally:
        db.close()
    start_simulator()
    yield


app = FastAPI(title="Caspian LogHub", version="1.0.0", lifespan=lifespan)
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
app.include_router(tracking.router)
app.include_router(analytics.router)
app.include_router(admin.router)


@app.get("/api/health")
def health():
    return {"ok": True, "name": "Caspian LogHub"}

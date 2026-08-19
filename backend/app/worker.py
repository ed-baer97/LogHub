from __future__ import annotations

from datetime import datetime, timedelta

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.services.redisutil import redis_enabled


async def follow_vehicle(ctx, vehicle_id: int) -> None:
    from app.services.live import nav_stopped
    from app.services.simulator import run_follow_loop

    if nav_stopped(vehicle_id):
        return
    await run_follow_loop(vehicle_id)


async def prune_tracks(ctx) -> None:
    from app.database import SessionLocal
    from app.models import TrackPoint

    cutoff = datetime.utcnow() - timedelta(days=settings.track_retention_days)
    db = SessionLocal()
    try:
        db.query(TrackPoint).filter(TrackPoint.ts < cutoff).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def downsample_track_points(db: Session, *, older_than_days: int = 1) -> int:
    """Keep one GPS point per vehicle per minute for rows older than the cutoff."""
    from app.models import TrackPoint

    cutoff = datetime.utcnow() - timedelta(days=older_than_days)
    dialect = db.get_bind().dialect.name
    bucket = "date_trunc('minute', ts)" if dialect == "postgresql" else "strftime('%Y-%m-%d %H:%M', ts)"
    rows = db.execute(
        text(
            f"""
            SELECT id FROM (
              SELECT id, row_number() OVER (
                PARTITION BY vehicle_id, {bucket} ORDER BY id
              ) AS rn
              FROM track_points
              WHERE ts < :cutoff
            ) ranked
            WHERE rn > 1
            """
        ),
        {"cutoff": cutoff},
    ).all()
    ids = [row[0] for row in rows]
    if not ids:
        return 0
    CHUNK = 500
    deleted = 0
    for i in range(0, len(ids), CHUNK):
        chunk = ids[i : i + CHUNK]
        deleted += (
            db.query(TrackPoint)
            .filter(TrackPoint.id.in_(chunk))
            .delete(synchronize_session=False)
        )
    db.commit()
    return int(deleted or 0)


async def downsample_tracks(ctx) -> None:
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        downsample_track_points(db)
    finally:
        db.close()


async def prefetch_osrm(ctx) -> None:
    from app.database import SessionLocal
    from app.models import Settlement
    from app.seed import KEY_PAIRS
    from app.services.osrm import prefetch_pair_matrix

    db = SessionLocal()
    try:
        settlements = db.query(Settlement).filter(Settlement.sender_id.is_(None)).all()
        by_name = {s.name: s.id for s in settlements}
        pairs = [(by_name[a], by_name[b]) for a, b in KEY_PAIRS if a in by_name and b in by_name]
        if pairs:
            await prefetch_pair_matrix(db, settlements, pairs)
    finally:
        db.close()


async def resume_trips(ctx) -> None:
    from app.database import SessionLocal
    from app.models import Order, Vehicle
    from app.services.live import get_nav_plan, set_nav_plan
    from app.services.osrm import get_cached_route, route_coords

    db = SessionLocal()
    try:
        rows = db.query(Vehicle).filter(Vehicle.current_order_id.isnot(None)).all()
        for v in rows:
            order = db.get(Order, v.current_order_id)
            if not order or order.status != "transit":
                continue
            if not get_nav_plan(v.id):
                cached = get_cached_route(db, order.origin_id, order.dest_id)
                if cached:
                    set_nav_plan(v.id, route_coords(cached), 0.0)
            await ctx["redis"].enqueue_job("follow_vehicle", v.id, _job_id=f"follow:{v.id}")
    finally:
        db.close()


async def ensure_partitions(ctx) -> None:
    from app.database import SessionLocal
    from app.services.tracks import ensure_track_partitions

    db = SessionLocal()
    try:
        ensure_track_partitions(db)
    finally:
        db.close()


async def on_startup(ctx) -> None:
    await ensure_partitions(ctx)
    await resume_trips(ctx)


class WorkerSettings:
    functions = [follow_vehicle, prune_tracks, downsample_tracks, prefetch_osrm, ensure_partitions]
    cron_jobs = [
        cron(prune_tracks, hour=3, minute=0),
        cron(downsample_tracks, hour=4, minute=0),
        cron(prefetch_osrm, hour=5, minute=0),
        cron(ensure_partitions, hour=2, minute=15),
    ]
    on_startup = on_startup
    job_timeout = 86400
    max_jobs = 200
    redis_settings = (
        RedisSettings.from_dsn(settings.redis_url) if redis_enabled() or settings.redis_url.strip() else RedisSettings()
    )

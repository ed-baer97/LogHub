from __future__ import annotations

from calendar import monthrange
from datetime import date, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings


def month_start(d: date) -> date:
    return d.replace(day=1)


def add_months(d: date, months: int) -> date:
    idx = d.year * 12 + (d.month - 1) + months
    return date(idx // 12, idx % 12 + 1, 1)


def partition_name(start: date) -> str:
    return f"track_points_{start.year:04d}_{start.month:02d}"


def _is_partitioned(db: Session) -> bool:
    if db.get_bind().dialect.name != "postgresql":
        return False
    kind = db.execute(
        text(
            """
            SELECT c.relkind
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = 'track_points'
            """
        )
    ).scalar()
    return kind == "p"


def ensure_track_partitions(db: Session, *, ahead: int = 6) -> list[str]:
    """Create upcoming monthly partitions; drop those older than retention. Postgres only."""
    if not _is_partitioned(db):
        return []
    created: list[str] = []
    today = month_start(date.today())
    for i in range(0, max(1, ahead)):
        start = add_months(today, i)
        end = add_months(today, i + 1)
        name = partition_name(start)
        exists = db.execute(text("SELECT to_regclass(:name)"), {"name": f"public.{name}"}).scalar()
        if exists:
            continue
        db.execute(
            text(
                f'CREATE TABLE IF NOT EXISTS "{name}" PARTITION OF track_points '
                f"FOR VALUES FROM ('{start.isoformat()}') TO ('{end.isoformat()}')"
            )
        )
        created.append(name)
    cutoff = date.today() - timedelta(days=settings.track_retention_days + 32)
    rows = db.execute(
        text(
            """
            SELECT c.relname
            FROM pg_inherits i
            JOIN pg_class c ON c.oid = i.inhrelid
            JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname = 'track_points'
            """
        )
    ).all()
    for (relname,) in rows:
        if not relname.startswith("track_points_") or relname.count("_") != 3:
            continue
        try:
            _, year_s, month_s = relname.rsplit("_", 2)
            part_date = date(int(year_s), int(month_s), 1)
        except ValueError:
            continue
        last_day = date(part_date.year, part_date.month, monthrange(part_date.year, part_date.month)[1])
        if last_day < cutoff:
            db.execute(text(f'DROP TABLE IF EXISTS "{relname}"'))
    db.commit()
    return created

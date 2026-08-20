from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


def require_postgres(url: str | None = None) -> str:
    raw = (url if url is not None else settings.database_url) or ""
    if not raw.startswith("postgresql"):
        raise RuntimeError("DATABASE_URL must be PostgreSQL")
    return raw


_url = require_postgres()
engine = create_engine(
    _url,
    connect_args={"prepare_threshold": None},
    pool_pre_ping=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

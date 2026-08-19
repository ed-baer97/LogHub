from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


_sqlite = settings.database_url.startswith("sqlite")
connect_args: dict = {"check_same_thread": False} if _sqlite else {"prepare_threshold": None}
engine_kw: dict = {"connect_args": connect_args, "pool_pre_ping": not _sqlite}
if not _sqlite:
    engine_kw["pool_size"] = settings.db_pool_size
    engine_kw["max_overflow"] = settings.db_max_overflow

engine = create_engine(settings.database_url, **engine_kw)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

engine = create_engine(settings.database_url, **engine_kw)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

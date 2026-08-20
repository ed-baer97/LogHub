import os
import sys
from pathlib import Path
from urllib.parse import quote_plus

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT))


def _load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(REPO / ".env")
_load_dotenv(ROOT / ".env")

os.environ["TESTING"] = "1"
os.environ.setdefault("SECRET_KEY", "test-secret-not-for-production")
os.environ.setdefault("SUPERADMIN_PASSWORD", "secret")
os.environ.setdefault("OSRM_URL", "http://127.0.0.1:9")
os.environ.setdefault("OSRM_FALLBACK_URL", "http://127.0.0.1:9")

_PROD_DBS = frozenset({"caspian", "postgres"})


def _postgres_host_port() -> str:
    return os.environ.get("POSTGRES_HOST_PORT", "5432").strip() or "5432"


def _test_database_url() -> str:
    explicit = os.environ.get("TEST_DATABASE_URL", "").strip()
    if explicit:
        return explicit
    password = os.environ.get("POSTGRES_PASSWORD", "").strip()
    port = _postgres_host_port()
    if not password:
        raise SystemExit(
            "pytest needs Postgres. Set POSTGRES_PASSWORD (from .env) or TEST_DATABASE_URL "
            f"to postgresql+psycopg://caspian:...@127.0.0.1:{port}/caspian_test "
            "(never the production database caspian)."
        )
    return f"postgresql+psycopg://caspian:{quote_plus(password)}@127.0.0.1:{port}/caspian_test"


def _ensure_test_database(url: str) -> None:
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine.url import make_url
    from sqlalchemy.exc import OperationalError

    parsed = make_url(url)
    dbname = parsed.database
    if not dbname or dbname in _PROD_DBS:
        raise SystemExit(
            f"refusing to run pytest against database {dbname!r}; use caspian_test"
        )
    admin = parsed.set(database="postgres")
    engine = create_engine(admin.render_as_string(hide_password=False), isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :n"),
                {"n": dbname},
            ).scalar()
            if not exists:
                conn.execute(text(f'CREATE DATABASE "{dbname}"'))
    except OperationalError as exc:
        raise SystemExit(
            f"Cannot reach Postgres on 127.0.0.1:{_postgres_host_port()}. "
            "Start from the repo root: docker compose up -d postgres redis"
        ) from exc
    finally:
        engine.dispose()


def _reset_schema(url: str) -> None:
    from sqlalchemy import create_engine, text

    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    engine.dispose()


os.environ["DATABASE_URL"] = _test_database_url()
os.environ["REDIS_URL"] = os.environ.get("TEST_REDIS_URL", "").strip() or "redis://127.0.0.1:6379/1"

_ensure_test_database(os.environ["DATABASE_URL"])
_reset_schema(os.environ["DATABASE_URL"])

os.chdir(ROOT)
from alembic import command
from alembic.config import Config

command.upgrade(Config("alembic.ini"), "head")

import redis as redis_lib

_r = redis_lib.from_url(os.environ["REDIS_URL"], decode_responses=True)
try:
    _r.ping()
except redis_lib.ConnectionError as exc:
    raise SystemExit(
        "pytest needs Redis. Expose redis on 127.0.0.1:6379 (docker compose) "
        "or set TEST_REDIS_URL. SSE tests do not run without Redis."
    ) from exc
_r.flushdb()

import pytest
from fastapi.testclient import TestClient

from app.auth import hash_password
from app.database import SessionLocal
from app.main import app
from app.models import Settlement, User
from app.services.redisutil import redis_enabled, sync_redis


@pytest.fixture(scope="session")
def client():
    assert redis_enabled()
    assert sync_redis() is not None
    with TestClient(app) as c:
        db = SessionLocal()
        db.add(
            User(
                email="super@test.kz",
                name="Super",
                role="superadmin",
                password_hash=hash_password("secret"),
                is_active=True,
            )
        )
        db.add(Settlement(name="Актау", kind="city", lat=43.6588, lon=51.1975, population=1))
        db.add(Settlement(name="Шетпе", kind="village", lat=44.1444, lon=52.1722, population=1))
        db.commit()
        db.close()
        yield c
        sync_redis().flushdb()


def auth_header(client: TestClient, email: str, password: str = "secret") -> dict[str, str]:
    res = client.post("/api/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


@pytest.fixture(scope="session")
def accounts(client):
    super_h = auth_header(client, "super@test.kz")
    admin = client.post(
        "/api/admin/users",
        headers=super_h,
        json={"email": "admin@test.kz", "name": "Admin", "role": "admin", "password": "secret"},
    )
    assert admin.status_code == 200, admin.text
    admin_h = auth_header(client, "admin@test.kz")
    created = {}
    for email, name, role in [
        ("sender1@test.kz", "Sender One", "sender"),
        ("sender2@test.kz", "Sender Two", "sender"),
        ("carrier1@test.kz", "Carrier One", "carrier"),
        ("carrier2@test.kz", "Carrier Two", "carrier"),
    ]:
        res = client.post(
            "/api/admin/users",
            headers=admin_h,
            json={"email": email, "name": name, "role": role, "password": "secret", "company": name},
        )
        assert res.status_code == 200, res.text
        created[email] = res.json()
    created["points"] = client.get("/api/geo/settlements", headers=auth_header(client, "sender1@test.kz")).json()
    return created

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_db.close()
os.environ["TESTING"] = "1"
os.environ["DATABASE_URL"] = "sqlite:///" + Path(_db.name).as_posix()

import pytest
from fastapi.testclient import TestClient

from app.auth import hash_password
from app.database import SessionLocal
from app.main import app
from app.models import Settlement, User


@pytest.fixture(scope="session")
def client():
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

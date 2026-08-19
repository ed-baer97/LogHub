from fastapi.testclient import TestClient

from app.auth import _legacy_hash, is_legacy_hash, verify_password
from app.database import SessionLocal
from app.models import User


def test_login_returns_jwt(client: TestClient):
    res = client.post("/api/auth/login", json={"email": "super@test.kz", "password": "secret"})
    assert res.status_code == 200, res.text
    token = res.json()["token"]
    assert token.count(".") == 2


def test_legacy_sha256_rehashes_on_login(client: TestClient):
    db = SessionLocal()
    db.add(
        User(
            email="legacy@test.kz",
            name="Legacy",
            role="sender",
            password_hash=_legacy_hash("secret"),
            is_active=True,
        )
    )
    db.commit()
    db.close()

    res = client.post("/api/auth/login", json={"email": "legacy@test.kz", "password": "secret"})
    assert res.status_code == 200, res.text
    assert res.json()["token"].count(".") == 2

    db = SessionLocal()
    row = db.query(User).filter(User.email == "legacy@test.kz").one()
    assert not is_legacy_hash(row.password_hash)
    assert verify_password("secret", row.password_hash)
    db.close()

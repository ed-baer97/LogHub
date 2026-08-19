from fastapi.testclient import TestClient

from app.auth import _legacy_hash, is_legacy_hash, verify_password
from app.database import SessionLocal
from app.models import User


def _auth(client: TestClient, email: str, password: str = "secret") -> dict[str, str]:
    res = client.post("/api/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


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


def test_short_password_rejected(client: TestClient):
    h = _auth(client, "super@test.kz")
    res = client.patch(
        "/api/auth/me",
        headers=h,
        json={"current_password": "secret", "password": "abc"},
    )
    assert res.status_code == 422


def test_create_user_generates_password(client: TestClient):
    h = _auth(client, "super@test.kz")
    res = client.post(
        "/api/admin/users",
        headers=h,
        json={"email": "admin-gen@test.kz", "name": "Gen", "role": "admin"},
    )
    assert res.status_code == 200, res.text
    password = res.json()["initial_password"]
    assert password and len(password) >= 6
    login = client.post("/api/auth/login", json={"email": "admin-gen@test.kz", "password": password})
    assert login.status_code == 200, login.text


def test_reset_password_revokes_old_token(client: TestClient):
    super_h = _auth(client, "super@test.kz")
    admin = client.post(
        "/api/admin/users",
        headers=super_h,
        json={"email": "admin-rev@test.kz", "name": "Rev", "role": "admin", "password": "secret"},
    )
    assert admin.status_code == 200, admin.text
    admin_h = _auth(client, "admin-rev@test.kz")
    created = client.post(
        "/api/admin/users",
        headers=admin_h,
        json={"email": "sender-rev@test.kz", "name": "S", "role": "sender", "password": "secret"},
    )
    assert created.status_code == 200, created.text
    sender_h = _auth(client, "sender-rev@test.kz")
    assert client.get("/api/auth/me", headers=sender_h).status_code == 200
    reset = client.post(
        f"/api/admin/users/{created.json()['id']}/reset-password",
        headers=admin_h,
        json={},
    )
    assert reset.status_code == 200, reset.text
    assert client.get("/api/auth/me", headers=sender_h).status_code == 401


def test_block_revokes_token(client: TestClient):
    super_h = _auth(client, "super@test.kz")
    admin = client.post(
        "/api/admin/users",
        headers=super_h,
        json={"email": "admin-blk@test.kz", "name": "Blk", "role": "admin", "password": "secret"},
    )
    assert admin.status_code == 200, admin.text
    admin_h = _auth(client, "admin-blk@test.kz")
    created = client.post(
        "/api/admin/users",
        headers=admin_h,
        json={"email": "sender-blk@test.kz", "name": "B", "role": "sender", "password": "secret"},
    )
    assert created.status_code == 200, created.text
    sender_h = _auth(client, "sender-blk@test.kz")
    blocked = client.post(f"/api/admin/users/{created.json()['id']}/block", headers=admin_h)
    assert blocked.status_code == 200, blocked.text
    assert client.get("/api/auth/me", headers=sender_h).status_code == 401


def test_login_rate_limit(client: TestClient):
    payload = {"email": "nobody-rl@test.kz", "password": "wrongpw"}
    for _ in range(8):
        assert client.post("/api/auth/login", json=payload).status_code == 401
    assert client.post("/api/auth/login", json=payload).status_code == 429


def test_sse_ticket_requires_auth(client: TestClient):
    assert client.post("/api/tracking/ticket").status_code == 401
    h = _auth(client, "super@test.kz")
    res = client.post("/api/tracking/ticket", headers=h)
    assert res.status_code == 200
    assert res.json()["ticket"]


def test_trail_limit_bounds(client: TestClient):
    h = _auth(client, "super@test.kz")
    assert client.get("/api/tracking/1/trail?limit=0", headers=h).status_code == 422
    assert client.get("/api/tracking/1/trail?limit=501", headers=h).status_code == 422

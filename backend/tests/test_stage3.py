from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.models import TrackPoint
from app.worker import downsample_track_points


def _auth(client: TestClient, email: str, password: str = "secret") -> dict[str, str]:
    res = client.post("/api/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


def _points(accounts):
    pts = accounts["points"]
    return pts[0]["id"], pts[1]["id"]


def test_orders_and_vehicles_are_paginated(client: TestClient, accounts):
    s1 = _auth(client, "sender1@test.kz")
    origin, dest = _points(accounts)
    client.post(
        "/api/orders",
        headers=s1,
        json={"origin_id": origin, "dest_id": dest, "cargo_title": "Страница", "weight_kg": 100},
    )
    page = client.get("/api/orders?limit=1&offset=0", headers=s1).json()
    assert page["limit"] == 1
    assert page["offset"] == 0
    assert isinstance(page["items"], list)
    assert len(page["items"]) <= 1
    assert page["total"] >= len(page["items"])

    c1 = _auth(client, "carrier1@test.kz")
    fleet = client.get("/api/geo/vehicles?limit=1", headers=c1).json()
    assert fleet["limit"] == 1
    assert isinstance(fleet["items"], list)
    assert fleet["total"] >= len(fleet["items"])


def test_matching_bbox_skips_far_open_orders(client: TestClient, accounts):
    s1 = _auth(client, "sender1@test.kz")
    c1 = _auth(client, "carrier1@test.kz")
    origin, dest = _points(accounts)
    near = client.post(
        "/api/orders",
        headers=s1,
        json={"origin_id": origin, "dest_id": dest, "cargo_title": "Рядом", "weight_kg": 200},
    ).json()
    far_a = client.post(
        "/api/geo/settlements",
        headers=s1,
        json={"name": "Склад Алматы-тест", "kind": "industrial", "lat": 43.238, "lon": 76.889, "population": 1},
    ).json()
    far_b = client.post(
        "/api/geo/settlements",
        headers=s1,
        json={"name": "База Алматы-тест", "kind": "industrial", "lat": 43.250, "lon": 76.920, "population": 1},
    ).json()
    far = client.post(
        "/api/orders",
        headers=s1,
        json={"origin_id": far_a["id"], "dest_id": far_b["id"], "cargo_title": "Далеко", "weight_kg": 200},
    ).json()
    hints = client.get(f"/api/orders/hints/leg?origin_id={origin}&dest_id={dest}", headers=c1).json()
    ids = {h["order_id"] for h in hints}
    assert near["id"] in ids
    assert far["id"] not in ids


def test_analytics_summary_sql_shape(client: TestClient, accounts):
    super_h = _auth(client, "super@test.kz")
    body = client.get("/api/analytics/summary", headers=super_h).json()
    assert "loaded_km" in body
    assert "corridors" in body
    assert isinstance(body["corridors"], list)
    assert "empty_km_without_platform" in body
    admin = client.get("/api/analytics/summary", headers=_auth(client, "admin@test.kz")).json()
    assert "empty_km_without_platform" not in admin


def test_downsample_keeps_one_point_per_minute(client: TestClient, accounts):
    c1 = _auth(client, "carrier1@test.kz")
    origin, _ = _points(accounts)
    bort = client.post(
        "/api/fleet/borts",
        headers=c1,
        json={
            "plate": "A033DOWN",
            "kind": "tent",
            "capacity_kg": 8000,
            "home_id": origin,
            "driver_name": "Downsample",
            "driver_email": "driver-down@test.kz",
            "driver_password": "secret",
        },
    ).json()
    vid = bort["id"]
    db = SessionLocal()
    try:
        old = (datetime.utcnow() - timedelta(days=2)).replace(second=0, microsecond=0)
        for i in range(5):
            db.add(TrackPoint(vehicle_id=vid, lat=43.6, lon=51.2, source="sim", ts=old + timedelta(seconds=i * 10)))
        db.commit()
        deleted = downsample_track_points(db, older_than_days=1)
        assert deleted == 4
        left = db.query(TrackPoint).filter(TrackPoint.vehicle_id == vid).count()
        assert left == 1
    finally:
        db.close()

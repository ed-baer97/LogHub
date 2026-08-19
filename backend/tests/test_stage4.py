from datetime import date

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.services.metrics import sse_close, sse_open, sse_total
from app.services.tracks import ensure_track_partitions, partition_name


def _auth(client: TestClient, email: str, password: str = "secret") -> dict[str, str]:
    res = client.post("/api/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


def test_health_has_instance(client: TestClient):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body.get("instance")


def test_metrics_prometheus(client: TestClient):
    client.get("/api/health")
    res = client.get("/metrics")
    assert res.status_code == 200
    text = res.text
    assert "loghub_http_request_seconds" in text
    assert "loghub_track_points" in text
    assert "loghub_sse_connections" in text
    assert "loghub_arq_queue_jobs" in text


def test_ops_is_staff_only(client: TestClient, accounts):
    assert client.get("/api/analytics/ops").status_code == 401
    sender = _auth(client, "sender1@test.kz")
    assert client.get("/api/analytics/ops", headers=sender).status_code == 403
    body = client.get("/api/analytics/ops", headers=_auth(client, "admin@test.kz")).json()
    assert "track_points" in body
    assert "sse_connections" in body
    assert "arq_queue" in body
    assert body["track_points"] >= 0


def test_sse_counter_open_close():
    before = sse_total()
    sse_open()
    assert sse_total() == before + 1
    sse_close()
    assert sse_total() == before


def test_ensure_partitions_noop_on_sqlite():
    db = SessionLocal()
    try:
        assert ensure_track_partitions(db) == []
    finally:
        db.close()
    assert partition_name(date(2026, 8, 1)) == "track_points_2026_08"

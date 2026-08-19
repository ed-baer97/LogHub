from fastapi.testclient import TestClient


def _items(payload):
    if isinstance(payload, dict) and "items" in payload:
        return payload["items"]
    return payload


def _auth(client: TestClient, email: str, password: str = "secret") -> dict[str, str]:
    res = client.post("/api/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


def _points(accounts):
    pts = accounts["points"]
    return pts[0]["id"], pts[1]["id"]


def test_unauthenticated_lists_are_closed(client: TestClient):
    assert client.get("/api/orders").status_code == 401
    assert client.get("/api/geo/vehicles").status_code == 401
    assert client.get("/api/geo/settlements").status_code == 401
    catalog = client.get("/api/geo/catalog")
    assert catalog.status_code == 200
    assert all(p.get("sender_id") in (None, 0) for p in catalog.json())
    corridors = client.get("/api/geo/corridors")
    assert corridors.status_code == 200
    assert isinstance(corridors.json(), list)
    assert client.get("/api/analytics/summary").status_code == 401


def test_role_creation_matrix(client: TestClient, accounts):
    super_h = _auth(client, "super@test.kz")
    admin_h = _auth(client, "admin@test.kz")
    assert (
        client.post(
            "/api/admin/users",
            headers=super_h,
            json={"email": "nope-sender@test.kz", "name": "X", "role": "sender", "password": "secret"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/admin/users",
            headers=admin_h,
            json={"email": "nope-admin@test.kz", "name": "X", "role": "admin", "password": "secret"},
        ).status_code
        == 403
    )
    users = client.get("/api/admin/users", headers=admin_h).json()
    roles = {u["role"] for u in users}
    assert roles <= {"sender", "carrier"}
    assert "password" not in users[0]


def test_sender_isolation_and_open_only_mutate(client: TestClient, accounts):
    s1 = _auth(client, "sender1@test.kz")
    s2 = _auth(client, "sender2@test.kz")
    origin, dest = _points(accounts)
    created = client.post(
        "/api/orders",
        headers=s1,
        json={"origin_id": origin, "dest_id": dest, "cargo_title": "Песок", "weight_kg": 800},
    )
    assert created.status_code == 200, created.text
    oid = created.json()["id"]
    assert client.get(f"/api/orders/{oid}", headers=s2).status_code == 404
    mine = _items(client.get("/api/orders", headers=s2).json())
    assert all(o["id"] != oid for o in mine)
    assert client.post(f"/api/orders/{oid}/cancel", headers=s2).status_code == 404


def test_carrier_take_only_open_and_foreign_bort_404(client: TestClient, accounts):
    s1 = _auth(client, "sender1@test.kz")
    c1 = _auth(client, "carrier1@test.kz")
    c2 = _auth(client, "carrier2@test.kz")
    admin_h = _auth(client, "admin@test.kz")
    origin, dest = _points(accounts)
    order = client.post(
        "/api/orders",
        headers=s1,
        json={"origin_id": origin, "dest_id": dest, "cargo_title": "Щебень", "weight_kg": 500},
    ).json()
    oid = order["id"]
    take = client.post(f"/api/orders/{oid}/take", headers=c1, json={})
    assert take.status_code == 200, take.text
    assert take.json()["status"] == "taken"
    assert client.post(f"/api/orders/{oid}/take", headers=c1, json={}).status_code == 409
    assert client.post(f"/api/orders/{oid}/take", headers=c2, json={}).status_code == 404
    assert client.get(f"/api/orders/{oid}", headers=c2).status_code == 404

    home = origin
    bort = client.post(
        "/api/fleet/borts",
        headers=c1,
        json={
            "plate": "A001TEST",
            "kind": "tent",
            "capacity_kg": 10000,
            "home_id": home,
            "driver_name": "Driver One",
            "driver_email": "driver1@test.kz",
            "driver_password": "secret",
        },
    )
    assert bort.status_code == 200, bort.text
    vid = bort.json()["id"]
    assert client.patch(f"/api/fleet/borts/{vid}", headers=c2, json={"plate": "HACK"}).status_code == 404
    assert _items(client.get("/api/geo/vehicles", headers=c2).json()) == []
    assert _items(client.get("/api/geo/vehicles", headers=s1).json()) == []

    assigned = client.post(f"/api/orders/{oid}/assign", headers=c1, json={"vehicle_id": vid})
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["status"] == "assigned"

    start_body = {"vehicle_id": vid}
    assert client.post("/api/tracking/start-route", headers=c1, json=start_body).status_code == 403
    assert client.post("/api/tracking/start-route", headers=admin_h, json=start_body).status_code == 403

    driver_h = _auth(client, "driver1@test.kz")
    assert client.post("/api/tracking/start-route", headers=driver_h, json=start_body).status_code == 409
    assert client.post("/api/tracking/arrive", headers=driver_h, json=start_body).status_code == 200
    assert client.get(f"/api/orders/{oid}", headers=s1).json()["status"] == "arrived"
    assert client.post(f"/api/orders/{oid}/cancel", headers=s1).status_code == 409
    assert client.post("/api/tracking/start-loading", headers=driver_h, json=start_body).status_code == 200
    started = client.post("/api/tracking/start-route", headers=driver_h, json=start_body)
    assert started.status_code == 200, started.text
    assert client.get(f"/api/orders/{oid}", headers=driver_h).json()["status"] == "transit"
    done = client.post("/api/tracking/complete-route", headers=driver_h, json=start_body)
    assert done.status_code == 200, done.text
    assert client.get(f"/api/orders/{oid}", headers=s1).json()["status"] == "delivered"


def test_delete_open_and_cancel_assigned_frees_bort(client: TestClient, accounts):
    s1 = _auth(client, "sender1@test.kz")
    c1 = _auth(client, "carrier1@test.kz")
    origin, dest = _points(accounts)
    doomed = client.post(
        "/api/orders",
        headers=s1,
        json={"origin_id": origin, "dest_id": dest, "cargo_title": "Удалить", "weight_kg": 100},
    ).json()
    assert client.delete(f"/api/orders/{doomed['id']}", headers=s1).status_code == 200
    assert client.get(f"/api/orders/{doomed['id']}", headers=s1).status_code == 404

    order = client.post(
        "/api/orders",
        headers=s1,
        json={"origin_id": origin, "dest_id": dest, "cargo_title": "Отмена", "weight_kg": 100},
    ).json()
    oid = order["id"]
    client.post(f"/api/orders/{oid}/take", headers=c1, json={})
    assert client.delete(f"/api/orders/{oid}", headers=s1).status_code == 409
    bort = client.post(
        "/api/fleet/borts",
        headers=c1,
        json={
            "plate": "A002TEST",
            "kind": "tent",
            "capacity_kg": 10000,
            "home_id": origin,
            "driver_name": "Driver Two",
            "driver_email": "driver2@test.kz",
            "driver_password": "secret",
        },
    ).json()
    client.post(f"/api/orders/{oid}/assign", headers=c1, json={"vehicle_id": bort["id"]})
    cancelled = client.post(f"/api/orders/{oid}/cancel", headers=s1)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    fleet = _items(client.get("/api/geo/vehicles", headers=c1).json())
    unit = next(v for v in fleet if v["id"] == bort["id"])
    assert unit["current_order_id"] is None
    assert unit["status"] == "idle"


def test_carrier_edits_driver_and_password(client: TestClient, accounts):
    c1 = _auth(client, "carrier1@test.kz")
    origin, _ = _points(accounts)
    created = client.post(
        "/api/fleet/borts",
        headers=c1,
        json={
            "plate": "A009EDIT",
            "kind": "tent",
            "capacity_kg": 8000,
            "home_id": origin,
            "driver_name": "Edit Me",
            "driver_email": "driver-edit@test.kz",
            "driver_phone": "+77000000001",
            "driver_password": "secret",
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["initial_password"] == "secret"
    assert body["driver_email"] == "driver-edit@test.kz"
    vid = body["id"]

    patched = client.patch(
        f"/api/fleet/borts/{vid}",
        headers=c1,
        json={
            "driver_name": "New Name",
            "driver_email": "driver-edit2@test.kz",
            "driver_phone": "+77000000002",
            "driver_password": "newpass",
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["driver_name"] == "New Name"
    assert patched.json()["driver_email"] == "driver-edit2@test.kz"
    assert patched.json()["initial_password"] == "newpass"
    listed = _items(client.get("/api/geo/vehicles", headers=c1).json())
    unit = next(v for v in listed if v["id"] == vid)
    assert unit["driver_email"] == "driver-edit2@test.kz"
    assert unit.get("initial_password") in (None, "")
    login = client.post("/api/auth/login", json={"email": "driver-edit2@test.kz", "password": "newpass"})
    assert login.status_code == 200, login.text
    blocked = client.patch(f"/api/fleet/borts/{vid}", headers=c1, json={"driver_active": False})
    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["driver_active"] is False
    assert client.post("/api/auth/login", json={"email": "driver-edit2@test.kz", "password": "newpass"}).status_code == 403


def test_driver_updates_own_profile(client: TestClient, accounts):
    c1 = _auth(client, "carrier1@test.kz")
    origin, _ = _points(accounts)
    bort = client.post(
        "/api/fleet/borts",
        headers=c1,
        json={
            "plate": "A010PROF",
            "kind": "tent",
            "capacity_kg": 8000,
            "home_id": origin,
            "driver_name": "Profile Driver",
            "driver_email": "driver-profile@test.kz",
            "driver_phone": "+77001110000",
            "driver_password": "secret",
        },
    )
    assert bort.status_code == 200, bort.text
    d = _auth(client, "driver-profile@test.kz")
    assert (
        client.patch(
            "/api/auth/me",
            headers=d,
            json={"email": "driver-profile2@test.kz", "password": "newer1"},
        ).status_code
        == 400
    )
    patched = client.patch(
        "/api/auth/me",
        headers=d,
        json={
            "name": "Асылбек",
            "phone": "+77001112233",
            "email": "driver-profile2@test.kz",
            "current_password": "secret",
            "password": "newer1",
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["name"] == "Асылбек"
    assert patched.json()["email"] == "driver-profile2@test.kz"
    assert patched.json()["phone"] == "+77001112233"
    assert "password" not in patched.json()
    assert client.post("/api/auth/login", json={"email": "driver-profile2@test.kz", "password": "newer1"}).status_code == 200
    fleet = _items(client.get("/api/geo/vehicles", headers=c1).json())
    unit = next(v for v in fleet if v["id"] == bort.json()["id"])
    assert unit["driver_name"] == "Асылбек"


def test_driver_sees_own_trip_history(client: TestClient, accounts):
    s1 = _auth(client, "sender1@test.kz")
    c1 = _auth(client, "carrier1@test.kz")
    origin, dest = _points(accounts)
    order = client.post(
        "/api/orders",
        headers=s1,
        json={"origin_id": origin, "dest_id": dest, "cargo_title": "История", "weight_kg": 200},
    ).json()
    client.post(f"/api/orders/{order['id']}/take", headers=c1, json={})
    bort = client.post(
        "/api/fleet/borts",
        headers=c1,
        json={
            "plate": "A011HIST",
            "kind": "tent",
            "capacity_kg": 8000,
            "home_id": origin,
            "driver_name": "Hist Driver",
            "driver_email": "driver-hist@test.kz",
            "driver_password": "secret",
        },
    ).json()
    client.post(f"/api/orders/{order['id']}/assign", headers=c1, json={"vehicle_id": bort["id"]})
    d = _auth(client, "driver-hist@test.kz")
    mine = client.get("/api/orders", headers=d)
    assert mine.status_code == 200, mine.text
    ids = [o["id"] for o in _items(mine.json())]
    assert order["id"] in ids
    assert all(o["vehicle_id"] == bort["id"] for o in _items(mine.json()))
    foreign = _items(client.get("/api/orders", headers=_auth(client, "carrier2@test.kz")).json())
    assert all(o["id"] != order["id"] or o["status"] == "open" for o in foreign)


def test_admin_analytics_omits_baseline(client: TestClient, accounts):
    admin = client.get("/api/analytics/summary", headers=_auth(client, "admin@test.kz")).json()
    assert "empty_km_without_platform" not in admin
    assert "empty_share_history" not in admin
    assert admin.get("live_gps") is None
    full = client.get("/api/analytics/summary", headers=_auth(client, "super@test.kz")).json()
    assert "empty_km_without_platform" in full
    assert "empty_share_history" in full


def test_admin_reset_password_generates(client: TestClient, accounts):
    admin_h = _auth(client, "admin@test.kz")
    created = client.post(
        "/api/admin/users",
        headers=admin_h,
        json={"email": "sender-reset@test.kz", "name": "Reset Me", "role": "sender", "password": "secret"},
    )
    assert created.status_code == 200, created.text
    uid = created.json()["id"]
    res = client.post(f"/api/admin/users/{uid}/reset-password", headers=admin_h, json={})
    assert res.status_code == 200, res.text
    pwd = res.json()["initial_password"]
    assert pwd and pwd != "demo"
    listed = client.get("/api/admin/users", headers=admin_h).json()
    row = next(u for u in listed if u["id"] == uid)
    assert row.get("initial_password") in (None, "")
    assert client.post("/api/auth/login", json={"email": "sender-reset@test.kz", "password": pwd}).status_code == 200


def test_only_sender_creates_orders(client: TestClient, accounts):
    origin, dest = _points(accounts)
    payload = {"origin_id": origin, "dest_id": dest, "cargo_title": "X", "weight_kg": 100}
    assert client.post("/api/orders", headers=_auth(client, "carrier1@test.kz"), json=payload).status_code == 403
    assert client.post("/api/orders", headers=_auth(client, "admin@test.kz"), json=payload).status_code == 403
    assert client.post("/api/admin/vehicles", headers=_auth(client, "admin@test.kz"), json={}).status_code == 404

from types import SimpleNamespace

from app.access import event_visible
from app.services.live import acquire_ping_slot, persist_track, set_position
from app.database import SessionLocal
from app.models import TrackPoint, Vehicle
from app.services.redisutil import redis_enabled, sync_redis


def test_event_visible_roles():
    carrier = SimpleNamespace(id=5, role="carrier")
    driver = SimpleNamespace(id=8, role="driver")
    sender = SimpleNamespace(id=3, role="sender")
    staff = SimpleNamespace(id=1, role="superadmin")
    veh = {"type": "vehicle", "owner_id": 5, "driver_id": 8, "sender_id": 3}
    assert event_visible(staff, veh)
    assert event_visible(carrier, veh)
    assert event_visible(driver, veh)
    assert event_visible(sender, veh)
    assert not event_visible(carrier, {**veh, "owner_id": 9})
    assert event_visible(carrier, {"type": "order_new", "sender_id": 3, "status": "open"})
    assert event_visible(driver, {"type": "order", "vehicle_id": 11, "status": "transit"}, vehicle_id=11)
    assert not event_visible(driver, {"type": "order", "vehicle_id": 12, "status": "transit"}, vehicle_id=11)


def test_ping_slot_and_flush_interval(client):
    assert redis_enabled()
    assert sync_redis().ping() is True
    vid = 424242
    assert acquire_ping_slot(vid) is True
    assert acquire_ping_slot(vid) is False

    db = SessionLocal()
    v = Vehicle(
        plate="TEST-FLUSH",
        kind="tent",
        capacity_kg=1000,
        owner_id=1,
        driver_name="T",
        status="idle",
        lat=43.6,
        lon=51.2,
        heading=0,
        home_id=1,
        active=True,
    )
    db.add(v)
    db.commit()
    db.refresh(v)
    set_position(v.id, 43.7, 51.3, 10, live=True)
    persist_track(db, v, "live")
    persist_track(db, v, "live")
    db.commit()
    n = db.query(TrackPoint).filter(TrackPoint.vehicle_id == v.id).count()
    db.close()
    assert n == 1

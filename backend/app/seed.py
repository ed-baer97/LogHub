from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.auth import hash_password
from app.models import HistoricalTrip, Order, RouteCache, Settlement, TrackPoint, User, Vehicle
from app.services.geo import dump_coords, haversine_km, interpolate_line
from app.services.osrm import fetch_osrm_route
from app.services.pricing import price_model

SUPERADMIN_EMAIL = "superadmin@caspian.kz"

SETTLEMENTS = [
    {"name": "Актау", "kind": "city", "lat": 43.6588, "lon": 51.1975, "population": 183000, "note": "Областной центр"},
    {"name": "Жанаозен", "kind": "city", "lat": 43.3412, "lon": 52.8619, "population": 147900, "note": "Нефтяной город"},
    {"name": "Форт-Шевченко", "kind": "city", "lat": 44.5089, "lon": 50.2636, "population": 5480, "note": "Полуостров Тюбкараган"},
    {"name": "Бейнеу", "kind": "village", "lat": 45.3242, "lon": 55.1961, "population": 49395, "note": "Северный хаб области"},
    {"name": "Шетпе", "kind": "village", "lat": 44.1444, "lon": 52.1722, "population": 13220, "note": "Центр Мангистауского района"},
    {"name": "Курык", "kind": "village", "lat": 43.1800, "lon": 51.6500, "population": 11500, "note": "Юг области, стройки и база снабжения"},
    {"name": "Жетыбай", "kind": "village", "lat": 43.5928, "lon": 52.0814, "population": 11600, "note": "Месторождение и посёлок"},
    {"name": "Таушык", "kind": "village", "lat": 44.3467, "lon": 51.3494, "population": 2600, "note": "Тюбкараган, удалённый аул"},
    {"name": "Сенек", "kind": "village", "lat": 42.9047, "lon": 54.1186, "population": 2800, "note": "Каракиянский район, дальний юг"},
    {"name": "Акшукур", "kind": "village", "lat": 43.7819, "lon": 51.1669, "population": 8500, "note": "Пригород Актау"},
    {"name": "Умирзак", "kind": "village", "lat": 43.7139, "lon": 51.2781, "population": 4200, "note": "Севернее Актау"},
    {"name": "Мангистау", "kind": "village", "lat": 44.1361, "lon": 51.8611, "population": 3100, "note": "Село у трассы Актау–Шетпе"},
    {"name": "Сай-Утес", "kind": "village", "lat": 44.3214, "lon": 53.5319, "population": 2400, "note": "Трасса на Бейнеу"},
    {"name": "Жынгылды", "kind": "village", "lat": 44.0667, "lon": 50.9833, "population": 1800, "note": "Западный берег"},
    {"name": "Боранкул", "kind": "village", "lat": 45.0900, "lon": 54.3167, "population": 5200, "note": "Бейнеуский район"},
    {"name": "Опорный", "kind": "village", "lat": 45.4333, "lon": 54.9833, "population": 2100, "note": "Железнодорожная станция"},
    {"name": "Тенге", "kind": "village", "lat": 43.3500, "lon": 52.9833, "population": 8900, "note": "Рядом с Жанаозеном"},
    {"name": "Мунайшы", "kind": "village", "lat": 43.4986, "lon": 52.1861, "population": 14500, "note": "Каракия, нефтяники"},
    {"name": "Кызылтобе", "kind": "village", "lat": 43.6167, "lon": 51.2333, "population": 6200, "note": "Микрорайон / посёлок Актау"},
    {"name": "Батыр", "kind": "village", "lat": 43.6056, "lon": 51.0833, "population": 3500, "note": "Запад Актау"},
    {"name": "Промзона Актау", "kind": "industrial", "lat": 43.6050, "lon": 51.2400, "population": 0, "note": "Склады и стройматериалы"},
    {"name": "Каражанбас", "kind": "industrial", "lat": 44.6167, "lon": 51.8667, "population": 0, "note": "Нефтяное месторождение"},
    {"name": "Месторождение Дунга", "kind": "industrial", "lat": 43.8667, "lon": 51.3500, "population": 0, "note": "Промка севернее Актау"},
    {"name": "Стройка Курык-Юг", "kind": "construction", "lat": 43.1550, "lon": 51.6800, "population": 0, "note": "Стройплощадка жилья и базы"},
    {"name": "Стройка Шетпе-Восток", "kind": "construction", "lat": 44.1600, "lon": 52.2300, "population": 0, "note": "Районная стройка"},
]

KEY_PAIRS = [
    ("Актау", "Жанаозен"),
    ("Актау", "Шетпе"),
    ("Актау", "Курык"),
    ("Актау", "Форт-Шевченко"),
    ("Актау", "Бейнеу"),
    ("Актау", "Жетыбай"),
    ("Актау", "Акшукур"),
    ("Жанаозен", "Бейнеу"),
    ("Жанаозен", "Мунайшы"),
    ("Жанаозен", "Тенге"),
    ("Жанаозен", "Шетпе"),
    ("Шетпе", "Бейнеу"),
    ("Шетпе", "Сай-Утес"),
    ("Бейнеу", "Боранкул"),
    ("Бейнеу", "Опорный"),
    ("Курык", "Сенек"),
    ("Курык", "Жетыбай"),
    ("Форт-Шевченко", "Таушык"),
    ("Форт-Шевченко", "Жынгылды"),
    ("Актау", "Каражанбас"),
    ("Актау", "Промзона Актау"),
    ("Курык", "Стройка Курык-Юг"),
    ("Шетпе", "Стройка Шетпе-Восток"),
    ("Жанаозен", "Актау"),
    ("Бейнеу", "Актау"),
    ("Шетпе", "Актау"),
    ("Курык", "Актау"),
    ("Мунайшы", "Актау"),
    ("Сай-Утес", "Шетпе"),
]


async def _cache_pair(db: Session, a: Settlement, b: Settlement) -> None:
    existing = (
        db.query(RouteCache)
        .filter(RouteCache.origin_id == a.id, RouteCache.dest_id == b.id)
        .one_or_none()
    )
    if existing:
        return
    fetched = await fetch_osrm_route(a.lon, a.lat, b.lon, b.lat)
    if fetched:
        dist, dur, geom = fetched["distance_km"], fetched["duration_s"], fetched["geometry"]
    else:
        air = haversine_km(a.lat, a.lon, b.lat, b.lon)
        dist, dur = air * 1.32, (air * 1.32 / 70) * 3600
        geom = interpolate_line(a.lat, a.lon, b.lat, b.lon, n=max(8, int(air / 12)))
    db.add(
        RouteCache(
            origin_id=a.id,
            dest_id=b.id,
            distance_km=round(dist, 1),
            duration_s=dur,
            geometry=dump_coords(geom),
        )
    )
    db.commit()


def ensure_schema(db: Session) -> None:
    bind = db.get_bind()
    user_cols = {c["name"] for c in inspect(bind).get_columns("users")}
    if "carrier_id" not in user_cols:
        db.execute(text("ALTER TABLE users ADD COLUMN carrier_id INTEGER"))
        db.commit()
        user_cols.add("carrier_id")
    if "password_plain" not in user_cols:
        db.execute(text("ALTER TABLE users ADD COLUMN password_plain VARCHAR(120)"))
        db.commit()
        db.execute(text("UPDATE users SET password_plain = 'demo' WHERE password_plain IS NULL"))
        db.commit()
    veh_cols = {c["name"] for c in inspect(bind).get_columns("vehicles")}
    if "driver_id" not in veh_cols:
        db.execute(text("ALTER TABLE vehicles ADD COLUMN driver_id INTEGER"))
        db.commit()
    if "active" not in veh_cols:
        db.execute(text("ALTER TABLE vehicles ADD COLUMN active BOOLEAN DEFAULT 1"))
        db.commit()
    if "is_active" not in user_cols:
        db.execute(text("ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT 1"))
        db.commit()
    sett_cols = {c["name"] for c in inspect(bind).get_columns("settlements")}
    if "sender_id" not in sett_cols:
        db.execute(text("ALTER TABLE settlements ADD COLUMN sender_id INTEGER"))
        db.commit()


def ensure_superadmin(db: Session) -> User:
    row = db.query(User).filter(User.email == SUPERADMIN_EMAIL).one_or_none()
    if row:
        if row.role != "superadmin":
            row.role = "superadmin"
        if not row.password_plain:
            row.password_plain = "demo"
        db.commit()
        return row
    row = User(
        email=SUPERADMIN_EMAIL,
        name="Супер-админ",
        role="superadmin",
        company="Caspian LogHub",
        phone="+7 7292 50 00 00",
        password_hash=hash_password("demo"),
        password_plain="demo",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def wipe_except_superadmin(db: Session) -> None:
    db.query(TrackPoint).delete()
    db.query(Order).delete()
    db.query(Vehicle).delete()
    db.query(HistoricalTrip).delete()
    db.query(User).filter(User.email != SUPERADMIN_EMAIL).delete()
    db.commit()
    ensure_superadmin(db)


async def seed_if_empty(db: Session) -> None:
    ensure_schema(db)
    if db.query(Settlement).count() > 0:
        ensure_superadmin(db)
        price_model.fit(db)
        return

    by_name: dict[str, Settlement] = {}
    for s in SETTLEMENTS:
        row = Settlement(**s)
        db.add(row)
        db.flush()
        by_name[row.name] = row
    db.commit()

    ensure_superadmin(db)

    for a_name, b_name in KEY_PAIRS:
        await _cache_pair(db, by_name[a_name], by_name[b_name])

    price_model.fit(db)

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.auth import hash_password
from app.models import HistoricalTrip, Order, RouteCache, Settlement, User, Vehicle
from app.services.geo import dump_coords, haversine_km, interpolate_line
from app.services.osrm import fetch_osrm_route
from app.services.pricing import price_model

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

USERS = [
    {"email": "sender@caspian.kz", "name": "Айгуль Нурланова", "role": "sender", "company": "Магазин «Степной»", "phone": "+7 7292 45 11 20"},
    {"email": "farm@caspian.kz", "name": "Ерлан Сагиев", "role": "sender", "company": "КХ «Бекет-Ата»", "phone": "+7 7292 45 11 21"},
    {"email": "build@caspian.kz", "name": "ТОО КаспийСтрой", "role": "sender", "company": "КаспийСтрой", "phone": "+7 7292 45 11 22"},
    {"email": "carrier@caspian.kz", "name": "Нурлан Жумабаев", "role": "carrier", "company": "КаспийТранс", "phone": "+7 7292 60 08 15"},
    {"email": "fleet@caspian.kz", "name": "Сауле Иманова", "role": "carrier", "company": "Мангистау Логистик", "phone": "+7 7292 60 08 16"},
    {"email": "superadmin@caspian.kz", "name": "Супер-админ", "role": "superadmin", "company": "Caspian LogHub", "phone": "+7 7292 50 00 00"},
    {"email": "dispatcher@caspian.kz", "name": "Админ акимата", "role": "admin", "company": "Акимат Мангистауской области", "phone": "+7 7292 50 00 01"},
    {"email": "driver@caspian.kz", "name": "Бауржан К.", "role": "driver", "company": "КаспийТранс", "phone": "+7 701 555 01 01"},
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


def _dist(db: Session, a: Settlement, b: Settlement) -> float:
    row = (
        db.query(RouteCache)
        .filter(RouteCache.origin_id == a.id, RouteCache.dest_id == b.id)
        .one_or_none()
    )
    if row:
        return row.distance_km
    return haversine_km(a.lat, a.lon, b.lat, b.lon) * 1.32


def ensure_rbac(db: Session) -> None:
    changed = False
    for u in db.query(User).filter(User.role == "dispatcher").all():
        u.role = "admin"
        changed = True
    if not db.query(User).filter(User.email == "superadmin@caspian.kz").one_or_none():
        db.add(
            User(
                email="superadmin@caspian.kz",
                name="Супер-админ",
                role="superadmin",
                company="Caspian LogHub",
                phone="+7 7292 50 00 00",
                password_hash=hash_password("demo"),
            )
        )
        changed = True
    admin = db.query(User).filter(User.email == "dispatcher@caspian.kz").one_or_none()
    if admin and admin.role != "admin":
        admin.role = "admin"
        changed = True
    if changed:
        db.commit()


async def seed_if_empty(db: Session) -> None:
    if db.query(Settlement).count() > 0:
        price_model.fit(db)
        ensure_rbac(db)
        return

    by_name: dict[str, Settlement] = {}
    for s in SETTLEMENTS:
        row = Settlement(**s)
        db.add(row)
        db.flush()
        by_name[row.name] = row

    users: dict[str, User] = {}
    for u in USERS:
        row = User(**u, password_hash=hash_password("demo"))
        db.add(row)
        db.flush()
        users[row.email] = row

    db.commit()

    for a_name, b_name in KEY_PAIRS:
        await _cache_pair(db, by_name[a_name], by_name[b_name])

    aktau = by_name["Актау"]
    zhana = by_name["Жанаозен"]
    shetpe = by_name["Шетпе"]
    kuryk = by_name["Курык"]
    beyneu = by_name["Бейнеу"]
    fort = by_name["Форт-Шевченко"]
    munay = by_name["Мунайшы"]
    senek = by_name["Сенек"]
    farm_from = by_name["Таушык"]
    build = by_name["Стройка Курык-Юг"]
    ind = by_name["Промзона Актау"]
    karazh = by_name["Каражанбас"]
    tenge = by_name["Тенге"]
    sai = by_name["Сай-Утес"]

    carrier = users["carrier@caspian.kz"]
    fleet = users["fleet@caspian.kz"]

    vehicles_spec = [
        ("12 MG 01", "tent", 12000, carrier, "Бауржан К.", aktau, 43.66, 51.20),
        ("07 MG 45", "reefer", 8000, carrier, "Серик Т.", zhana, 43.35, 52.85),
        ("18 MG 22", "dump", 20000, fleet, "Марат О.", kuryk, 43.19, 51.66),
        ("03 MG 90", "flatbed", 15000, fleet, "Асет Н.", shetpe, 44.14, 52.17),
        ("21 MG 11", "tent", 10000, carrier, "Даулет Е.", beyneu, 45.32, 55.19),
        ("09 MG 77", "reefer", 6000, fleet, "Жанар Б.", fort, 44.50, 50.27),
        ("15 MG 04", "tent", 14000, fleet, "Ильяс С.", munay, 43.50, 52.19),
        ("30 MG 63", "dump", 18000, carrier, "Кайрат Ж.", aktau, 43.62, 51.22),
    ]
    vehicles: list[Vehicle] = []
    for plate, kind, cap, owner, driver, home, lat, lon in vehicles_spec:
        v = Vehicle(
            plate=plate,
            kind=kind,
            capacity_kg=cap,
            owner_id=owner.id,
            driver_name=driver,
            status="idle",
            lat=lat,
            lon=lon,
            heading=90,
            home_id=home.id,
        )
        db.add(v)
        db.flush()
        vehicles.append(v)
    db.commit()

    sender = users["sender@caspian.kz"]
    farm = users["farm@caspian.kz"]
    build_u = users["build@caspian.kz"]

    def mk_hist(a: Settlement, b: Settlement, cargo: str, w: int, empty: bool) -> None:
        d = _dist(db, a, b)
        price = int(8500 + 46 * d + 0.12 * w)
        if cargo == "perishable":
            price = int(price * 1.22)
        if cargo == "fuel":
            price = int(price * 1.3)
        db.add(
            HistoricalTrip(
                origin_id=a.id,
                dest_id=b.id,
                cargo_type=cargo,
                weight_kg=w,
                distance_km=d,
                price_kzt=price,
                empty_return=empty,
            )
        )

    hist_pairs = [
        (aktau, zhana, "general", 4200, True),
        (aktau, shetpe, "general", 2100, True),
        (aktau, kuryk, "construction", 12000, True),
        (aktau, beyneu, "perishable", 3500, True),
        (zhana, aktau, "general", 2800, False),
        (shetpe, aktau, "livestock", 900, True),
        (kuryk, senek, "general", 1600, True),
        (fort, aktau, "perishable", 800, True),
        (beyneu, sai, "general", 2400, True),
        (ind, build, "construction", 15000, True),
        (karazh, aktau, "fuel", 5000, False),
        (tenge, zhana, "general", 1100, False),
        (munay, aktau, "general", 3300, True),
        (aktau, farm_from, "perishable", 600, True),
        (shetpe, beyneu, "construction", 8000, True),
        (aktau, fort, "general", 1400, True),
        (zhana, munay, "construction", 9000, False),
        (kuryk, aktau, "general", 2500, False),
    ]
    for args in hist_pairs:
        mk_hist(*args)
    db.commit()
    price_model.fit(db)

    def rec(a: Settlement, b: Settlement, cargo: str, w: int) -> tuple[float, int]:
        d = _dist(db, a, b)
        return d, price_model.predict(d, w, cargo)

    open_jobs = [
        (sender, aktau, shetpe, "general", "Продукты в магазин Шетпе", 1800),
        (sender, aktau, zhana, "perishable", "Молочка и овощи в Жанаозен", 2400),
        (farm, farm_from, aktau, "perishable", "Баранина и курт в Актау", 700),
        (build_u, ind, build, "construction", "Цемент и арматура на стройку Курык", 14000),
        (sender, beyneu, aktau, "general", "Промтовары Бейнеу → Актау (обратка)", 3200),
        (build_u, shetpe, by_name["Стройка Шетпе-Восток"], "construction", "Песок и блоки", 16000),
        (farm, kuryk, senek, "general", "Товары первой необходимости в Сенек", 1100),
        (sender, zhana, aktau, "general", "Возврат тары и запчастей", 900),
        (sender, fort, aktau, "perishable", "Рыба Форт-Шевченко → Актау", 450),
        (build_u, karazh, aktau, "fuel", "ГСМ с Каражанбаса", 4000),
    ]
    for snd, o, d, cargo, title, w in open_jobs:
        dist, rec_price = rec(o, d, cargo, w)
        db.add(
            Order(
                sender_id=snd.id,
                origin_id=o.id,
                dest_id=d.id,
                cargo_type=cargo,
                cargo_title=title,
                weight_kg=w,
                price_offered=rec_price,
                price_recommended=rec_price,
                status="open",
                distance_km=dist,
            )
        )

    # Active demo trip: Aktau -> Zhanaozen on vehicle 0
    dist, rec_price = rec(aktau, zhana, "general", 5000)
    active = Order(
        sender_id=sender.id,
        origin_id=aktau.id,
        dest_id=zhana.id,
        cargo_type="general",
        cargo_title="Смешанный груз магазинам Жанаозена",
        weight_kg=5000,
        price_offered=rec_price,
        price_recommended=rec_price,
        status="transit",
        carrier_id=carrier.id,
        vehicle_id=vehicles[0].id,
        distance_km=dist,
        taken_at=datetime.utcnow(),
    )
    db.add(active)
    db.flush()
    vehicles[0].current_order_id = active.id
    vehicles[0].status = "enroute"

    dist2, rec2 = rec(kuryk, senek, "construction", 11000)
    active2 = Order(
        sender_id=build_u.id,
        origin_id=kuryk.id,
        dest_id=senek.id,
        cargo_type="construction",
        cargo_title="Стройматериалы в Сенек",
        weight_kg=11000,
        price_offered=rec2,
        price_recommended=rec2,
        status="transit",
        carrier_id=fleet.id,
        vehicle_id=vehicles[2].id,
        distance_km=dist2,
        taken_at=datetime.utcnow(),
    )
    db.add(active2)
    db.flush()
    vehicles[2].current_order_id = active2.id
    vehicles[2].status = "enroute"

    # Delivered history for analytics
    dist3, rec3 = rec(aktau, kuryk, "construction", 13000)
    db.add(
        Order(
            sender_id=build_u.id,
            origin_id=aktau.id,
            dest_id=kuryk.id,
            cargo_type="construction",
            cargo_title="Партия кирпича на Курык",
            weight_kg=13000,
            price_offered=rec3,
            price_recommended=rec3,
            status="delivered",
            carrier_id=fleet.id,
            vehicle_id=vehicles[2].id,
            distance_km=dist3,
            empty_km_saved=0,
            delivered_at=datetime.utcnow(),
        )
    )
    dist4, rec4 = rec(zhana, aktau, "general", 2600)
    db.add(
        Order(
            sender_id=sender.id,
            origin_id=zhana.id,
            dest_id=aktau.id,
            cargo_type="general",
            cargo_title="Обратная загрузка из Жанаозена",
            weight_kg=2600,
            price_offered=rec4,
            price_recommended=rec4,
            status="delivered",
            carrier_id=carrier.id,
            vehicle_id=vehicles[1].id,
            distance_km=dist4,
            empty_km_saved=dist4,
            is_backhaul=True,
            delivered_at=datetime.utcnow(),
        )
    )
    db.commit()
    price_model.fit(db)
    ensure_rbac(db)

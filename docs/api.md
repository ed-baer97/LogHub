# HTTP API

База: `/api`. Интерактивно: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

Авторизация: заголовок `Authorization: Bearer <token>` (кроме login, demo, health). SSE допускает `?token=`.

Ответы ошибок FastAPI: `{"detail": "…"}`. Фронт показывает `detail` через `formatError`.

---

## Служебные

### `GET /api/health`

Без авторизации.

```json
{ "ok": true, "name": "Caspian LogHub" }
```

---

## Auth `/api/auth`

### `GET /api/auth/demo`

Список демо-учёток для лендинга: сейчас только супер-админ.

### `POST /api/auth/login`

```json
{ "email": "superadmin@caspian.kz", "password": "demo" }
```

Ответ `TokenOut`: `{ "token": "…", "user": UserOut }`.

| Код | |
|-----|--|
| 401 | неверный логин/пароль |
| 403 | учётка заблокирована |

### `GET /api/auth/me`

Текущий пользователь.

---

## Admin `/api/admin`

Staff: супер-админ и админ. Создание и правки ограничены матрицей ролей.

### `GET /api/admin/role-options`

`[{ "id": "admin", "label": "Админ" }]` или отправитель/перевозчик — в зависимости от актора.

### `GET /api/admin/users`

Без себя. Админ видит только `sender` и `carrier`. Поля пароля нет.

### `POST /api/admin/users`

```json
{
  "email": "a@x.kz",
  "name": "Имя",
  "role": "admin",
  "company": null,
  "phone": null,
  "password": "demo",
  "carrier_id": null
}
```

`role` по умолчанию `sender`. Ответ может содержать `initial_password`.

### `PATCH /api/admin/users/{user_id}`

Частично: `name`, `company`, `phone`, `role`, `is_active`. Нельзя менять себя этим эндпоинтом.

### `POST /api/admin/users/{user_id}/block`  
### `POST /api/admin/users/{user_id}/unblock`

Только **админ** (не супер-админ) — отправители и перевозчики.

### `POST /api/admin/users/{user_id}/reset-password`

```json
{ "password": "demo" }
```

Только админ. Ответ с `initial_password`.

---

## Geo `/api/geo`

Видимость пунктов и бортов — [роли](roles-and-access.md).

### `GET /api/geo/settlements`

### `POST /api/geo/settlements` — отправитель

```json
{
  "name": "Склад у трассы",
  "kind": "village",
  "lat": 43.65,
  "lon": 51.19,
  "population": 0,
  "note": null
}
```

`kind`: `city` | `village` | `industrial` | `construction`. Имя уникально (409).

### `PATCH /api/geo/settlements/{id}`  
### `DELETE /api/geo/settlements/{id}`

Только своя точка. Удаление 409, если пункт в заявках или как `home` борта. Сдвиг координат чистит `route_cache`.

### `GET /api/geo/vehicles`

Борта в зоне видимости. `live` вычисляется по `live_until`.

---

## Orders `/api/orders`

### `GET /api/orders/quote?origin_id=&dest_id=&weight_kg=1000&cargo_type=general`

Котировка: км, минуты, цена, geometry. 400 если origin = dest.

### `GET /api/orders`

Опционально `?status=open`. Список по правилам видимости.

### `GET /api/orders/hints/backhaul`

Перевозчик. Попутки для своего активного парка vs открытые заявки.

### `GET /api/orders/hints/leg?origin_id=&dest_id=`

Перевозчик или отправитель. Попутки на конкретном плече.

### `GET /api/orders/{id}`  
### `GET /api/orders/{id}/route`

`{ "geometry": [[lon, lat], …], "distance_km": 120.5 }` — пустая geometry, если кэша нет.

### `POST /api/orders` — отправитель

```json
{
  "origin_id": 1,
  "dest_id": 2,
  "cargo_type": "general",
  "cargo_title": "Песок 20 мешков",
  "weight_kg": 1000,
  "price_offered": null
}
```

`weight_kg`: `> 0` и `< 40000`. Без `price_offered` подставляется рекомендация.

### `PATCH /api/orders/{id}` — только `open`

Поля `OrderUpdate`. Смена точек/веса/типа пересчитывает дистанцию и рекомендацию.

### `POST /api/orders/{id}/cancel`  
### `DELETE /api/orders/{id}` — только `open`

Cancel: статусы из `CANCELLABLE`. Delete: `{ "ok": true }`.

### `POST /api/orders/{id}/take` — перевозчик

Тело опционально `{ "vehicle_id": null }` (id машины на этом шаге не используется).

### `POST /api/orders/{id}/assign` — перевозчик

```json
{ "vehicle_id": 3 }
```

Допустимо в `taken` и `assigned` (переназначение).

---

## Fleet `/api/fleet` — только перевозчик

### `GET /api/fleet/drivers`  
### `GET /api/fleet/vehicles`

Свои водители / борт.

### `POST /api/fleet/borts`

Создаёт водителя и машину одной операцией.

```json
{
  "plate": "A001AKT",
  "kind": "tent",
  "capacity_kg": 10000,
  "home_id": 1,
  "driver_name": "Серик",
  "driver_email": "serik@carrier.kz",
  "driver_phone": "+7701…",
  "driver_password": "demo"
}
```

`kind`: `tent` | `reefer` | `dump` | `flatbed`. `capacity_kg` `< 60000`. `home_id` — пункт каталога.

409: госномер или email заняты. Ответ с `initial_password`.

### `PATCH /api/fleet/borts/{vehicle_id}`

Машина, база, водитель (имя, email, телефон, пароль, `driver_active`), флаг `active`.

Нельзя отключить борт или заблокировать водителя в рейсе (409).

### `POST /api/fleet/borts/{vehicle_id}/disable`

`active = false`, если нет текущего рейса.

---

## Tracking `/api/tracking`

Тело шагов водителя: `{ "vehicle_id": 3 }`.

| Метод | Кто | Назначение |
|-------|-----|------------|
| `GET /stream` | любой залогиненный | SSE |
| `POST /arrive` | водитель | `assigned` → `arrived` |
| `POST /start-loading` | водитель | `arrived` → `loading` |
| `POST /start-route` | водитель | `loading` → `transit` + навигация |
| `POST /complete-route` | водитель | `transit` → `delivered` |
| `POST /stop-route` | водитель | остановить симулятор, статус заявки `transit` |
| `POST /ping` | водитель | `{ "vehicle_id", "lat", "lon" }` — живой GPS |
| `GET /{vehicle_id}/trail?limit=80` | кто видит борт | точки следа |

409, если нет рейса или этап не тот. 403, если не водитель.

---

## Analytics `/api/analytics`

### `GET /api/analytics/summary` — staff

Счётчики пунктов, бортов, открытых / в пути / доставленных заявок, загруженные км, экономия порожняка и топлива, топ коридоров.

Константы: дизель **32 л / 100 км**, **295 ₸/л**, порожний пробег без платформы **40%**.

У админа (не супер-админ) из ответа убираются `empty_km_without_platform`, `empty_share_history`; `assumptions` пустой; `live_gps` = `null`.

---

## DTO (основные)

**UserOut:** `id`, `email`, `name`, `role`, `company`, `phone`, `carrier_id`, `is_active`, опционально `initial_password`.

**OrderOut:** плюс имена/координаты пунктов, `sender_name`, `plate`.

**VehicleOut:** плюс `live`, контакты водителя, `driver_active`, опционально `initial_password`.

**MatchHint:** `order_id`, `detour_km`, `empty_km_saved`, `fuel_saved_l`, `money_saved_kzt`, `reason`, иногда `loaded_km`.

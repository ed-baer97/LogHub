# Архитектура

LogHub — монорепозиторий: FastAPI + React. Один процесс API, без очереди задач. Движение борта — asyncio-задача на конкретный рейс.

## Стек

| Слой | Технологии |
|------|------------|
| Backend | FastAPI 0.115, SQLAlchemy 2, Pydantic 2, uvicorn |
| БД | PostgreSQL 16 (Docker) или SQLite локально, Alembic |
| Кэш / шина | Redis 7 (Docker); локально без `REDIS_URL` — in-memory |
| Frontend | React 18, Vite 6, TypeScript, MapLibre GL, react-router-dom 6 |
| Карта | тайлы OSM, маршруты публичного OSRM (`router.project-osrm.org`) |
| Realtime | Server-Sent Events, Redis pub/sub (`EventBus`) |
| Продакшен | Docker Compose: postgres + redis + backend + nginx |

Очереди Celery нет: симуляция едет внутри того же процесса, что и HTTP.

## Компоненты

```
браузер ──► Vite (dev) / nginx (prod)
              │  /api  → FastAPI :8000
              │  SSE   → GET /api/tracking/stream
              ▼
           FastAPI
              ├── JWT (HS256), bcrypt
              ├── auth, admin, geo, orders, fleet, tracking, analytics
              ├── access.py  — RBAC + ownership
              ├── EventBus   — Redis pub/sub или память
              ├── OSRM + RouteCache
              └── simulator  — asyncio follow-loop на рейс
              ▼
           PostgreSQL / SQLite     Redis (опционально)
```

## Дерево репозитория

```
backend/app/
  main.py                 FastAPI, CORS, lifespan (seed; create_all только в тестах)
  config.py               DATABASE_URL, SECRET_KEY, REDIS_URL, OSRM, скорость сима
  auth.py                 JWT, bcrypt (старый SHA-256 принимается и перехешируется)
  access.py               роли, видимость, 404 на чужие объекты
  roles.py                константы ролей, кого можно создать
  models.py               SQLAlchemy-модели
  schemas.py              Pydantic DTO
  seed.py                 пункты Мангистау, супер-админ, кэш ключевых пар
  routers/                auth, admin, geo, orders, fleet, tracking, analytics
  services/
    events.py             шина SSE
    osrm.py               маршрут + fallback по прямой
    matching.py           попутки / обратная загрузка
    pricing.py            рекомендация цены
    simulator.py          движение по polyline
    fleet.py              борт ↔ водитель
    geo.py                haversine, проекция на линию
backend/alembic/          миграции
backend/tests/            матрица доступа
frontend/src/
  pages/                  Landing, Sender, Carrier, Driver, Dispatcher
  components/             Layout, MapView, FleetBoard, OrderPanel, Toast
docker-compose.yml
scripts/deploy-linux.sh
```

## Процессы при старте

1. Вне тестов схема накатывается Alembic (`alembic upgrade head` в Docker CMD и локально).
2. Pytest: `TESTING=1` → `create_all` на временный SQLite, сид не гоняется.
3. `ensure_schema` — лёгкие `ALTER` для старых БД (в том числе сброс `password_plain`).
4. Если справочник пуст — сид пунктов, супер-админ, кэш маршрутов по ключевым парам (Актау–Жанаозен и др.).
5. `price_model.fit` — линейная регрессия по `historical_trips` или запасные коэффициенты.
6. Если задан `REDIS_URL` — слушатель pub/sub для SSE.

## Realtime

`GET /api/tracking/stream` — SSE. Токен: заголовок `Authorization: Bearer …` или query `?token=`.

При `REDIS_URL` публикация идёт в канал `loghub:events`; каждый процесс API раздаёт локальным подписчикам. Без Redis (pytest, локальный uvicorn) — очередь в памяти процесса.

События:

| `type` | Когда | Содержимое |
|--------|--------|------------|
| `hello` | подключение | `{}` |
| `fleet` | снимок парка | `vehicles[]` |
| `vehicle` | ping / живая точка | координаты одного борта |
| `order` / `order_new` | смена заявки | `id`, `status` |

Перед отправкой событие режется в `filter_fleet_event`: клиент видит только свои борты и заявки. Админ и супер-админ видят всё.

Очередь подписчика — 200 событий; при переполнении клиент отключается (нужно переподключиться).

## Маршруты

1. Ищем пару origin/dest в `route_cache`.
2. Иначе запрос к OSRM (`overview=full`, GeoJSON), таймаут 8 с.
3. Если OSRM недоступен — прямая с коэффициентом 1.32 и интерполяцией точек.

Смена координат своей точки отправителя сбрасывает кэш маршрутов, где эта точка — origin или dest.

## Движение борта

Маршрут и анимация включаются только на этапе `transit` (кнопка водителя «Выехать»).

- Polyline кладётся в память (`_plan`).
- Цикл тикает каждые `sim_tick_s` (1.5 с) со скоростью `sim_speed_kmh` (420 км/ч — ускорение для демо).
- Точки пишутся в `track_points` с `source=nav`.
- Если водитель шлёт GPS (`POST /api/tracking/ping`), `live_until` держится 45 с и симулятор не двигает борт.
- По концу polyline заявка становится `delivered`, борт — `idle` (то же делает «Завершить рейс»).

GPS с телефона необязателен. Follow-loop живёт в том процессе API, где нажали «Выехать» — несколько воркеров пока не включают.

## Аутентификация

JWT HS256, `sub` = id пользователя, срок `JWT_EXPIRE_HOURS` (по умолчанию 7 суток). Пароль: bcrypt. Старые SHA-256 хеши (`SECRET_KEY:password`) принимаются и при логине переписываются в bcrypt.

Фронт хранит токен и пользователя в `localStorage` (`caspian_token`, `caspian_user`).

Одноразовый пароль при создании/сбросе уходит в поле ответа `initial_password`, в БД не хранится.

## Границы MVP

Нет: платежи, ЭЦП / SMS, нативное приложение, скоринг перевозчиков, тахографы, Celery, горизонтальное масштабирование API (симулятор в процессе).

Очередь работ: [масштабирование бэкенда](scaling.md). Этап 1 (Redis, JWT, Alembic) уже в коде.

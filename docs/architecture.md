# Архитектура

LogHub — монорепозиторий: FastAPI + React. Навигация рейса — ARQ-воркер (при `REDIS_URL`); в тестах — asyncio в процессе API.

## Стек

| Слой | Технологии |
|------|------------|
| Backend | FastAPI 0.115, SQLAlchemy 2, Pydantic 2, gunicorn + uvicorn workers |
| БД | PostgreSQL 16 (Docker) или SQLite локально, Alembic, PgBouncer |
| Кэш / шина | Redis 7 (Docker); локально без `REDIS_URL` — in-memory |
| Frontend | React 18, Vite 6, TypeScript, MapLibre GL, react-router-dom 6 |
| Карта | тайлы OSM, маршруты OSRM (в Docker — свой `osrm`, локально по умолчанию публичный) |
| Realtime | Server-Sent Events, Redis pub/sub (`EventBus`) |
| Продакшен | Docker Compose: postgres + pgbouncer + redis + 2×backend + worker + gateway + nginx |

Симуляция: ARQ (`arq app.worker.WorkerSettings`). Без Redis — задача в процессе API (pytest).

## Компоненты

```
браузер ──► Vite (dev) / nginx :80 (prod)
              │  /api  → gateway :8000 / frontend nginx → backend + backend-2
              │  SSE   → GET /api/tracking/stream (без буфера)
              ▼
           FastAPI (gunicorn, 2 реплики)
              ├── JWT (HS256), bcrypt
              ├── auth, admin, geo, orders, fleet, tracking, analytics
              ├── access.py  — RBAC + ownership
              ├── EventBus   — каналы Redis или память
              ├── live.py    — позиция в Redis, flush треков
              ├── OSRM + RouteCache (Redis-кэш quote 45 с)
              └── simulator  — план рейса; follow-loop в ARQ
              ▼
           PgBouncer → PostgreSQL     Redis     ARQ worker     OSRM
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
    events.py             шина SSE (каналы staff/fleet/sender/orders)
    live.py               живая GPS-точка, TTL треков
    cache.py              Redis GET/SET JSON (quote, analytics)
    metrics.py            Prometheus + счётчик SSE
    tracks.py             месячные партиции track_points
    osrm.py               маршрут + fallback по прямой
    matching.py           bbox, затем попутки / обратная загрузка
    pricing.py            рекомендация цены
    simulator.py          старт рейса, payload борта
    fleet.py              борт ↔ водитель
    geo.py                haversine, проекция на линию
  worker.py               ARQ: follow, prune, downsample, prefetch OSRM, партиции
  paging.py               limit/offset для списков
backend/alembic/          миграции
backend/tests/            матрица доступа
frontend/src/
  pages/                  Landing, Sender, Carrier, Driver, Dispatcher
  components/             Layout, MapView, FleetBoard, OrderPanel, Toast
docker-compose.yml
deploy/nginx-gateway.conf
scripts/deploy-linux.sh
scripts/prepare-osrm.sh
scripts/backup-postgres.sh
```

## Процессы при старте

1. Вне тестов схема накатывается Alembic (сервис `migrate` в Docker; локально `alembic upgrade head`).
2. Pytest: `TESTING=1` → `create_all` на временный SQLite, сид не гоняется.
3. `ensure_schema` — лёгкие `ALTER` для старых БД (в том числе сброс `password_plain`).
4. Если справочник пуст — сид пунктов, супер-админ, кэш маршрутов по ключевым парам (Актау–Жанаозен и др.).
5. `price_model.fit` — линейная регрессия по `historical_trips` или запасные коэффициенты.
6. При `REDIS_URL` SSE слушает каналы роли; навигация ставится в ARQ.

## Realtime

`GET /api/tracking/stream` — SSE. Токен: заголовок `Authorization: Bearer …` или query `?token=`.

Первое событие после `hello` — снимок `fleet` (видимые борты, координаты из Redis если есть). Дальше только `vehicle` и `order`. Фильтр по `owner_id` / `driver_id` / `sender_id` без запроса в БД на каждый тик.

Каналы Redis: `loghub:staff`, `loghub:fleet:{carrier_id}`, `loghub:sender:{sender_id}`, `loghub:orders`. Без Redis — те же каналы в памяти процесса.

События:

| `type` | Когда | Содержимое |
|--------|--------|------------|
| `hello` | подключение | `{}` |
| `fleet` | снимок парка | `vehicles[]` |
| `vehicle` | ping / живая точка | координаты одного борта |
| `order` / `order_new` | смена заявки | `id`, `status` |

Очередь подписчика — 200 событий; при переполнении клиент отключается (нужно переподключиться).

## Маршруты

1. Ищем пару origin/dest в `route_cache`.
2. Иначе запрос к OSRM (`overview=full`, GeoJSON), таймаут 8 с.
3. Если OSRM недоступен — прямая с коэффициентом 1.32 и интерполяцией точек.

В Compose `OSRM_URL=http://osrm:5000`. Пока граф не собран (`scripts/prepare-osrm.sh`), контейнер `osrm` не слушает порт — срабатывает шаг 3. Локальный uvicorn без Compose по умолчанию ходит на `router.project-osrm.org`.

Смена координат своей точки отправителя сбрасывает кэш маршрутов, где эта точка — origin или dest.

## Движение борта

Маршрут и анимация включаются только на этапе `transit` (кнопка водителя «Выехать»).

- План в Redis (`nav:plan:{id}`) или в памяти без Redis.
- Цикл (ARQ `follow_vehicle` или asyncio) тикает каждые `sim_tick_s` (1.5 с).
- Живая точка: Redis `vehicle:pos:{id}`, TTL 60 с. В `track_points` — не чаще чем раз в `TRACK_FLUSH_S` (20 с).
- Ping чаще 3 с → 429; позиция в Redis всё равно обновляется. Симулятор не двигает борт, пока GPS live.
- По концу polyline заявка становится `delivered`, борт — `idle` (то же делает «Завершить рейс»).

GPS с телефона необязателен. При Redis follow-loop в отдельном контейнере `worker`.

## Аутентификация

JWT HS256, `sub` = id пользователя, срок `JWT_EXPIRE_HOURS` (по умолчанию 7 суток). Пароль: bcrypt. Старые SHA-256 хеши (`SECRET_KEY:password`) принимаются и при логине переписываются в bcrypt.

Фронт хранит токен и пользователя в `localStorage` (`caspian_token`, `caspian_user`).

Одноразовый пароль при создании/сбросе уходит в поле ответа `initial_password`, в БД не хранится.

## Границы MVP

Нет: платежи, ЭЦП / SMS, нативное приложение, скоринг перевозчиков, тахографы, S3 для документов.

Очередь работ: [масштабирование бэкенда](scaling.md). Этапы 1–4 в коде.

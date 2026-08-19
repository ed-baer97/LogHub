# Архитектура

LogHub — монорепозиторий: FastAPI + React. Один процесс API, без Celery и Redis. Движение борта — asyncio-задача на конкретный рейс.

## Стек

| Слой | Технологии |
|------|------------|
| Backend | FastAPI 0.115, SQLAlchemy 2, Pydantic 2, uvicorn |
| БД | PostgreSQL 16 (Docker) или SQLite локально |
| Frontend | React 18, Vite 6, TypeScript, MapLibre GL, react-router-dom 6 |
| Карта | тайлы OSM, маршруты публичного OSRM (`router.project-osrm.org`) |
| Realtime | Server-Sent Events, in-memory `EventBus` |
| Продакшен | Docker Compose: postgres + backend + nginx |

Очередей нет: симуляция едет внутри того же процесса, что и HTTP.

## Компоненты

```
браузер ──► Vite (dev) / nginx (prod)
              │  /api  → FastAPI :8000
              │  SSE   → GET /api/tracking/stream
              ▼
           FastAPI
              ├── auth, admin, geo, orders, fleet, tracking, analytics
              ├── access.py  — RBAC + ownership
              ├── EventBus   — публикация fleet / order
              ├── OSRM + RouteCache
              └── simulator  — asyncio follow-loop на рейс
              ▼
           SQLite или PostgreSQL
```

## Дерево репозитория

```
backend/app/
  main.py                 FastAPI, CORS, lifespan (create_all + seed)
  config.py               DATABASE_URL, SECRET_KEY, OSRM, скорость сима
  auth.py                 SHA-256 пароля, in-memory сессии
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
backend/tests/            матрица доступа
frontend/src/
  pages/                  Landing, Sender, Carrier, Driver, Dispatcher
  components/             Layout, MapView, FleetBoard, OrderPanel, Toast
docker-compose.yml
scripts/deploy-linux.sh
```

## Процессы при старте

1. `Base.metadata.create_all` — таблицы.
2. `ensure_schema` — лёгкие `ALTER TABLE` для старых SQLite.
3. Если справочник пуст — сид пунктов, супер-админ, кэш маршрутов по ключевым парам (Актау–Жанаозен и др.).
4. `price_model.fit` — линейная регрессия по `historical_trips` или запасные коэффициенты.

Переменная `TESTING=1` отключает сид (фикстуры pytest сами кладут данные).

## Realtime

`GET /api/tracking/stream` — SSE. Токен: заголовок `Authorization: Bearer …` или query `?token=`.

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

GPS с телефона необязателен.

## Аутентификация

Не JWT. `secrets.token_urlsafe(24)` кладётся в словарь `SESSIONS` в памяти. Пароль: SHA-256 от `{SECRET_KEY}:{password}`.

Следствия: рестарт API сбрасывает всех; несколько инстансов uvicorn не шарят сессии.

Фронт хранит токен и пользователя в `localStorage` (`caspian_token`, `caspian_user`).

## Границы MVP

Нет: платежи, ЭЦП / SMS, нативное приложение, скоринг перевозчиков, тахографы, Celery/Redis, горизонтальное масштабирование API.

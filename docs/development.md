# Разработка

## Окружение бэкенда

`backend/app/config.py` (и `.env` в `backend/`):

| Переменная | По умолчанию | Смысл |
|------------|----------------|--------|
| `DATABASE_URL` | `sqlite:///./caspian.db` | PostgreSQL: `postgresql+psycopg://caspian:caspian@localhost:5432/caspian` |
| `SECRET_KEY` | `caspian-hackathon-secret` | JWT (в Docker — из `.env`, обязателен) |
| `SUPERADMIN_PASSWORD` | `demo` | пароль сида супер-админа (в Docker — из `.env`) |
| `JWT_EXPIRE_HOURS` | `168` | срок токена (7 суток) |
| `REDIS_URL` | пусто | `redis://localhost:6379/0`; пусто = SSE и навигация в памяти |
| `PING_MIN_INTERVAL_S` | `3` | лимит GPS ping |
| `TRACK_FLUSH_S` | `20` | как часто писать точку в Postgres |
| `TRACK_RETENTION_DAYS` | `14` | cron воркера чистит старые треки |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | `10` / `20` | пул SQLAlchemy (не SQLite); в Compose 5 / 10 за PgBouncer |
| `CACHE_TTL_S` | `45` | Redis-кэш quote и analytics summary |
| `WEB_CONCURRENCY` | `2` | воркеры gunicorn в Docker |
| `CORS_ORIGINS` | localhost:5173, :80, … | список через запятую |
| `OSRM_URL` | `https://router.project-osrm.org` | в Compose — `http://osrm:5000` |
| `SIM_SPEED_KMH` | `420` | ускорение демо |
| `SIM_TICK_S` | `1.5` | шаг симулятора |

Compose задаёт `DATABASE_URL` на PgBouncer, `REDIS_URL`, `OSRM_URL=http://osrm:5000`, `SECRET_KEY`, `SUPERADMIN_PASSWORD`, `CORS_ORIGINS`, `WEB_CONCURRENCY` из корневого `.env` (см. `.env.example`).

Не коммитить `.env` и `*.db` (см. `.gitignore`).

Локальная схема:

```bash
cd backend
alembic upgrade head
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Зависимости

Backend: FastAPI, uvicorn, gunicorn (Docker), SQLAlchemy, Alembic, ARQ, psycopg, PyJWT, bcrypt, redis, pydantic-settings, httpx, numpy, prometheus_client, pytest.

Frontend: react, react-dom, react-router-dom, maplibre-gl. Скрипты: `npm run dev` / `build` / `preview`.

Python-пакеты приложения живут в `backend/app/` — запуск uvicorn и alembic из каталога `backend`.

## Тесты

```bash
cd backend
python -m pytest
```

`TESTING=1` и временный SQLite в `conftest.py`. Сид и Redis при тестах не гоняются (`create_all` в lifespan).

`tests/test_access.py` проверяет:

- закрытые списки без токена (401);
- супер-админ не создаёт отправителя, админ не создаёт админа;
- чужая заявка — 404, в том числе cancel;
- take только `open`, второй take 409, чужой перевозчик 404;
- чужой борт 404; отправитель не видит чужой парк до назначения;
- этапы только водитель: arrive → loading → start-route → complete;
- skip `assigned` → `transit` = 409;
- delete только `open`; cancel `assigned` освобождает борт;
- правка email/пароля водителя и блокировка входа;
- заявки создаёт только отправитель.

`tests/test_auth.py` — JWT при логине и перехеш старого SHA-256 в bcrypt.
`tests/test_live.py` — фильтр SSE по роли, интервал ping/flush треков.
`tests/test_stage3.py` — пагинация списков, bbox-матчинг, SQL-аналитика, downsample треков.
`tests/test_stage4.py` — `/metrics`, `/api/analytics/ops`, счётчик SSE, партиции на SQLite не создаются.

После смены access/роутов имеет смысл прогнать этот файл.

## Соглашения, которые легко сломать

- **404 на чужие id** — не заменять на 403 в `get_order_or_404` / `get_owned_*`.
- **Не пропускать статусы** — `_advance` сравнивает expected.
- **Борт в UI = `vehicles` в БД.**
- **Симулятор:** при Redis — ARQ worker; в pytest — asyncio в API.
- **Создание борта = создание водителя.** Один водитель — один борт (`attach_driver`).
- Роль `dispatcher` нормализуется в `admin`.
- Пароль в ответе только как `initial_password` при создании/сбросе, не из БД.

## Что сознательно не сделано

Платежи, ЭЦП/SMS, натив, скоринг, тахографы, S3.

Когда это понадобится и в каком порядке: [масштабирование бэкенда](scaling.md).

## Полезные URL

| | |
|--|--|
| UI | http://localhost:5173 |
| OpenAPI | http://127.0.0.1:8000/docs |
| Health | http://127.0.0.1:8000/api/health |

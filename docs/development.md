# Разработка

## Окружение бэкенда

`backend/app/config.py` (и `.env` в `backend/`):

| Переменная | По умолчанию | Смысл |
|------------|----------------|--------|
| `DATABASE_URL` | `sqlite:///./caspian.db` | PostgreSQL: `postgresql+psycopg://caspian:caspian@localhost:5432/caspian` |
| `SECRET_KEY` | `caspian-hackathon-secret` | JWT и бывший SHA-256 |
| `JWT_EXPIRE_HOURS` | `168` | срок токена (7 суток) |
| `REDIS_URL` | пусто | `redis://localhost:6379/0`; пусто = шина SSE в памяти |
| `CORS_ORIGINS` | localhost:5173, :80, … | список через запятую; в `main` дополнительно `*` |
| `OSRM_URL` | `https://router.project-osrm.org` | |
| `SIM_SPEED_KMH` | `420` | ускорение демо |
| `SIM_TICK_S` | `1.5` | шаг симулятора |

Compose задаёт `DATABASE_URL` на сервис `postgres`, `REDIS_URL`, `SECRET_KEY`, `CORS_ORIGINS`.

Не коммитить `.env` и `*.db` (см. `.gitignore`).

Локальная схема:

```bash
cd backend
alembic upgrade head
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Зависимости

Backend: FastAPI, uvicorn, SQLAlchemy, Alembic, psycopg, PyJWT, bcrypt, redis, pydantic-settings, httpx, numpy, pytest.

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

После смены access/роутов имеет смысл прогнать этот файл.

## Соглашения, которые легко сломать

- **404 на чужие id** — не заменять на 403 в `get_order_or_404` / `get_owned_*`.
- **Не пропускать статусы** — `_advance` сравнивает expected.
- **Борт в UI = `vehicles` в БД.**
- **Симулятор в RAM** — не включать несколько воркеров, пока follow-loop в процессе API.
- **Создание борта = создание водителя.** Один водитель — один борт (`attach_driver`).
- Роль `dispatcher` нормализуется в `admin`.
- Пароль в ответе только как `initial_password` при создании/сбросе, не из БД.

## Что сознательно не сделано

Платежи, ЭЦП/SMS, натив, скоринг, тахографы, Celery, несколько инстансов API, GPS в Redis.

Когда это понадобится и в каком порядке: [масштабирование бэкенда](scaling.md).

## Полезные URL

| | |
|--|--|
| UI | http://localhost:5173 |
| OpenAPI | http://127.0.0.1:8000/docs |
| Health | http://127.0.0.1:8000/api/health |

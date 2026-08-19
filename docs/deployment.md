# Продакшен

Стек: PostgreSQL 16, PgBouncer (transaction), Redis 7, две реплики FastAPI (gunicorn), ARQ-воркер, nginx со статикой Vite, свой OSRM. Хост: порт **80** (UI). Postgres и API gateway слушают только localhost (`127.0.0.1:5432`, `127.0.0.1:8000`).

Скопируйте `.env.example` в `.env` и задайте секреты **до** `docker compose up`.

```bash
cp .env.example .env
# SECRET_KEY, POSTGRES_PASSWORD, SUPERADMIN_PASSWORD
```

## Docker Compose

Из корня репозитория:

```bash
docker compose up --build -d
```

Или скрипт:

```bash
bash scripts/deploy-linux.sh
```

Сервисы:

| Сервис | Образ / сборка | Порт | Заметки |
|--------|----------------|------|---------|
| `postgres` | `postgres:16-alpine` | 127.0.0.1:5432 | user `caspian`, пароль из `.env`, volume `pgdata` |
| `pgbouncer` | `edoburu/pgbouncer` | внутренний | transaction pool |
| `redis` | `redis:7-alpine` | внутренний | pub/sub, кэш, ARQ |
| `osrm` | `osrm/osrm-backend:v5.27.1` | внутренний | граф в `loghub_osrmdata`; без файла — sleep |
| `migrate` | `backend/Dockerfile` | — | один раз `alembic upgrade head` в Postgres |
| `backend`, `backend-2` | тот же image | внутренний 8000 | gunicorn, 2 UvicornWorker, `--timeout 120`, non-root |
| `worker` | тот же image | — | follow, prune, downsample, prefetch, партиции |
| `gateway` | nginx:alpine | 127.0.0.1:8000 | least_conn; `/docs`, `/metrics` только с хоста |
| `frontend` | Node 22 → nginx | 80 | статика + `/api/` на те же реплики |
| `backup` | postgres:16-alpine | — | ежедневный `pg_dump` в `./backups/` |

Переменные API в compose (значения — из `.env`):

```
DATABASE_URL=postgresql+psycopg://caspian:${POSTGRES_PASSWORD}@pgbouncer:5432/caspian
SECRET_KEY=…
SUPERADMIN_PASSWORD=…
CORS_ORIGINS=http://localhost,http://localhost:80,http://localhost:5173,http://127.0.0.1
REDIS_URL=redis://redis:6379/0
OSRM_URL=http://osrm:5000
WEB_CONCURRENCY=2
DB_POOL_SIZE=5
DB_MAX_OVERFLOW=10
```

Граф OSRM (Kazakhstan, Geofabrik) собирается отдельно — первый прогон долгий:

```bash
bash scripts/prepare-osrm.sh
docker compose up -d osrm
```

Пока графа нет, стек всё равно поднимается: маршруты строятся по прямой.

Бэкап вручную:

```bash
bash scripts/backup-postgres.sh
```

## Nginx

`frontend/nginx.conf`: gzip JSON/JS/CSS, `limit_req` 20 r/s на `/api/` по `CF-Connecting-IP` / `X-Forwarded-For`, отдельная зона 5 r/m на `/api/auth/login`. SSE `/api/tracking/stream` без gzip и без буфера, `proxy_read_timeout 3600s`. Upstream `backend` + `backend-2`, `least_conn`. Прокидываются `X-Real-IP` и `X-Forwarded-For`.

`deploy/nginx-gateway.conf` — то же для localhost:8000 (OpenAPI, Prometheus).

Фронт ходит на относительный `/api/...`.

## Публичная ссылка (демо)

Туннель на порт 80:

```bash
cloudflared tunnel --url http://localhost:80
```

Запасной вариант: `ngrok http 80`.

Health: `http://127.0.0.1/api/health` или `http://127.0.0.1:8000/api/health`. Метрики: `http://127.0.0.1:8000/metrics`.

## Ограничения этой схемы

- Две реплики и JWT+Redis, sticky sessions не нужны.
- Gunicorn только в Linux-контейнере.
- Свой OSRM; без графа — fallback по прямой.
- Сид при пустой БД ходит в OSRM за ключевыми парами — первый старт может занять десятки секунд.
- Локальный SQLite без Docker: супер-админ `demo`. В Compose пароль — `SUPERADMIN_PASSWORD` из `.env`.
- Загрузок файлов нет, S3 не подключали.

Дальше: [масштабирование бэкенда](scaling.md).

## Локальный Postgres без всего стека

Нужен `.env` с `POSTGRES_PASSWORD`. Затем:

```bash
docker compose up -d postgres
```

Дальше uvicorn и Vite как в [быстром старте](getting-started.md), с `DATABASE_URL` на `localhost:5432` и тем же паролем. Redis для локальной разработки не обязателен.

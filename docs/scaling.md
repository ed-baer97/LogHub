# Масштабирование бэкенда

Как устроен процесс сейчас — в [архитектуре](architecture.md) и [продакшене](deployment.md). Этот файл — очередь работ сверх текущего стенда.

**Этапы 1–4 в коде:** JWT, Alembic, Redis, ARQ, пагинация, свой OSRM, две реплики API, PgBouncer, метрики, партиции треков.

```
хакатон → 1 Redis/JWT/Alembic ✓ → 2 GPS+SSE+ARQ ✓ → 3 пагинация/кэш/OSRM ✓ → 4 реплики ✓
```

## Что сломается следующим

Одновременные сессии закрыты репликами и пулом. Дальше — объём диска, объектное хранилище документов (в продукте загрузок ещё нет) и отдельный контур Grafana.

| Узкое место | Где | Следствие |
|-------------|-----|-----------|
| Треки старше окна retention | партиции + prune | рост диска, если cron молчит |
| Нет S3 | вложения | файлы оказались бы на диске контейнера |
| Один хост Compose | весь стек | нет failover площадки |

Локальный SQLite для нагрузки не подходит. Без `REDIS_URL` SSE и навигация снова в памяти процесса API.

## Этап 1 — Redis, JWT, Alembic

Сделано.

- JWT HS256 вместо `SESSIONS`; рестарт API не сбрасывает вход (пока токен не истёк).
- Redis pub/sub (`loghub:events`); без `REDIS_URL` и в pytest — in-memory.
- Alembic (`backend/alembic/`); `create_all` только при `TESTING=1`.
- bcrypt; старый SHA-256 принимается и перехешируется на логине. `password_plain` в БД нет; `initial_password` только в ответе создания/сброса.

Симулятор: ARQ `follow_vehicle` при Redis; иначе asyncio в API (pytest).

## Этап 2 — GPS в Redis, SSE дельтами, ARQ

Сделано.

- Живая позиция `vehicle:pos:{id}`, TTL 60 с; `track_points` не чаще 20 с; ping 429 чаще 3 с.
- SSE: снимок `fleet` на подключении, затем `vehicle`; каналы `loghub:staff` / `fleet:{id}` / `sender:{id}` / `orders`. ACL по полям события.
- Индекс `ix_track_points_vehicle_ts`, prune старше 14 дней (cron воркера).
- Пул Postgres `DB_POOL_SIZE` / `DB_MAX_OVERFLOW`.
- Follow-loop в контейнере `worker` (`arq app.worker.WorkerSettings`).

## Этап 3 — пагинация, кэш, очередь, свой OSRM

Сделано.

- Списки заявок и парка: `{items, total, limit, offset}`, `limit` по умолчанию 100, максимум 200.
- Кэш Redis 45 с: `quote`, analytics summary (ключи `super` / `staff`). `RouteCache` в БД как был. Хинты backhaul — до 20 с.
- Аналитика: `SUM`/`COUNT`/`GROUP BY`, коридоры — топ-8 пар origin/dest в SQL.
- Matching: сначала bbox ±0.85° вокруг origin/dest, затем прежний крюк по кандидатам.
- ARQ: `prefetch_osrm` (KEY_PAIRS), `downsample_tracks` (1 точка/мин старше суток), плюс prune и follow.
- OSRM в Compose (`osrm/osrm-backend`, volume `loghub_osrmdata`). Граф готовит `scripts/prepare-osrm.sh`. Пока файла нет — контейнер спит, API рисует прямую.

## Этап 4 — реплики, PgBouncer, метрики, партиции

Сделано.

- Nginx: gzip, `limit_req` 20 r/s (по реальному IP за туннелем), 5 r/m на логин, SSE без буфера (`/api/tracking/stream`, таймаут 3600 с). Реплики `backend` и `backend-2`, `least_conn`. Sticky sessions не нужны (JWT + Redis pub/sub).
- Gateway на `127.0.0.1:8000` — тот же upstream (Swagger, `/metrics`). Postgres на `127.0.0.1:5432`.
- Gunicorn в Linux-контейнере: 2 × `UvicornWorker` на реплику, `--timeout 120`. На Windows gunicorn нет — локально uvicorn.
- Миграции один раз: сервис `migrate` (`alembic upgrade head` прямо в Postgres).
- PgBouncer session pool; API и worker ходят через него. DDL — в `migrate` мимо пула. `prepare_threshold=None` у psycopg3.
- Медленные запросы Postgres: `log_min_duration_statement=500`.
- Бэкапы: контейнер `backup` раз в сутки в `./backups/`, плюс `scripts/backup-postgres.sh`.
- Метрики: `GET /metrics` (Prometheus), `GET /api/analytics/ops` (staff). p95 — `histogram_quantile` по `loghub_http_request_seconds`; SSE, длина `arq:queue`, `count(track_points)`.
- `track_points` в Postgres — RANGE по месяцу `ts`; воркер создаёт следующие месяцы и дропает старше retention. SQLite не секционируется.
- Object storage не подключали: загрузок документов в продукте нет.

**Не делать дальше без причины:** микросервисы, TimescaleDB поверх уже помесячных партиций, Grafana, если метрик с `/metrics` хватает.

## Gunicorn

В Docker уже так:

```bash
gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 2 -b 0.0.0.0:8000 --timeout 120
```

Две реплики × 2 воркера. На 1–2 vCPU не поднимайте `WEB_CONCURRENCY` без нужды — упираетесь в CPU и в PgBouncer. На Windows gunicorn не работает; в Linux-Docker — да.

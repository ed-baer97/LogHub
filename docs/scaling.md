# Масштабирование бэкенда

Как устроен процесс сейчас — в [архитектуре](architecture.md) и [продакшене](deployment.md). Этот файл — очередь работ сверх текущего стенда.

**Этап 1 в коде:** JWT, bcrypt, Alembic, Redis pub/sub для SSE. Gunicorn и вынос симулятора — нет.

```
хакатон → 1 Redis/JWT/Alembic ✓ → 2 GPS+SSE → 3 пагинация/кэш/OSRM → 4 реплики
```

## Что сломается первым

Не FastAPI как фреймворк, а GPS/SSE и симулятор в одном процессе.

| Узкое место | Где | Следствие |
|-------------|-----|-----------|
| План навигации в RAM | `_plan` / `_progress` / `_tasks` в `backend/app/services/simulator.py` | Второй инстанс «теряет» рейс в пути |
| Снимок всего парка | `publish_vehicles` → событие `fleet` | На ping и каждый тик сима (1.5 с) всем SSE-клиентам уходит полный список машин |
| БД на каждое SSE-событие | `GET /api/tracking/stream` в `backend/app/routers/tracking.py` | Новая сессия SQLAlchemy + ACL на каждый `fleet`/`vehicle` |
| GPS → Postgres | `POST /api/tracking/ping` → INSERT `track_points` | Точки без TTL; тысяча бортов × ping раз в 5 с ≈ сотни тысяч строк в час |
| Маршруты | публичный `router.project-osrm.org` | Лимиты и зависимость от внешней сети |

Postgres и Redis в Docker Compose уже есть. Локальный SQLite (`caspian.db`) для нагрузки не подходит. Без `REDIS_URL` шина SSE снова только в памяти процесса.

## Этап 1 — Redis, JWT, Alembic

Сделано.

- JWT HS256 вместо `SESSIONS`; рестарт API не сбрасывает вход (пока токен не истёк).
- Redis pub/sub (`loghub:events`); без `REDIS_URL` и в pytest — in-memory.
- Alembic (`backend/alembic/`); `create_all` только при `TESTING=1`.
- bcrypt; старый SHA-256 принимается и перехешируется на логине. `password_plain` в БД нет; `initial_password` только в ответе создания/сброса.

Симулятор по-прежнему `asyncio.Task` в процессе API: SSE с другого воркера увидит события, но follow-loop останется там, где нажали «Выехать».

**Не делать ещё:** gunicorn / `uvicorn --workers N`, пока навигация в API-процессе. Kafka, Kubernetes, отдельный tracking-сервис — рано.

## Этап 2 — GPS в Redis, SSE дельтами, TTL треков

**Цель.** Сотни водителей онлайн: карта живая, Postgres не превращается в лог координат.

**Добавить**

- Живая позиция: Redis `vehicle:{id}` (lat/lon/heading/ts, TTL ~60 с). В Postgres — батч раз в 15–30 с или точка каждые N км / смена статуса.
- Rate limit ping (например не чаще раза в 3–5 с на борт).
- SSE: событие `vehicle` только по изменившемуся борту; каналы `fleet:{carrier_id}` / `order:{id}`, не глобальный broadcast. ACL при подписке, не на каждый тик из БД. Диспетчеру — snapshot + дельты, не полный JSON дважды в секунду.
- Индекс `(vehicle_id, ts DESC)` на `track_points`, retention 7–30 дней, потом downsample.
- Явный пул соединений SQLAlchemy под число воркеров.
- Вынести follow-loop в воркер (ARQ/Celery), иначе горизонтальный API разъедет «кто ведёт машину».

**Дальше можно**, когда ping не пишет каждую точку в Postgres и клиент не получает весь парк на каждый тик.

**Не делать:** TimescaleDB и партиции «на всякий случай», пока объём треков не измерен.

## Этап 3 — пагинация, кэш, очередь, свой OSRM

**Цель.** Тысячи заявок в сутки без `.all()` по истории и без упирания в публичный OSRM.

**Добавить**

- Пагинация списков заявок и парка.
- Кэш Redis: quote/маршрут, analytics summary на 30–60 с. `RouteCache` в БД уже есть.
- Аналитика через `SUM`/`COUNT` в SQL, не загрузка всех `delivered` в Python.
- Matching: сначала bbox/коридор в SQL, затем точный крюк по кандидатам.
- Очередь (Redis + ARQ/Celery) для матчинга, префетча OSRM, downsample треков.
- Свой OSRM в Compose вместо публичного роутера.

Async SQLAlchemy — логичный шаг, когда SSE и GPS сидят на том же event loop; не первый приоритет.

**Дальше можно**, когда тяжёлые эндпоинты не сканируют всю историю и маршруты не зависят от внешнего OSRM.

## Этап 4 — реплики, PgBouncer, метрики, партиции

**Цель.** Тысячи одновременных сессий, предсказуемый p95.

**Добавить**

- Nginx/Caddy: лимиты, gzip, таймауты SSE (`proxy_buffering off` уже намекает `X-Accel-Buffering`).
- Две и более реплики backend (sticky sessions не нужны при JWT + Redis pub/sub).
- PgBouncer, бэкапы, лог медленных запросов.
- Метрики: p95, очередь Redis, размер `track_points`, число SSE-соединений.
- Партиции треков (или TimescaleDB), когда объём это оправдывает.
- Object storage для документов, не диск контейнера.

**Не делать** на старте этапа: дробить монолит на микросервисы без отдельной причины.

## Gunicorn

JWT и SSE через Redis уже позволяют несколько процессов по HTTP. Включать gunicorn всё равно рано: симулятор в RAM.

После этапа 2 (follow-loop вне API):

```bash
gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 -b 0.0.0.0:8000
```

На 1–2 vCPU обычно 2–4 воркера. Альтернативы: `uvicorn --workers N` или несколько контейнеров backend. На Windows gunicorn не работает; в Linux-Docker — да.

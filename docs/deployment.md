# Продакшен

Стек: PostgreSQL 16, FastAPI (uvicorn), nginx со статикой Vite. Один хост, порты **80** (UI) и **8000** (API напрямую).

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
| `postgres` | `postgres:16-alpine` | 5432 | user/pass/db `caspian`, volume `pgdata`, healthcheck |
| `backend` | `backend/Dockerfile` (Python 3.12-slim) | 8000 | ждёт healthy postgres |
| `frontend` | multi-stage Node 22 → nginx:alpine | 80 | `proxy_pass` на `http://backend:8000/api/` |

Переменные backend в compose:

```
DATABASE_URL=postgresql+psycopg://caspian:caspian@postgres:5432/caspian
SECRET_KEY=caspian-hackathon-secret
CORS_ORIGINS=http://localhost,http://localhost:80,http://localhost:5173,http://127.0.0.1
```

Перед публичным выкладным стендом смените `SECRET_KEY` и пароль Postgres.

## Nginx

`frontend/nginx.conf`: SPA `try_files` → `index.html`. `/api/` без буферизации, `X-Accel-Buffering` на SSE задаёт сам FastAPI, `proxy_read_timeout 3600s`.

Фронт ходит на относительный `/api/...`, отдельный CORS для браузера за тем же origin не обязателен.

## Публичная ссылка (демо)

Туннель на порт 80:

```bash
cloudflared tunnel --url http://localhost:80
```

Запасной вариант: `ngrok http 80`.

Health после деплоя: `http://127.0.0.1:8000/api/health` или `/api/health` через nginx.

## Ограничения этой схемы

- Один воркер uvicorn: сессии и симулятор в памяти процесса. `uvicorn --workers N` разъедет SSE и логины.
- Публичный OSRM — лимиты и зависимость от сети; при недоступности строится прямая.
- Сид при пустой БД ходит в OSRM за ключевыми парами — первый старт может занять десятки секунд.
- Учётки и пароль `demo` — только для хакатона/стенда.

## Локальный Postgres без всего стека

```bash
docker compose up -d postgres
```

Дальше uvicorn и Vite как в [быстром старте](getting-started.md), с `DATABASE_URL` на `localhost:5432`.

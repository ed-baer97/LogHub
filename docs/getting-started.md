# Быстрый старт

## Что нужно

- Python 3.12+
- Node.js 20+ (в Docker-сборке фронта — 22)
- npm
- опционально Docker Desktop — для PostgreSQL или полного стека

Без Docker бэкенд пишет в SQLite (`backend/caspian.db`).

## Локальный запуск

### 1. Backend

```bash
cd backend
python -m venv .venv
```

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Linux / macOS:

```bash
source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Перед стартом накатите схему: `alembic upgrade head`. Затем справочник населённых пунктов Мангистау и супер-админ. Заявок, парка и прочих учёток нет.

Swagger: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)  
Health: [http://127.0.0.1:8000/api/health](http://127.0.0.1:8000/api/health)

JWT переживает перезапуск uvicorn (срок по умолчанию 7 суток). Redis для локального SSE не обязателен.

### 2. Frontend

В другом терминале:

```bash
cd frontend
npm install
npm run dev
```

Открыть [http://localhost:5173](http://localhost:5173). Vite проксирует `/api` на `http://127.0.0.1:8000`.

### 3. PostgreSQL вместо SQLite

```bash
docker compose up -d postgres
```

Windows PowerShell:

```powershell
$env:DATABASE_URL="postgresql+psycopg://caspian:YOUR_POSTGRES_PASSWORD@localhost:5432/caspian"
```

Linux / macOS:

```bash
export DATABASE_URL="postgresql+psycopg://caspian:YOUR_POSTGRES_PASSWORD@localhost:5432/caspian"
```

Затем из каталога `backend`: `alembic upgrade head` и перезапустить uvicorn.

## Вход

В сиде одна учётка:

| Роль | Email | Пароль |
|------|--------|--------|
| Супер-админ | `superadmin@caspian.kz` | `demo` |

Остальных заводите в интерфейсе. Пароль при создании можно оставить пустым — сервер сгенерирует и покажет **один раз** в тосте. В списках пользователей пароль больше не отдаётся. Заблокированная учётка не входит.

## Цепочка проверки с нуля

1. Войти как `superadmin@caspian.kz` / `demo` — создать админа.
2. Войти как админ — создать отправителя и перевозчика.
3. Отправитель — при необходимости добавить пункт, разместить заявку.
4. Перевозчик — создать борт (водитель + машина), взять заявку с биржи, назначить борт.
5. Водитель — «Я прибыл» → «Начать погрузку» → «Выехать» → «Завершить рейс».

Подробнее: [жизненный цикл заявки](order-lifecycle.md), [роли](roles-and-access.md).

## Тесты

```bash
cd backend
python -m pytest
```

Покрывается матрица ролей, isolation заявок и парка, этапы рейса. См. [разработку](development.md).

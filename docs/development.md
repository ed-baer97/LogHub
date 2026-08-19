# Разработка

## Окружение бэкенда

`backend/app/config.py` (и `.env` в `backend/`):

| Переменная | По умолчанию | Смысл |
|------------|----------------|--------|
| `DATABASE_URL` | `sqlite:///./caspian.db` | PostgreSQL: `postgresql+psycopg://caspian:caspian@localhost:5432/caspian` |
| `SECRET_KEY` | `caspian-hackathon-secret` | соль пароля |
| `CORS_ORIGINS` | localhost:5173, :80, … | список через запятую; в `main` дополнительно `*` |
| `OSRM_URL` | `https://router.project-osrm.org` | |
| `SIM_SPEED_KMH` | `420` | ускорение демо |
| `SIM_TICK_S` | `1.5` | шаг симулятора |

Compose задаёт `DATABASE_URL` на сервис `postgres`, `SECRET_KEY`, `CORS_ORIGINS`.

Не коммитить `.env` и `*.db` (см. `.gitignore`).

## Зависимости

Backend: FastAPI, uvicorn, SQLAlchemy, psycopg, pydantic-settings, httpx, numpy, pytest.

Frontend: react, react-dom, react-router-dom, maplibre-gl. Скрипты: `npm run dev` / `build` / `preview`.

Python-пакеты приложения живут в `backend/app/` — запуск uvicorn из каталога `backend`.

## Тесты

```bash
cd backend
python -m pytest
```

`TESTING=1` и временный SQLite в `conftest.py`. Сид при тестах не гоняется.

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

После смены access/роутов имеет смысл прогнать этот файл.

## Соглашения, которые легко сломать

- **404 на чужие id** — не заменять на 403 в `get_order_or_404` / `get_owned_*`.
- **Не пропускать статусы** — `_advance` сравнивает expected.
- **Борт в UI = `vehicles` в БД.**
- **Сессии в RAM** — не рассчитывать на persist после reload и на несколько воркеров.
- **Создание борта = создание водителя.** Один водитель — один борт (`attach_driver`).
- Роль `dispatcher` нормализуется в `admin`.

## Что сознательно не сделано

Платежи, ЭЦП/SMS, натив, скоринг, тахографы, Alembic, JWT, Redis/Celery, несколько инстансов API, хранение пароля в списках.

`password_plain` в БД — наследие демо (сид и одноразовый показ). Для реального продакшена поле нужно убрать.

## Полезные URL

| | |
|--|--|
| UI | http://localhost:5173 |
| OpenAPI | http://127.0.0.1:8000/docs |
| Health | http://127.0.0.1:8000/api/health |

from __future__ import annotations

import os
import time

from fastapi import HTTPException, Request

from app.services.redisutil import sync_redis

WINDOW_S = 300
FAIL_LIMIT = 8

_mem: dict[str, tuple[int, float]] = {}


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return request.client.host if request.client else "unknown"


def _key(kind: str, value: str) -> str:
    return f"login:{kind}:{value.strip().lower()}"


def _get(key: str) -> int:
    client = sync_redis()
    if client is not None:
        try:
            return int(client.get(key) or 0)
        except Exception:
            return 0
    now = time.monotonic()
    count, exp = _mem.get(key, (0, 0.0))
    if now > exp:
        _mem.pop(key, None)
        return 0
    return count


def _incr(key: str) -> int:
    client = sync_redis()
    if client is not None:
        try:
            n = int(client.incr(key))
            if n == 1:
                client.expire(key, WINDOW_S)
            return n
        except Exception:
            return 0
    now = time.monotonic()
    count, exp = _mem.get(key, (0, now + WINDOW_S))
    if now > exp:
        count, exp = 0, now + WINDOW_S
    count += 1
    _mem[key] = (count, exp)
    return count


def _delete(key: str) -> None:
    client = sync_redis()
    if client is not None:
        try:
            client.delete(key)
        except Exception:
            return
        return
    _mem.pop(key, None)


def assert_login_allowed(email: str, ip: str) -> None:
    if _get(_key("email", email)) >= FAIL_LIMIT:
        raise HTTPException(429, "Слишком много попыток входа, подождите несколько минут")
    if os.getenv("TESTING"):
        return
    if _get(_key("ip", ip)) >= FAIL_LIMIT:
        raise HTTPException(429, "Слишком много попыток входа, подождите несколько минут")


def register_login_failure(email: str, ip: str) -> None:
    _incr(_key("email", email))
    _incr(_key("ip", ip))


def clear_login_failures(email: str, ip: str) -> None:
    _delete(_key("email", email))
    _delete(_key("ip", ip))

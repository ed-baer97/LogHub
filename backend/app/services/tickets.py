from __future__ import annotations

import secrets
import time

from app.services.redisutil import sync_redis

TTL_S = 60
PREFIX = "sse:ticket:"

_mem: dict[str, tuple[int, float]] = {}


def issue_ticket(user_id: int) -> str:
    token = secrets.token_urlsafe(24)
    client = sync_redis()
    if client is not None:
        try:
            client.set(f"{PREFIX}{token}", str(user_id), ex=TTL_S)
            return token
        except Exception:
            pass
    _mem[token] = (user_id, time.monotonic() + TTL_S)
    return token


def consume_ticket(token: str) -> int | None:
    if not token:
        return None
    client = sync_redis()
    if client is not None:
        try:
            key = f"{PREFIX}{token}"
            raw = client.get(key)
            if raw:
                client.delete(key)
                return int(raw)
            return None
        except Exception:
            return None
    row = _mem.pop(token, None)
    if not row:
        return None
    user_id, exp = row
    if time.monotonic() > exp:
        return None
    return user_id

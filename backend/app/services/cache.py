from __future__ import annotations

import json
from typing import Any

from app.services.redisutil import sync_redis


def cache_get(key: str) -> Any | None:
    client = sync_redis()
    if not client:
        return None
    try:
        raw = client.get(key)
    except Exception:
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def cache_set(key: str, value: Any, ttl: int) -> None:
    client = sync_redis()
    if not client or ttl <= 0:
        return
    try:
        client.set(key, json.dumps(value, default=str), ex=ttl)
    except Exception:
        return

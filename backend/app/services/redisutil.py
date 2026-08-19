from __future__ import annotations

import os
from typing import Any

from app.config import settings

_sync: Any = None


def redis_enabled() -> bool:
    return bool(settings.redis_url.strip()) and not os.getenv("TESTING")


def sync_redis() -> Any | None:
    global _sync
    if not redis_enabled():
        return None
    if _sync is None:
        import redis

        _sync = redis.from_url(settings.redis_url, decode_responses=True)
    return _sync

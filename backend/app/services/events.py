from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from typing import Any

from app.config import settings

CHANNEL = "loghub:events"


def _use_redis() -> bool:
    return bool(settings.redis_url.strip()) and not os.getenv("TESTING")


class EventBus:
    def __init__(self) -> None:
        self._subs: list[asyncio.Queue[dict[str, Any]]] = []
        self._redis_sync: Any = None
        self._redis_async: Any = None
        self._listener: asyncio.Task[None] | None = None

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
        self._subs.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        if q in self._subs:
            self._subs.remove(q)

    def _fanout(self, event: dict[str, Any]) -> None:
        dead: list[asyncio.Queue[dict[str, Any]]] = []
        for q in self._subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self.unsubscribe(q)

    def _ensure_sync(self) -> None:
        if self._redis_sync is None:
            import redis

            self._redis_sync = redis.from_url(settings.redis_url, decode_responses=True)

    def publish(self, event: dict[str, Any]) -> None:
        if _use_redis():
            try:
                self._ensure_sync()
                self._redis_sync.publish(CHANNEL, json.dumps(event, default=str))
                return
            except Exception:
                pass
        self._fanout(event)

    async def start(self) -> None:
        if not _use_redis():
            return
        import redis.asyncio as redis_async

        self._redis_async = redis_async.from_url(settings.redis_url, decode_responses=True)
        self._ensure_sync()
        self._listener = asyncio.create_task(self._listen())

    async def stop(self) -> None:
        if self._listener is not None:
            self._listener.cancel()
            try:
                await self._listener
            except asyncio.CancelledError:
                pass
            self._listener = None
        if self._redis_async is not None:
            await self._redis_async.aclose()
            self._redis_async = None
        if self._redis_sync is not None:
            self._redis_sync.close()
            self._redis_sync = None

    async def _listen(self) -> None:
        assert self._redis_async is not None
        while True:
            try:
                pubsub = self._redis_async.pubsub()
                await pubsub.subscribe(CHANNEL)
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    data = message.get("data")
                    if not data:
                        continue
                    try:
                        event = json.loads(data)
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if isinstance(event, dict):
                        self._fanout(event)
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(1)


bus = EventBus()


async def sse_stream() -> AsyncIterator[str]:
    q = bus.subscribe()
    try:
        yield f"data: {json.dumps({'type': 'hello'})}\n\n"
        while True:
            event = await q.get()
            yield f"data: {json.dumps(event, default=str)}\n\n"
    finally:
        bus.unsubscribe(q)

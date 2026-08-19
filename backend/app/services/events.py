from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from app.services.redisutil import redis_enabled, sync_redis

STAFF = "loghub:staff"
ORDERS = "loghub:orders"


def fleet_channel(owner_id: int) -> str:
    return f"loghub:fleet:{owner_id}"


def sender_channel(sender_id: int) -> str:
    return f"loghub:sender:{sender_id}"


def channels_for_event(event: dict[str, Any]) -> list[str]:
    kind = event.get("type")
    if kind == "vehicle":
        ch = [STAFF]
        owner = event.get("owner_id")
        if owner:
            ch.append(fleet_channel(int(owner)))
        sender = event.get("sender_id")
        if sender:
            ch.append(sender_channel(int(sender)))
        return ch
    if kind in {"order", "order_new"}:
        ch = [STAFF, ORDERS]
        carrier = event.get("carrier_id")
        if carrier:
            ch.append(fleet_channel(int(carrier)))
        sender = event.get("sender_id")
        if sender:
            ch.append(sender_channel(int(sender)))
        return ch
    return [STAFF, ORDERS]


def publish_order_event(
    order: Any,
    *,
    type: str = "order",
    status: str | None = None,
    order_id: int | None = None,
) -> None:
    oid = order_id if order_id is not None else getattr(order, "id", None)
    payload = {
        "type": type,
        "id": oid,
        "status": status if status is not None else getattr(order, "status", None),
        "sender_id": getattr(order, "sender_id", None),
        "carrier_id": getattr(order, "carrier_id", None),
        "vehicle_id": getattr(order, "vehicle_id", None),
    }
    bus.publish(payload)


class _Sub:
    def __init__(self, channels: list[str]) -> None:
        self.channels = set(channels)
        self.q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)


class EventBus:
    def __init__(self) -> None:
        self._subs: list[_Sub] = []

    def subscribe(self, channels: list[str]) -> asyncio.Queue[dict[str, Any]]:
        sub = _Sub(channels)
        self._subs.append(sub)
        return sub.q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subs = [s for s in self._subs if s.q is not q]

    def publish(self, event: dict[str, Any]) -> None:
        channels = channels_for_event(event)
        body = json.dumps(event, default=str)
        r = sync_redis()
        if r is not None:
            try:
                for ch in channels:
                    r.publish(ch, body)
                return
            except Exception:
                pass
        wanted = set(channels)
        dead: list[_Sub] = []
        for sub in self._subs:
            if not (sub.channels & wanted):
                continue
            try:
                sub.q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(sub)
        for sub in dead:
            self.unsubscribe(sub.q)

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None


bus = EventBus()


async def iter_channel_events(channels: list[str]) -> AsyncIterator[dict[str, Any]]:
    if redis_enabled() and channels:
        import redis.asyncio as redis_async
        from app.config import settings

        client = redis_async.from_url(settings.redis_url, decode_responses=True)
        pubsub = client.pubsub()
        await pubsub.subscribe(*channels)
        try:
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
                    yield event
        finally:
            await pubsub.unsubscribe()
            await client.aclose()
        return

    q = bus.subscribe(channels)
    try:
        while True:
            yield await q.get()
    finally:
        bus.unsubscribe(q)


async def sse_stream() -> AsyncIterator[str]:
    async for event in iter_channel_events([STAFF, ORDERS]):
        yield f"data: {json.dumps(event, default=str)}\n\n"

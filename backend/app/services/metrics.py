from __future__ import annotations

import os
import re
import socket
import time
from typing import Any

from fastapi import Response
from prometheus_client import CONTENT_TYPE_LATEST, Gauge, Histogram, generate_latest

from app.services.redisutil import sync_redis

SSE_KEY = "metrics:sse"
_ID = re.compile(r"^\d+$")

HTTP_SECONDS = Histogram(
    "loghub_http_request_seconds",
    "HTTP request duration",
    ["method", "path"],
    buckets=(0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
)
SSE_LOCAL = Gauge("loghub_sse_connections", "Open SSE streams on this process")
TRACK_POINTS = Gauge("loghub_track_points", "Rows in track_points")
ARQ_QUEUE = Gauge("loghub_arq_queue_jobs", "Jobs waiting in ARQ default queue")

_sse_local = 0
_SKIP_PREFIX = ("/metrics", "/docs", "/redoc", "/openapi")
_SKIP_EXACT = {"/api/tracking/stream"}


def instance_id() -> str:
    return os.getenv("HOSTNAME") or socket.gethostname()


def _norm_path(path: str) -> str:
    parts = [("{id}" if _ID.match(p) else p) for p in path.split("/") if p != ""]
    return "/" + "/".join(parts) if parts else "/"


def sse_open() -> None:
    global _sse_local
    _sse_local += 1
    SSE_LOCAL.set(_sse_local)
    client = sync_redis()
    if client is None:
        return
    try:
        client.incr(SSE_KEY)
    except Exception:
        return


def sse_close() -> None:
    global _sse_local
    _sse_local = max(0, _sse_local - 1)
    SSE_LOCAL.set(_sse_local)
    client = sync_redis()
    if client is None:
        return
    try:
        n = int(client.decr(SSE_KEY))
        if n < 0:
            client.set(SSE_KEY, 0)
    except Exception:
        return


def sse_total() -> int:
    client = sync_redis()
    if client is not None:
        try:
            return max(0, int(client.get(SSE_KEY) or 0))
        except Exception:
            pass
    return _sse_local


def arq_queue_len() -> int:
    client = sync_redis()
    if client is None:
        return 0
    try:
        return int(client.llen("arq:queue") or 0)
    except Exception:
        return 0


def refresh_gauges(track_points: int | None = None) -> None:
    SSE_LOCAL.set(_sse_local)
    if track_points is not None:
        TRACK_POINTS.set(track_points)
    ARQ_QUEUE.set(arq_queue_len())


def prometheus_response(track_points: int | None = None) -> Response:
    refresh_gauges(track_points)
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


class RequestMetricsMiddleware:
    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path") or ""
        method = scope.get("method") or "GET"
        skip = path in _SKIP_EXACT or any(path.startswith(p) for p in _SKIP_PREFIX)
        started = time.perf_counter()
        recorded = False

        async def send_wrapper(message: dict) -> None:
            nonlocal recorded
            if not skip and not recorded and message["type"] == "http.response.start":
                recorded = True
                HTTP_SECONDS.labels(method, _norm_path(path)).observe(time.perf_counter() - started)
            await send(message)

        await self.app(scope, receive, send_wrapper)

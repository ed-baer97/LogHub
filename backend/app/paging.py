from __future__ import annotations

from typing import Any

from fastapi import Query
from sqlalchemy.orm import Query as SAQuery

DEFAULT_LIMIT = 100
MAX_LIMIT = 200


def clamp_limit(limit: int) -> int:
    return max(1, min(limit, MAX_LIMIT))


def page_params(
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
) -> tuple[int, int]:
    return clamp_limit(limit), max(0, offset)


def paginate(query: SAQuery, *, order_by: Any, limit: int, offset: int) -> tuple[list, int, int, int]:
    limit = clamp_limit(limit)
    offset = max(0, offset)
    total = int(query.order_by(None).count() or 0)
    rows = query.order_by(order_by).offset(offset).limit(limit).all()
    return rows, total, limit, offset

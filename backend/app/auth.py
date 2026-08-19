from __future__ import annotations

import hashlib
import secrets
from typing import Annotated

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import User

SESSIONS: dict[str, int] = {}


def hash_password(password: str) -> str:
    raw = f"{settings.secret_key}:{password}".encode()
    return hashlib.sha256(raw).hexdigest()


def verify_password(password: str, stored: str) -> bool:
    return hash_password(password) == stored


def issue_token(user_id: int) -> str:
    token = secrets.token_urlsafe(24)
    SESSIONS[token] = user_id
    return token


def get_current_user(
    db: Annotated[Session, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
    x_demo_role: Annotated[str | None, Header()] = None,
) -> User:
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(401, "Нужна авторизация")
    user_id = SESSIONS.get(token)
    if not user_id:
        raise HTTPException(401, "Сессия истекла")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(401, "Пользователь не найден")
    if not getattr(user, "is_active", True):
        raise HTTPException(403, "Учётная запись заблокирована")
    return user


def get_optional_user(
    db: Annotated[Session, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> User | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    user_id = SESSIONS.get(token)
    if not user_id:
        return None
    return db.get(User, user_id)

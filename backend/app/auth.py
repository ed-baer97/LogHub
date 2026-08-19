from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta, timezone
from typing import Annotated

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import User

_JWT_ALG = "HS256"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def is_legacy_hash(stored: str) -> bool:
    return not stored.startswith("$2")


def _legacy_hash(password: str) -> str:
    raw = f"{settings.secret_key}:{password}".encode()
    return hashlib.sha256(raw).hexdigest()


def verify_password(password: str, stored: str) -> bool:
    if stored.startswith("$2"):
        try:
            return bcrypt.checkpw(password.encode(), stored.encode())
        except ValueError:
            return False
    return hmac.compare_digest(_legacy_hash(password), stored)


def issue_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(hours=settings.jwt_expire_hours),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=_JWT_ALG)


def user_id_from_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[_JWT_ALG])
        return int(payload["sub"])
    except (jwt.PyJWTError, TypeError, ValueError):
        return None


def get_current_user(
    db: Annotated[Session, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(401, "Нужна авторизация")
    user_id = user_id_from_token(token)
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
    user_id = user_id_from_token(token)
    if not user_id:
        return None
    return db.get(User, user_id)

from __future__ import annotations

import hashlib
import hmac
import secrets
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
MIN_PASSWORD_LEN = 6


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def generate_password() -> str:
    return secrets.token_urlsafe(9)


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


def bump_token_version(user: User) -> None:
    user.token_version = int(getattr(user, "token_version", 0) or 0) + 1


def issue_token(user_id: int, token_version: int = 0) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "ver": int(token_version or 0),
        "iat": now,
        "exp": now + timedelta(hours=settings.jwt_expire_hours),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=_JWT_ALG)


def decode_token(token: str) -> tuple[int, int] | None:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[_JWT_ALG])
        return int(payload["sub"]), int(payload.get("ver") or 0)
    except (jwt.PyJWTError, TypeError, ValueError):
        return None


def user_id_from_token(token: str) -> int | None:
    decoded = decode_token(token)
    return decoded[0] if decoded else None


def load_user_from_token(db: Session, token: str) -> User | None:
    decoded = decode_token(token)
    if not decoded:
        return None
    user_id, ver = decoded
    user = db.get(User, user_id)
    if not user:
        return None
    if int(getattr(user, "token_version", 0) or 0) != ver:
        return None
    return user


def get_current_user(
    db: Annotated[Session, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(401, "Нужна авторизация")
    user = load_user_from_token(db, token)
    if not user:
        raise HTTPException(401, "Сессия истекла")
    if not getattr(user, "is_active", True):
        raise HTTPException(403, "Учётная запись заблокирована")
    return user

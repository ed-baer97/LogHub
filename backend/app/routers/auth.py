from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user, issue_token, verify_password
from app.database import get_db
from app.models import User
from app.schemas import LoginIn, TokenOut, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])

DEMO = [
    {"email": "superadmin@caspian.kz", "role": "superadmin", "label": "Супер-админ"},
    {"email": "dispatcher@caspian.kz", "role": "admin", "label": "Админ акимата"},
    {"email": "sender@caspian.kz", "role": "sender", "label": "Отправитель · магазин"},
    {"email": "carrier@caspian.kz", "role": "carrier", "label": "Перевозчик · КаспийТранс"},
    {"email": "driver@caspian.kz", "role": "driver", "label": "Водитель · GPS"},
]


@router.get("/demo")
def demo_accounts():
    return DEMO


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Annotated[Session, Depends(get_db)]):
    user = db.query(User).filter(User.email == body.email).one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Неверный логин или пароль")
    return TokenOut(token=issue_token(user.id), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: Annotated[User, Depends(get_current_user)]):
    return user

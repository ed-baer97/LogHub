from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user, hash_password, issue_token, verify_password
from app.database import get_db
from app.models import User, Vehicle
from app.schemas import LoginIn, ProfileUpdate, TokenOut, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])

DEMO = [
    {"email": "superadmin@caspian.kz", "role": "superadmin", "label": "Супер-админ"},
]


@router.get("/demo")
def demo_accounts():
    return DEMO


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Annotated[Session, Depends(get_db)]):
    user = db.query(User).filter(User.email == body.email).one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Неверный логин или пароль")
    if not getattr(user, "is_active", True):
        raise HTTPException(403, "Учётная запись заблокирована")
    return TokenOut(token=issue_token(user.id), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: Annotated[User, Depends(get_current_user)]):
    return user


@router.patch("/me", response_model=UserOut)
def update_me(
    body: ProfileUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    email_changed = body.email is not None and body.email.strip() != user.email
    password_changed = bool(body.password)
    if email_changed or password_changed:
        if not body.current_password or not verify_password(body.current_password, user.password_hash):
            raise HTTPException(400, "Укажите текущий пароль")
    if email_changed:
        email = body.email.strip()
        taken = db.query(User).filter(User.email == email, User.id != user.id).first()
        if taken:
            raise HTTPException(409, "Email уже занят")
        user.email = email
    if body.name and body.name.strip():
        user.name = body.name.strip()
        board = db.query(Vehicle).filter(Vehicle.driver_id == user.id).first()
        if board:
            board.driver_name = user.name
    if body.phone is not None:
        user.phone = body.phone.strip() or None
    if password_changed:
        if len(body.password) < 4:
            raise HTTPException(400, "Пароль слишком короткий")
        user.password_hash = hash_password(body.password)
        user.password_plain = body.password
    db.commit()
    db.refresh(user)
    return user

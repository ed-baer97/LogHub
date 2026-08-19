from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.access import require_admin_users, require_staff, require_superadmin
from app.auth import bump_token_version, generate_password, get_current_user, hash_password
from app.database import get_db
from app.models import User
from app.roles import ADMIN, CARRIER, SENDER, creatable_roles, is_admin, is_superadmin, normalize_role, ROLE_LABELS
from app.schemas import PasswordResetIn, UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/api/admin", tags=["admin"])

StaffDep = Annotated[User, Depends(require_staff)]
AdminUsersDep = Annotated[User, Depends(require_admin_users)]
SuperDep = Annotated[User, Depends(require_superadmin)]
DbDep = Annotated[Session, Depends(get_db)]


def _assert_can_assign_role(actor: User, role: str) -> None:
    allowed = creatable_roles(actor.role)
    if role not in allowed:
        raise HTTPException(
            403,
            f"Нельзя назначить роль «{ROLE_LABELS.get(role, role)}»",
        )


def _to_out(user: User, initial: str | None = None) -> UserOut:
    item = UserOut.model_validate(user)
    item.initial_password = initial
    return item


def _temp_password() -> str:
    return generate_password()


@router.get("/role-options")
def role_options(actor: StaffDep):
    ids = creatable_roles(actor.role)
    return [{"id": r, "label": ROLE_LABELS[r]} for r in ids]


@router.get("/users", response_model=list[UserOut])
def list_users(db: DbDep, actor: StaffDep):
    q = db.query(User).filter(User.id != actor.id).order_by(User.role, User.name)
    if is_admin(actor.role):
        q = q.filter(User.role.in_([SENDER, CARRIER]))
    return [_to_out(u) for u in q.all()]


@router.post("/users", response_model=UserOut)
def create_user(body: UserCreate, db: DbDep, actor: StaffDep):
    _assert_can_assign_role(actor, body.role)
    if is_superadmin(actor.role) and body.role != ADMIN:
        raise HTTPException(403, "Супер-админ создаёт только админов")
    if is_admin(actor.role) and body.role not in {SENDER, CARRIER}:
        raise HTTPException(403, "Админ создаёт только отправителей и перевозчиков")
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(409, "Email уже занят")
    password = (body.password.strip() if body.password else "") or _temp_password()
    user = User(
        email=body.email,
        name=body.name,
        role=body.role,
        company=body.company,
        phone=body.phone,
        password_hash=hash_password(password),
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _to_out(user, password)


def _manageable(actor: User, user: User) -> None:
    if user.id == actor.id:
        raise HTTPException(403, "Нельзя менять свою учётку здесь")
    if is_admin(actor.role):
        if user.role not in {SENDER, CARRIER}:
            raise HTTPException(404, "Пользователь не найден")
    elif is_superadmin(actor.role):
        if normalize_role(user.role) != ADMIN:
            raise HTTPException(403, "Супер-админ меняет только админов")
    else:
        raise HTTPException(403, "Недостаточно прав")


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, db: DbDep, actor: Annotated[User, Depends(get_current_user)]):
    if not is_admin(actor.role) and not is_superadmin(actor.role):
        raise HTTPException(403, "Недостаточно прав")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    _manageable(actor, user)
    if body.role is not None:
        _assert_can_assign_role(actor, body.role)
    was_active = bool(getattr(user, "is_active", True))
    for field in ("name", "company", "phone", "role", "is_active"):
        value = getattr(body, field)
        if value is not None:
            setattr(user, field, value)
    if was_active and body.is_active is False:
        bump_token_version(user)
    db.commit()
    db.refresh(user)
    return _to_out(user)


@router.post("/users/{user_id}/block", response_model=UserOut)
def block_user(user_id: int, db: DbDep, actor: AdminUsersDep):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    _manageable(actor, user)
    user.is_active = False
    bump_token_version(user)
    db.commit()
    db.refresh(user)
    return _to_out(user)


@router.post("/users/{user_id}/unblock", response_model=UserOut)
def unblock_user(user_id: int, db: DbDep, actor: AdminUsersDep):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    _manageable(actor, user)
    user.is_active = True
    db.commit()
    db.refresh(user)
    return _to_out(user)


@router.post("/users/{user_id}/reset-password", response_model=UserOut)
def reset_password(user_id: int, db: DbDep, actor: AdminUsersDep, body: PasswordResetIn | None = None):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    _manageable(actor, user)
    password = (body.password.strip() if body and body.password else "") or _temp_password()
    user.password_hash = hash_password(password)
    bump_token_version(user)
    db.commit()
    db.refresh(user)
    return _to_out(user, password)

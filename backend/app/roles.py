SUPERADMIN = "superadmin"
ADMIN = "admin"
SENDER = "sender"
CARRIER = "carrier"
DRIVER = "driver"
LEGACY_DISPATCHER = "dispatcher"

ALL_ROLES = {SUPERADMIN, ADMIN, SENDER, CARRIER, DRIVER, LEGACY_DISPATCHER}
STAFF_ROLES = {SUPERADMIN, ADMIN, LEGACY_DISPATCHER}

ROLE_LABELS = {
    SUPERADMIN: "Супер-админ",
    ADMIN: "Админ",
    SENDER: "Отправитель",
    CARRIER: "Перевозчик",
    DRIVER: "Водитель",
    LEGACY_DISPATCHER: "Админ",
}


def normalize_role(role: str) -> str:
    if role == LEGACY_DISPATCHER:
        return ADMIN
    return role


def is_staff(role: str) -> bool:
    return normalize_role(role) in {SUPERADMIN, ADMIN}


def is_superadmin(role: str) -> bool:
    return normalize_role(role) == SUPERADMIN


def is_admin(role: str) -> bool:
    """Оператор пользователей (не перевозок)."""
    return normalize_role(role) == ADMIN


def creatable_roles(actor_role: str) -> list[str]:
    actor = normalize_role(actor_role)
    if actor == SUPERADMIN:
        return [ADMIN]
    if actor == ADMIN:
        return [SENDER, CARRIER]
    return []

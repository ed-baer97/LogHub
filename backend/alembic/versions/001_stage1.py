"""Create schema if missing; drop password_plain on existing DBs.

Revision ID: 001_stage1
Revises:
Create Date: 2026-08-20
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

from app.database import Base
from app import models  # noqa: F401

revision: str = "001_stage1"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)
    insp = inspect(bind)
    if "users" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("users")}
    if "password_plain" in cols:
        with op.batch_alter_table("users") as batch_op:
            batch_op.drop_column("password_plain")


def downgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    if "users" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("users")}
    if "password_plain" not in cols:
        with op.batch_alter_table("users") as batch_op:
            batch_op.add_column(sa.Column("password_plain", sa.String(120), nullable=True))

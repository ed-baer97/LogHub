"""Composite index on track_points (vehicle_id, ts).

Revision ID: 002_track_idx
Revises: 001_stage1
Create Date: 2026-08-20
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect

revision: str = "002_track_idx"
down_revision: Union[str, None] = "001_stage1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    if "track_points" not in insp.get_table_names():
        return
    names = {ix["name"] for ix in insp.get_indexes("track_points")}
    if "ix_track_points_vehicle_ts" not in names:
        op.create_index("ix_track_points_vehicle_ts", "track_points", ["vehicle_id", "ts"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    if "track_points" not in insp.get_table_names():
        return
    names = {ix["name"] for ix in insp.get_indexes("track_points")}
    if "ix_track_points_vehicle_ts" in names:
        op.drop_index("ix_track_points_vehicle_ts", table_name="track_points")

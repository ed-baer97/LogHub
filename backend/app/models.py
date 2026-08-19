from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(32), index=True)
    company: Mapped[str | None] = mapped_column(String(160), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    carrier_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    vehicles: Mapped[list["Vehicle"]] = relationship(back_populates="owner", foreign_keys="Vehicle.owner_id")
    sent_orders: Mapped[list["Order"]] = relationship(
        back_populates="sender", foreign_keys="Order.sender_id"
    )


class Settlement(Base):
    __tablename__ = "settlements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    kind: Mapped[str] = mapped_column(String(32))  # city, village, industrial, construction
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    population: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str | None] = mapped_column(String(240), nullable=True)
    sender_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class Vehicle(Base):
    __tablename__ = "vehicles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plate: Mapped[str] = mapped_column(String(32), unique=True)
    kind: Mapped[str] = mapped_column(String(32))  # tent, reefer, dump, flatbed
    capacity_kg: Mapped[int] = mapped_column(Integer)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    driver_name: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(32), default="idle")  # idle, enroute, loading
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    heading: Mapped[float] = mapped_column(Float, default=0)
    live_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    home_id: Mapped[int] = mapped_column(ForeignKey("settlements.id"))
    current_order_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    owner: Mapped[User] = relationship(back_populates="vehicles", foreign_keys=[owner_id])
    assigned_driver: Mapped[User | None] = relationship(foreign_keys=[driver_id])
    home: Mapped[Settlement] = relationship()


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    origin_id: Mapped[int] = mapped_column(ForeignKey("settlements.id"))
    dest_id: Mapped[int] = mapped_column(ForeignKey("settlements.id"))
    cargo_type: Mapped[str] = mapped_column(String(48))
    cargo_title: Mapped[str] = mapped_column(String(200))
    weight_kg: Mapped[int] = mapped_column(Integer)
    price_offered: Mapped[int] = mapped_column(Integer)
    price_recommended: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), index=True, default="open")
    # open, taken, assigned, arrived, loading, transit, delivered, cancelled
    carrier_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id"), nullable=True)
    distance_km: Mapped[float] = mapped_column(Float, default=0)
    empty_km_saved: Mapped[float] = mapped_column(Float, default=0)
    is_backhaul: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    taken_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    sender: Mapped[User] = relationship(foreign_keys=[sender_id], back_populates="sent_orders")
    origin: Mapped[Settlement] = relationship(foreign_keys=[origin_id])
    dest: Mapped[Settlement] = relationship(foreign_keys=[dest_id])


class TrackPoint(Base):
    __tablename__ = "track_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"), index=True)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(16), default="sim")
    ts: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


class RouteCache(Base):
    __tablename__ = "route_cache"
    __table_args__ = (UniqueConstraint("origin_id", "dest_id", name="uq_route_od"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    origin_id: Mapped[int] = mapped_column(ForeignKey("settlements.id"))
    dest_id: Mapped[int] = mapped_column(ForeignKey("settlements.id"))
    distance_km: Mapped[float] = mapped_column(Float)
    duration_s: Mapped[float] = mapped_column(Float)
    geometry: Mapped[str] = mapped_column(Text)  # GeoJSON LineString coordinates JSON


class HistoricalTrip(Base):
    __tablename__ = "historical_trips"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    origin_id: Mapped[int] = mapped_column(ForeignKey("settlements.id"))
    dest_id: Mapped[int] = mapped_column(ForeignKey("settlements.id"))
    cargo_type: Mapped[str] = mapped_column(String(48))
    weight_kg: Mapped[int] = mapped_column(Integer)
    distance_km: Mapped[float] = mapped_column(Float)
    price_kzt: Mapped[int] = mapped_column(Integer)
    empty_return: Mapped[bool] = mapped_column(Boolean, default=True)

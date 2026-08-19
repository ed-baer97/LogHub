from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class SettlementOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    kind: str
    lat: float
    lon: float
    population: int
    note: str | None = None
    sender_id: int | None = None


class CorridorOut(BaseModel):
    id: str
    origin: str
    dest: str
    coords: list[list[float]]


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    role: str
    company: str | None = None
    phone: str | None = None
    carrier_id: int | None = None
    is_active: bool = True
    initial_password: str | None = None


class LoginIn(BaseModel):
    email: str
    password: str


class ProfileUpdate(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    current_password: str | None = None
    password: str | None = Field(default=None, min_length=6)


class TokenOut(BaseModel):
    token: str
    user: UserOut


class VehicleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plate: str
    kind: str
    capacity_kg: int
    owner_id: int
    driver_id: int | None = None
    driver_name: str
    status: str
    lat: float
    lon: float
    heading: float
    home_id: int
    current_order_id: int | None = None
    live: bool = False
    active: bool = True
    driver_email: str | None = None
    driver_phone: str | None = None
    driver_active: bool = True
    initial_password: str | None = None


class OrderCreate(BaseModel):
    origin_id: int
    dest_id: int
    cargo_type: str = "general"
    cargo_title: str
    weight_kg: int = Field(gt=0, lt=40000)
    price_offered: int | None = None


class OrderUpdate(BaseModel):
    origin_id: int | None = None
    dest_id: int | None = None
    cargo_type: str | None = None
    cargo_title: str | None = None
    weight_kg: int | None = Field(default=None, gt=0, lt=40000)
    price_offered: int | None = None


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sender_id: int
    origin_id: int
    dest_id: int
    origin_name: str
    dest_name: str
    cargo_type: str
    cargo_title: str
    weight_kg: int
    price_offered: int
    price_recommended: int
    status: str
    carrier_id: int | None = None
    vehicle_id: int | None = None
    distance_km: float
    empty_km_saved: float
    is_backhaul: bool
    created_at: datetime | None = None
    delivered_at: datetime | None = None
    origin_lat: float
    origin_lon: float
    dest_lat: float
    dest_lon: float
    sender_name: str | None = None
    plate: str | None = None


class TakeOrderIn(BaseModel):
    vehicle_id: int | None = None


class TrackPingIn(BaseModel):
    vehicle_id: int
    lat: float
    lon: float


class VehicleIdIn(BaseModel):
    vehicle_id: int


class MatchHint(BaseModel):
    order_id: int
    detour_km: float
    empty_km_saved: float
    fuel_saved_l: float
    money_saved_kzt: float
    reason: str


class QuoteOut(BaseModel):
    distance_km: float
    duration_min: float
    price_recommended: int
    geometry: list[list[float]]


class UserCreate(BaseModel):
    email: str
    name: str
    role: str = "sender"
    company: str | None = None
    phone: str | None = None
    password: str | None = Field(default=None, min_length=6)
    carrier_id: int | None = None


class UserUpdate(BaseModel):
    name: str | None = None
    company: str | None = None
    phone: str | None = None
    role: str | None = None
    is_active: bool | None = None


class PasswordResetIn(BaseModel):
    password: str | None = Field(default=None, min_length=6)


class SettlementCreate(BaseModel):
    name: str
    kind: str = "village"
    lat: float
    lon: float
    population: int = 0
    note: str | None = None


class SettlementUpdate(BaseModel):
    name: str | None = None
    kind: str | None = None
    lat: float | None = None
    lon: float | None = None
    population: int | None = None
    note: str | None = None


class OrderAssignIn(BaseModel):
    vehicle_id: int


class BortCreate(BaseModel):
    plate: str
    kind: str = "tent"
    capacity_kg: int = Field(gt=0, lt=60000)
    home_id: int
    driver_name: str
    driver_email: str
    driver_phone: str | None = None
    driver_password: str | None = Field(default=None, min_length=6)


class BortUpdate(BaseModel):
    plate: str | None = None
    kind: str | None = None
    capacity_kg: int | None = Field(default=None, gt=0, lt=60000)
    home_id: int | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    driver_email: str | None = None
    driver_password: str | None = Field(default=None, min_length=6)
    driver_active: bool | None = None
    active: bool | None = None

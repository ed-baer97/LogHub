from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class SettlementOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    kind: str
    lat: float
    lon: float
    population: int
    note: str | None = None


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    role: str
    company: str | None = None
    phone: str | None = None


class LoginIn(BaseModel):
    email: str
    password: str


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
    driver_name: str
    status: str
    lat: float
    lon: float
    heading: float
    home_id: int
    current_order_id: int | None = None
    live: bool = False


class OrderCreate(BaseModel):
    origin_id: int
    dest_id: int
    cargo_type: str = "general"
    cargo_title: str
    weight_kg: int = Field(gt=0, lt=40000)
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
    origin_lat: float
    origin_lon: float
    dest_lat: float
    dest_lon: float
    sender_name: str | None = None
    plate: str | None = None


class TakeOrderIn(BaseModel):
    vehicle_id: int


class TrackPingIn(BaseModel):
    vehicle_id: int
    lat: float
    lon: float


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
    password: str = "demo"


class UserUpdate(BaseModel):
    name: str | None = None
    company: str | None = None
    phone: str | None = None
    role: str | None = None


class VehicleCreate(BaseModel):
    plate: str
    kind: str = "tent"
    capacity_kg: int = Field(gt=0, lt=60000)
    owner_id: int
    driver_name: str
    home_id: int


class VehicleUpdate(BaseModel):
    plate: str | None = None
    kind: str | None = None
    capacity_kg: int | None = None
    owner_id: int | None = None
    driver_name: str | None = None
    home_id: int | None = None
    status: str | None = None


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

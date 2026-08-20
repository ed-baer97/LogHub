from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./caspian.db"
    secret_key: str = "caspian-hackathon-secret"
    superadmin_password: str = "demo"
    cors_origins: str = "http://localhost:5173,http://localhost:80,http://localhost,http://127.0.0.1:5173"
    osrm_url: str = "https://router.project-osrm.org"
    osrm_fallback_url: str = "https://router.project-osrm.org"
    sim_speed_kmh: float = 420.0
    sim_tick_s: float = 1.5
    redis_url: str = ""
    jwt_expire_hours: int = 168
    ping_min_interval_s: float = 3
    track_flush_s: float = 20
    track_retention_days: int = 14
    live_ttl_s: int = 60
    db_pool_size: int = 10
    db_max_overflow: int = 20
    cache_ttl_s: int = 45

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()

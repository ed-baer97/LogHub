from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./caspian.db"
    secret_key: str = "caspian-hackathon-secret"
    cors_origins: str = "http://localhost:5173,http://localhost:80,http://localhost,http://127.0.0.1:5173"
    osrm_url: str = "https://router.project-osrm.org"
    sim_speed_kmh: float = 420.0  # accelerated so the pitch demo is visible
    sim_tick_s: float = 1.5

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()

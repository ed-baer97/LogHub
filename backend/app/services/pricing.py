from __future__ import annotations

import numpy as np
from sqlalchemy.orm import Session

from app.models import HistoricalTrip

CARGO_INDEX = {
    "general": 0,
    "perishable": 1,
    "construction": 2,
    "fuel": 3,
    "livestock": 4,
}


class PriceModel:
    def __init__(self) -> None:
        self.coef: np.ndarray | None = None

    def fit(self, db: Session) -> None:
        rows = db.query(HistoricalTrip).all()
        if len(rows) < 8:
            self.coef = np.array([9000.0, 48.0, 11.0, 0, 4000, 2500, 6000, 1800])
            return
        x = []
        y = []
        for t in rows:
            onehot = [0.0] * len(CARGO_INDEX)
            onehot[CARGO_INDEX.get(t.cargo_type, 0)] = 1.0
            x.append([1.0, t.distance_km, t.weight_kg / 100.0, *onehot])
            y.append(t.price_kzt)
        mat = np.array(x)
        vec = np.array(y, dtype=float)
        self.coef, *_ = np.linalg.lstsq(mat, vec, rcond=None)

    def predict(self, distance_km: float, weight_kg: int, cargo_type: str) -> int:
        if self.coef is None:
            base = 9000 + 48 * distance_km + 0.11 * weight_kg
            bump = {
                "perishable": 1.22,
                "construction": 1.08,
                "fuel": 1.35,
                "livestock": 1.18,
            }.get(cargo_type, 1.0)
            return int(round(base * bump, -2))
        onehot = [0.0] * len(CARGO_INDEX)
        onehot[CARGO_INDEX.get(cargo_type, 0)] = 1.0
        feats = np.array([1.0, distance_km, weight_kg / 100.0, *onehot])
        # coef may be shorter if fallback
        n = min(len(self.coef), len(feats))
        price = float(self.coef[:n] @ feats[:n])
        return int(max(8000, round(price, -2)))


price_model = PriceModel()

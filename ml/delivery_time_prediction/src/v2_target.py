"""One stochastic target-generation process shared by the v2 synthetic splits."""

from __future__ import annotations

import math
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np


BENGALURU_TIMEZONE = ZoneInfo("Asia/Kolkata")
PRIORITY_FACTOR = {"standard": 1.0, "express": 0.94, "urgent": 0.88}
PACKAGE_FACTOR = {
    "documents": 0.96,
    "parcel": 1.0,
    "food": 1.06,
    "fragile": 1.12,
    "heavy_goods": 1.27,
    "other": 1.03,
}


def bengaluru_local_time(assigned_at: datetime) -> datetime:
    """Convert an aware timestamp into Bengaluru local time."""
    if assigned_at.utcoffset() is None:
        raise ValueError("assigned_at must include a timezone.")
    return assigned_at.astimezone(BENGALURU_TIMEZONE)


def expected_delivery_duration(
    straight_line_distance_km: float,
    priority: str,
    package_category: str,
    weight_kg: float,
    quantity: int,
    assigned_at: datetime,
    randomizer: np.random.Generator,
) -> float:
    """Simulate an outcome with travel, traffic, handling, and random delays."""
    if not math.isfinite(straight_line_distance_km) or straight_line_distance_km < 0:
        raise ValueError("Distance must be finite and non-negative.")
    if not math.isfinite(weight_kg) or weight_kg <= 0 or quantity < 1:
        raise ValueError("Weight and quantity must be positive.")
    if priority not in PRIORITY_FACTOR or package_category not in PACKAGE_FACTOR:
        raise ValueError("Priority or package category is not supported.")

    local_time = bengaluru_local_time(assigned_at)
    weekday = local_time.weekday() < 5
    rush_hour = weekday and (
        7 <= local_time.hour < 10 or 16 <= local_time.hour < 20
    )
    if rush_hour:
        congestion = float(randomizer.uniform(1.12, 1.42))
    elif weekday:
        congestion = float(randomizer.uniform(0.96, 1.20))
    else:
        congestion = float(randomizer.uniform(0.90, 1.16))

    route_multiplier = float(randomizer.triangular(1.12, 1.31, 1.52))
    average_speed_kmh = float(randomizer.uniform(21, 32))
    road_distance_km = straight_line_distance_km * route_multiplier
    travel_minutes = road_distance_km / average_speed_kmh * 60 * congestion
    handling_minutes = 6.0 + 0.72 * math.sqrt(weight_kg) + 1.1 * (quantity - 1)
    unexpected_delay = float(randomizer.gamma(shape=1.7, scale=1.7))
    random_noise = float(randomizer.normal(0, max(2.5, travel_minutes * 0.09)))

    duration = travel_minutes * PRIORITY_FACTOR[priority] * PACKAGE_FACTOR[package_category]
    duration += handling_minutes + unexpected_delay + random_noise
    return round(max(5.0, duration), 2)

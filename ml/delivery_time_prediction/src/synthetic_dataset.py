"""Generate a separate, clearly labeled prototype dataset for experimentation."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, get_args

import numpy as np
import pandas as pd

from . import training
from .dataset import straight_line_distance_km
from .schemas import PackageCategory, Priority


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC_DATASET_PATH = (
    WORKSPACE_ROOT / "data" / "processed" / "synthetic_delivery_time_dataset.csv"
)
DEFAULT_RECORD_COUNT = 10_000
RANDOM_SEED = 42
TARGET_COLUMN = training.TARGET_COLUMN
DATA_SOURCE_COLUMN = "data_source"
RECORD_ID_COLUMN = "synthetic_record_id"
BENGALURU_CENTER = (12.9716, 77.5946)
MAX_CITY_RADIUS_KM = 18.0
FIRST_ASSIGNMENT_TIME = datetime(2025, 1, 1, tzinfo=timezone.utc)
SECONDS_BETWEEN_ASSIGNMENTS = 3_154

PRIORITIES = get_args(Priority)
PACKAGE_CATEGORIES = get_args(PackageCategory)
PRIORITY_PROBABILITIES = [0.68, 0.25, 0.07]
PACKAGE_PROBABILITIES = [0.12, 0.52, 0.18, 0.08, 0.06, 0.04]


def random_city_point(randomizer: np.random.Generator) -> tuple[float, float]:
    """Choose a point within the Bengaluru metro area around the city center."""
    angle = randomizer.uniform(0, 2 * math.pi)
    radius_km = MAX_CITY_RADIUS_KM * math.sqrt(randomizer.random())
    north_km = radius_km * math.cos(angle)
    east_km = radius_km * math.sin(angle)
    latitude, longitude = BENGALURU_CENTER
    latitude += north_km / 111.1
    longitude += east_km / (111.1 * math.cos(math.radians(latitude)))
    return round(latitude, 6), round(longitude, 6)


def package_weight(
    category: str, randomizer: np.random.Generator
) -> float:
    weight_ranges = {
        "documents": (0.1, 2.0),
        "parcel": (0.2, 20.0),
        "food": (0.2, 8.0),
        "fragile": (0.2, 12.0),
        "heavy_goods": (5.0, 80.0),
        "other": (0.2, 15.0),
    }
    low, high = weight_ranges[category]
    return round(float(randomizer.uniform(low, high)), 2)


def traffic_factor(assigned_at: datetime) -> float:
    """Estimate a traffic multiplier using information known at assignment."""
    hour = assigned_at.hour
    weekday = assigned_at.weekday()
    if weekday < 5 and (7 <= hour < 10 or 16 <= hour < 20):
        return 1.28
    if weekday < 5 and 10 <= hour < 16:
        return 1.05
    if weekday >= 5 and 11 <= hour < 19:
        return 1.12
    return 0.94


def expected_duration_minutes(
    distance_km: float,
    priority: str,
    category: str,
    weight_kg: float,
    quantity: int,
    assigned_at: datetime,
    randomizer: np.random.Generator,
) -> float:
    """Make a varied label from assignment-time inputs and random noise."""
    priority_factor = {"standard": 1.0, "express": 0.86, "urgent": 0.76}[priority]
    package_factor = {
        "documents": 0.92,
        "parcel": 1.0,
        "food": 1.06,
        "fragile": 1.08,
        "heavy_goods": 1.22,
        "other": 1.03,
    }[category]
    handling_minutes = 0.65 * math.sqrt(weight_kg) + 0.8 * (quantity - 1)
    route_minutes = 11.0 + 3.1 * distance_km
    estimate = route_minutes * traffic_factor(assigned_at) * priority_factor * package_factor
    noise = randomizer.normal(0.0, max(3.0, estimate * 0.11))
    return round(max(6.0, estimate + handling_minutes + noise), 2)


def validate_synthetic_dataset(dataframe: pd.DataFrame) -> None:
    """Reject generated data with missing, duplicate, or invalid values."""
    required_columns = set(training.RAW_FEATURE_COLUMNS) | {
        TARGET_COLUMN,
        DATA_SOURCE_COLUMN,
        RECORD_ID_COLUMN,
    }
    missing_columns = sorted(required_columns - set(dataframe.columns))
    if missing_columns:
        raise ValueError(f"Synthetic dataset is missing columns: {', '.join(missing_columns)}")
    if dataframe.empty:
        raise ValueError("Synthetic dataset must contain at least one record.")
    if not dataframe[DATA_SOURCE_COLUMN].eq("synthetic").all():
        raise ValueError("Every generated record must be labeled synthetic.")
    if not dataframe[RECORD_ID_COLUMN].is_unique:
        raise ValueError("Synthetic record IDs must be unique.")
    if dataframe.duplicated(subset=training.RAW_FEATURE_COLUMNS + [TARGET_COLUMN]).any():
        raise ValueError("Duplicate synthetic feature and target rows were found.")

    created_at = pd.to_datetime(dataframe["request_created_at"], utc=True, errors="coerce")
    assigned_at = pd.to_datetime(dataframe["assigned_at"], utc=True, errors="coerce")
    if created_at.isna().any() or assigned_at.isna().any():
        raise ValueError("Synthetic request and assignment timestamps must be valid.")
    if (assigned_at < created_at).any():
        raise ValueError("Assignment timestamps cannot precede request creation.")

    for column, minimum, maximum in (
        ("pickup_latitude", -90, 90),
        ("destination_latitude", -90, 90),
        ("pickup_longitude", -180, 180),
        ("destination_longitude", -180, 180),
    ):
        values = pd.to_numeric(dataframe[column], errors="coerce")
        if values.isna().any() or not np.isfinite(values).all():
            raise ValueError(f"{column} must contain finite coordinates.")
        if ((values < minimum) | (values > maximum)).any():
            raise ValueError(f"{column} is outside its valid range.")

    weight = pd.to_numeric(dataframe["weight_kg"], errors="coerce")
    quantity = pd.to_numeric(dataframe["quantity"], errors="coerce")
    duration = pd.to_numeric(dataframe[TARGET_COLUMN], errors="coerce")
    distance = pd.to_numeric(dataframe["straight_line_distance_km"], errors="coerce")
    if weight.isna().any() or not np.isfinite(weight).all() or (weight <= 0).any():
        raise ValueError("Synthetic package weights must be finite and positive.")
    if quantity.isna().any() or not np.isfinite(quantity).all():
        raise ValueError("Synthetic quantities must be finite positive integers.")
    if (quantity <= 0).any() or (quantity % 1 != 0).any():
        raise ValueError("Synthetic quantities must be finite positive integers.")
    if duration.isna().any() or not np.isfinite(duration).all() or (duration <= 0).any():
        raise ValueError("Synthetic delivery durations must be finite and positive.")
    if distance.isna().any() or not np.isfinite(distance).all() or (distance < 0).any():
        raise ValueError("Synthetic distances must be finite and non-negative.")

    if not dataframe["priority"].isin(PRIORITIES).all():
        raise ValueError("Synthetic priorities must use supported SWERV values.")
    if not dataframe["package_category"].isin(PACKAGE_CATEGORIES).all():
        raise ValueError("Synthetic categories must use supported SWERV values.")


def generate_synthetic_dataset(
    record_count: int = DEFAULT_RECORD_COUNT,
    random_seed: int = RANDOM_SEED,
) -> pd.DataFrame:
    """Generate synthetic Bengaluru examples without touching MongoDB."""
    if not isinstance(record_count, int) or record_count <= 0:
        raise ValueError("record_count must be a positive integer.")

    randomizer = np.random.default_rng(random_seed)
    rows: list[dict[str, Any]] = []
    for index in range(record_count):
        assigned_at = FIRST_ASSIGNMENT_TIME + timedelta(
            seconds=index * SECONDS_BETWEEN_ASSIGNMENTS
        )
        created_at = assigned_at - timedelta(minutes=int(randomizer.integers(2, 26)))
        priority = str(randomizer.choice(PRIORITIES, p=PRIORITY_PROBABILITIES))
        category = str(randomizer.choice(PACKAGE_CATEGORIES, p=PACKAGE_PROBABILITIES))
        weight_kg = package_weight(category, randomizer)
        quantity = int(randomizer.integers(1, 5))
        pickup_latitude, pickup_longitude = random_city_point(randomizer)
        destination_latitude, destination_longitude = random_city_point(randomizer)
        distance_km = straight_line_distance_km(
            (pickup_latitude, pickup_longitude),
            (destination_latitude, destination_longitude),
        )
        duration_minutes = expected_duration_minutes(
            distance_km,
            priority,
            category,
            weight_kg,
            quantity,
            assigned_at,
            randomizer,
        )
        delivered_at = assigned_at + timedelta(minutes=duration_minutes)
        target_minutes = (delivered_at - assigned_at).total_seconds() / 60

        rows.append({
            RECORD_ID_COLUMN: f"SYN-{index + 1:06d}",
            "request_created_at": created_at.isoformat().replace("+00:00", "Z"),
            "assigned_at": assigned_at.isoformat().replace("+00:00", "Z"),
            "priority": priority,
            "package_category": category,
            "weight_kg": weight_kg,
            "quantity": quantity,
            "pickup_latitude": pickup_latitude,
            "pickup_longitude": pickup_longitude,
            "destination_latitude": destination_latitude,
            "destination_longitude": destination_longitude,
            "straight_line_distance_km": round(distance_km, 3),
            TARGET_COLUMN: round(target_minutes, 2),
            DATA_SOURCE_COLUMN: "synthetic",
        })

    dataframe = pd.DataFrame(rows)
    validate_synthetic_dataset(dataframe)
    return dataframe


def main() -> None:
    dataframe = generate_synthetic_dataset()
    SYNTHETIC_DATASET_PATH.parent.mkdir(parents=True, exist_ok=True)
    dataframe.to_csv(SYNTHETIC_DATASET_PATH, index=False)
    print(json.dumps({
        "records_generated": len(dataframe),
        "data_source": "synthetic",
        "dataset_path": str(SYNTHETIC_DATASET_PATH),
    }, indent=2))


if __name__ == "__main__":
    main()

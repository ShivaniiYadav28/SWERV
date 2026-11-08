"""Generate versioned training and validation data with the shared v2 target."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import training
from .dataset import straight_line_distance_km
from .v2_target import expected_delivery_duration


WORKSPACE = Path(__file__).resolve().parents[1]
V2_DATA_DIR = WORKSPACE / "data" / "processed" / "v2"
TRAIN_PATH = V2_DATA_DIR / "training_dataset.csv"
VALIDATION_PATH = V2_DATA_DIR / "validation_dataset.csv"
GENERATION_REPORT_PATH = V2_DATA_DIR / "dataset_generation_report.json"
TRAIN_RECORDS = 10_000
VALIDATION_RECORDS = 2_000
TRAIN_SEED = 31_500_101
VALIDATION_SEED = 31_500_202
DATA_SOURCE = "synthetic_v2"
RECORD_ID_COLUMN = "scenario_id"
CATEGORIES = ["documents", "parcel", "food", "fragile", "heavy_goods", "other"]
PRIORITIES = ["standard", "express", "urgent"]
MAX_CITY_RADIUS_KM = 25.0
ASSIGNMENT_INTERVAL_MINUTES = 47
COORDINATE_MISSING_RATE = 0.035


def random_city_point(randomizer: np.random.Generator) -> tuple[float, float]:
    angle = float(randomizer.uniform(0, math.tau))
    radius = MAX_CITY_RADIUS_KM * math.sqrt(float(randomizer.random()))
    latitude = 12.9716 + radius * math.cos(angle) / 111.1
    longitude = 77.5946 + radius * math.sin(angle) / (
        111.1 * math.cos(math.radians(latitude))
    )
    return round(latitude, 6), round(longitude, 6)


def random_package_weight(
    category: str,
    randomizer: np.random.Generator,
) -> float:
    ranges = {
        "documents": (0.1, 2.5),
        "parcel": (0.2, 25),
        "food": (0.2, 9),
        "fragile": (0.2, 15),
        "heavy_goods": (5, 90),
        "other": (0.2, 18),
    }
    low, high = ranges[category]
    return round(float(randomizer.uniform(low, high)), 2)


def generate_dataset(
    record_count: int,
    random_seed: int,
    first_assignment: datetime,
    split_name: str,
) -> pd.DataFrame:
    """Create one split; each row is a unique delivery scenario."""
    if record_count <= 0 or first_assignment.utcoffset() is None:
        raise ValueError("Record count must be positive and the first timestamp timezone-aware.")
    randomizer = np.random.default_rng(random_seed)
    rows: list[dict[str, Any]] = []

    for index in range(record_count):
        jitter_minutes = int(randomizer.integers(-6, 7))
        assigned_at = first_assignment + timedelta(
            minutes=index * ASSIGNMENT_INTERVAL_MINUTES + jitter_minutes
        )
        request_delay_minutes = int(randomizer.integers(3, 91))
        created_at = assigned_at - timedelta(minutes=request_delay_minutes)
        priority = str(randomizer.choice(PRIORITIES, p=[0.66, 0.26, 0.08]))
        category = str(randomizer.choice(CATEGORIES, p=[0.12, 0.5, 0.16, 0.08, 0.08, 0.06]))
        weight = random_package_weight(category, randomizer)
        quantity = int(randomizer.integers(1, 6))
        true_pickup = random_city_point(randomizer)
        true_destination = random_city_point(randomizer)
        true_distance = straight_line_distance_km(true_pickup, true_destination)
        duration = expected_delivery_duration(
            true_distance, priority, category, weight, quantity, assigned_at, randomizer
        )

        pickup_is_available = randomizer.random() >= COORDINATE_MISSING_RATE
        destination_is_available = randomizer.random() >= COORDINATE_MISSING_RATE
        pickup_latitude, pickup_longitude = (
            true_pickup if pickup_is_available else (np.nan, np.nan)
        )
        destination_latitude, destination_longitude = (
            true_destination if destination_is_available else (np.nan, np.nan)
        )
        observed_distance = (
            straight_line_distance_km(true_pickup, true_destination)
            if pickup_is_available and destination_is_available
            else np.nan
        )

        rows.append({
            RECORD_ID_COLUMN: f"{split_name.upper()}-{index + 1:05d}",
            "request_created_at": created_at.isoformat().replace("+00:00", "Z"),
            "assigned_at": assigned_at.isoformat().replace("+00:00", "Z"),
            "priority": priority,
            "package_category": category,
            "weight_kg": weight,
            "quantity": quantity,
            "pickup_latitude": pickup_latitude,
            "pickup_longitude": pickup_longitude,
            "destination_latitude": destination_latitude,
            "destination_longitude": destination_longitude,
            "straight_line_distance_km": observed_distance,
            training.TARGET_COLUMN: duration,
            "data_source": DATA_SOURCE,
            "dataset_split": split_name,
        })

    dataset = pd.DataFrame(rows)
    validate_dataset(dataset, split_name)
    return dataset


def validate_dataset(dataset: pd.DataFrame, expected_split: str) -> None:
    required = set(training.RAW_FEATURE_COLUMNS) | {
        training.TARGET_COLUMN, "data_source", "dataset_split", RECORD_ID_COLUMN,
    }
    missing = sorted(required - set(dataset.columns))
    if missing:
        raise ValueError(f"Dataset is missing columns: {', '.join(missing)}")
    if dataset.empty or not dataset["data_source"].eq(DATA_SOURCE).all():
        raise ValueError("Every v2 row must be labeled synthetic_v2.")
    if not dataset["dataset_split"].eq(expected_split).all():
        raise ValueError("Dataset split labels do not match the requested split.")
    if not dataset[RECORD_ID_COLUMN].is_unique:
        raise ValueError("Scenario IDs must be unique within a dataset split.")
    if dataset.duplicated(training.RAW_FEATURE_COLUMNS + [training.TARGET_COLUMN]).any():
        raise ValueError("Duplicate prediction features and target rows were found.")

    created = pd.to_datetime(dataset["request_created_at"], utc=True, errors="coerce")
    assigned = pd.to_datetime(dataset["assigned_at"], utc=True, errors="coerce")
    if created.isna().any() or assigned.isna().any() or (assigned < created).any():
        raise ValueError("Timestamps must be valid and assignment must follow request creation.")

    for latitude_name, longitude_name, minimum, maximum in (
        ("pickup_latitude", "pickup_longitude", -90, 90),
        ("destination_latitude", "destination_longitude", -90, 90),
    ):
        latitude = pd.to_numeric(dataset[latitude_name], errors="coerce")
        longitude = pd.to_numeric(dataset[longitude_name], errors="coerce")
        if (
            (dataset[latitude_name].notna() & latitude.isna()).any()
            or (dataset[longitude_name].notna() & longitude.isna()).any()
        ):
            raise ValueError(f"{latitude_name} or {longitude_name} contains a non-numeric coordinate.")
        if latitude.isna().ne(longitude.isna()).any():
            raise ValueError(f"{latitude_name} and {longitude_name} must be missing together.")
        if not np.isfinite(latitude.dropna()).all() or not np.isfinite(longitude.dropna()).all():
            raise ValueError(f"{latitude_name} and {longitude_name} must be finite.")
        if ((latitude.dropna() < minimum) | (latitude.dropna() > maximum)).any():
            raise ValueError(f"{latitude_name} is outside valid coordinate bounds.")
        if ((longitude.dropna() < -180) | (longitude.dropna() > 180)).any():
            raise ValueError(f"{longitude_name} is outside valid coordinate bounds.")

    for column in ("weight_kg", "quantity", training.TARGET_COLUMN):
        values = pd.to_numeric(dataset[column], errors="coerce")
        if values.isna().any() or not np.isfinite(values).all() or (values <= 0).any():
            raise ValueError(f"{column} must contain finite positive values.")
    if (dataset["quantity"] % 1 != 0).any() or (dataset["quantity"] > 5).any():
        raise ValueError("Quantity must be a whole number from 1 through 5.")
    distances = pd.to_numeric(dataset["straight_line_distance_km"], errors="coerce").dropna()
    if not np.isfinite(distances).all() or (distances < 0).any():
        raise ValueError("Observed distances must be finite and non-negative.")
    if not dataset["priority"].isin(PRIORITIES).all() or not dataset["package_category"].isin(CATEGORIES).all():
        raise ValueError("Priority or package category is unsupported.")


def feature_target_fingerprints(dataset: pd.DataFrame) -> set[int]:
    columns = training.RAW_FEATURE_COLUMNS + [training.TARGET_COLUMN]
    return set(pd.util.hash_pandas_object(dataset[columns].astype(str), index=False).tolist())


def generate_train_and_validation() -> dict[str, Any]:
    train_data = generate_dataset(
        TRAIN_RECORDS, TRAIN_SEED,
        datetime(2025, 1, 1, tzinfo=timezone.utc), "training",
    )
    validation_data = generate_dataset(
        VALIDATION_RECORDS, VALIDATION_SEED,
        datetime(2025, 12, 20, tzinfo=timezone.utc), "validation",
    )
    shared_ids = set(train_data[RECORD_ID_COLUMN]) & set(validation_data[RECORD_ID_COLUMN])
    shared_rows = feature_target_fingerprints(train_data) & feature_target_fingerprints(validation_data)
    if shared_ids or shared_rows:
        raise ValueError("Training and validation records overlap.")

    V2_DATA_DIR.mkdir(parents=True, exist_ok=True)
    train_data.to_csv(TRAIN_PATH, index=False)
    validation_data.to_csv(VALIDATION_PATH, index=False)
    report = {
        "data_source": DATA_SOURCE,
        "target_generation_method": "shared v2_target.expected_delivery_duration",
        "training_records": len(train_data),
        "validation_records": len(validation_data),
        "training_seed": TRAIN_SEED,
        "validation_seed": VALIDATION_SEED,
        "training_scenarios": int(train_data[RECORD_ID_COLUMN].nunique()),
        "validation_scenarios": int(validation_data[RECORD_ID_COLUMN].nunique()),
        "overlapping_scenario_ids": len(shared_ids),
        "overlapping_feature_target_rows": len(shared_rows),
        "training_path": str(TRAIN_PATH),
        "validation_path": str(VALIDATION_PATH),
        "training_missing_coordinate_rows": int(train_data[[
            "pickup_latitude", "pickup_longitude", "destination_latitude",
            "destination_longitude",
        ]].isna().any(axis=1).sum()),
        "validation_missing_coordinate_rows": int(validation_data[[
            "pickup_latitude", "pickup_longitude", "destination_latitude",
            "destination_longitude",
        ]].isna().any(axis=1).sum()),
    }
    GENERATION_REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    print(json.dumps(generate_train_and_validation(), indent=2))


if __name__ == "__main__":
    main()

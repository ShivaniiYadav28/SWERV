"""Prediction-time features for the version 2 delivery model."""

from __future__ import annotations

import pandas as pd

from .v2_target import bengaluru_local_time
from .training import RAW_FEATURE_COLUMNS


FEATURE_VERSION = "v2"
CATEGORICAL_COLUMNS = ["priority", "package_category"]
NUMERICAL_COLUMNS = [
    "request_to_assignment_minutes",
    "request_created_local_hour",
    "request_created_local_day_of_week",
    "assigned_local_hour",
    "assigned_local_day_of_week",
    "weight_kg",
    "quantity",
    "pickup_latitude",
    "pickup_longitude",
    "destination_latitude",
    "destination_longitude",
    "straight_line_distance_km",
    "pickup_coordinates_available",
    "destination_coordinates_available",
    "complete_coordinates_available",
]
FEATURE_COLUMNS = CATEGORICAL_COLUMNS + NUMERICAL_COLUMNS


def build_features(dataset: pd.DataFrame) -> pd.DataFrame:
    """Use only the approved raw fields and derive local-time/missingness flags."""
    missing = sorted(set(RAW_FEATURE_COLUMNS) - set(dataset.columns))
    if missing:
        raise ValueError(f"Dataset is missing raw features: {', '.join(missing)}")

    raw = dataset.loc[:, RAW_FEATURE_COLUMNS].copy()
    created_at = pd.to_datetime(raw.pop("request_created_at"), utc=True, errors="coerce")
    assigned_at = pd.to_datetime(raw.pop("assigned_at"), utc=True, errors="coerce")
    if created_at.isna().any() or assigned_at.isna().any():
        raise ValueError("Request and assignment timestamps must be valid.")
    created_local = created_at.map(lambda value: bengaluru_local_time(value.to_pydatetime()))
    assigned_local = assigned_at.map(lambda value: bengaluru_local_time(value.to_pydatetime()))

    pickup_available = raw["pickup_latitude"].notna() & raw["pickup_longitude"].notna()
    destination_available = (
        raw["destination_latitude"].notna() & raw["destination_longitude"].notna()
    )
    raw["request_to_assignment_minutes"] = (
        assigned_at - created_at
    ).dt.total_seconds() / 60
    raw["request_created_local_hour"] = created_local.map(lambda value: value.hour)
    raw["request_created_local_day_of_week"] = created_local.map(lambda value: value.weekday())
    raw["assigned_local_hour"] = assigned_local.map(lambda value: value.hour)
    raw["assigned_local_day_of_week"] = assigned_local.map(lambda value: value.weekday())
    raw["pickup_coordinates_available"] = pickup_available.astype(int)
    raw["destination_coordinates_available"] = destination_available.astype(int)
    raw["complete_coordinates_available"] = (
        pickup_available & destination_available & raw["straight_line_distance_km"].notna()
    ).astype(int)
    return raw.loc[:, FEATURE_COLUMNS]

"""Shared assignment-time feature definitions and preprocessing."""

from __future__ import annotations

import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder


TARGET_COLUMN = "delivery_duration_minutes"
GROUP_COLUMN = "dispatch_scenario_id"
DATA_SOURCE_COLUMN = "data_source"
TIME_COLUMN = "recommendation_time"
CATEGORICAL_COLUMNS = [
    "priority",
    "package_category",
    "vehicle_type",
    "capability_profile",
]
NUMERICAL_COLUMNS = [
    "weight_kg",
    "quantity",
    "pickup_to_destination_km",
    "agent_to_pickup_km",
    "active_workload",
    "max_capacity",
    "workload_ratio",
    "gps_fresh",
    "completed_delivery_count",
    "historical_median_minutes",
    "recommendation_hour",
    "recommendation_day_of_week",
]
FEATURE_COLUMNS = CATEGORICAL_COLUMNS + NUMERICAL_COLUMNS
RAW_FEATURE_COLUMNS = [TIME_COLUMN, *CATEGORICAL_COLUMNS, *NUMERICAL_COLUMNS[:10]]


def build_features(rows: pd.DataFrame) -> pd.DataFrame:
    """Select the approved candidate-time fields and derive time features."""
    missing = sorted(set(RAW_FEATURE_COLUMNS) - set(rows.columns))
    if missing:
        raise ValueError(f"Dataset is missing required features: {', '.join(missing)}")

    features = rows.loc[:, RAW_FEATURE_COLUMNS].copy()
    recommendation_time = pd.to_datetime(
        features.pop(TIME_COLUMN), utc=True, errors="coerce"
    )
    features["recommendation_hour"] = recommendation_time.dt.hour
    features["recommendation_day_of_week"] = recommendation_time.dt.dayofweek
    return features.loc[:, FEATURE_COLUMNS]


def create_preprocessor() -> ColumnTransformer:
    numeric = Pipeline([("imputer", SimpleImputer(strategy="median"))])
    categorical = Pipeline([
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("one_hot", OneHotEncoder(handle_unknown="ignore")),
    ])
    return ColumnTransformer([
        ("numeric", numeric, NUMERICAL_COLUMNS),
        ("categorical", categorical, CATEGORICAL_COLUMNS),
    ])

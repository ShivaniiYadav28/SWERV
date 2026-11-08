"""Build demand forecasting features from previous UTC-hour observations."""

from __future__ import annotations

import numpy as np
import pandas as pd


TARGET_COLUMN = "request_count"
FEATURE_COLUMNS = [
    "hour_of_day",
    "day_of_week",
    "month",
    "is_weekend",
    "previous_hour_demand",
    "previous_day_same_hour_demand",
    "previous_week_same_hour_demand",
    "previous_24_hour_average",
]
HOURS_PER_DAY = 24
HOURS_PER_WEEK = 24 * 7


def build_time_features(dataset: pd.DataFrame) -> pd.DataFrame:
    """Return rows with calendar, lag, and past-only rolling features."""
    required_columns = {"timestamp", TARGET_COLUMN, "data_source"}
    missing_columns = required_columns - set(dataset.columns)
    if missing_columns:
        raise ValueError(f"Dataset is missing columns: {', '.join(sorted(missing_columns))}")
    if dataset.empty or not dataset["data_source"].eq("synthetic").all():
        raise ValueError("Training data must contain rows labeled synthetic.")

    result = dataset[["timestamp", TARGET_COLUMN]].copy()
    result["timestamp"] = pd.to_datetime(result["timestamp"], utc=True, errors="coerce")
    if result["timestamp"].isna().any():
        raise ValueError("Every timestamp must be a valid UTC date.")
    if not result["timestamp"].is_monotonic_increasing:
        raise ValueError("Timestamps must be in chronological order.")
    if result["timestamp"].duplicated().any():
        raise ValueError("Timestamps must be unique.")
    if len(result) > 1 and not result["timestamp"].diff().iloc[1:].eq(pd.Timedelta(hours=1)).all():
        raise ValueError("Timestamps must form a continuous hourly sequence.")

    request_counts = pd.to_numeric(result[TARGET_COLUMN], errors="coerce")
    if (
        request_counts.isna().any()
        or (request_counts < 0).any()
        or not np.equal(request_counts, np.floor(request_counts)).all()
    ):
        raise ValueError("request_count must contain non-negative integers.")
    result[TARGET_COLUMN] = request_counts.astype("int64")

    timestamps = result["timestamp"]
    result["hour_of_day"] = timestamps.dt.hour
    result["day_of_week"] = timestamps.dt.dayofweek
    result["month"] = timestamps.dt.month
    result["is_weekend"] = (timestamps.dt.dayofweek >= 5).astype(int)
    result["previous_hour_demand"] = request_counts.shift(1)
    result["previous_day_same_hour_demand"] = request_counts.shift(HOURS_PER_DAY)
    result["previous_week_same_hour_demand"] = request_counts.shift(HOURS_PER_WEEK)
    result["previous_24_hour_average"] = request_counts.shift(1).rolling(
        window=HOURS_PER_DAY,
        min_periods=HOURS_PER_DAY,
    ).mean()

    result = result.dropna(subset=FEATURE_COLUMNS).reset_index(drop=True)
    if result.empty:
        raise ValueError("At least one week of history is required to build lag features.")
    return result


def split_chronologically(
    featured_dataset: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Split older rows into train, validation, and final test periods."""
    if len(featured_dataset) < 3:
        raise ValueError("At least three feature rows are required for a chronological split.")
    if not featured_dataset["timestamp"].is_monotonic_increasing:
        raise ValueError("Featured rows must be in chronological order before splitting.")

    training_end = int(len(featured_dataset) * 0.70)
    validation_size = int(len(featured_dataset) * 0.15)
    validation_end = training_end + validation_size
    if training_end == 0 or validation_size == 0 or validation_end >= len(featured_dataset):
        raise ValueError("Dataset is too small for 70/15/15 chronological splits.")

    training = featured_dataset.iloc[:training_end].copy()
    validation = featured_dataset.iloc[training_end:validation_end].copy()
    final_test = featured_dataset.iloc[validation_end:].copy()
    return training, validation, final_test

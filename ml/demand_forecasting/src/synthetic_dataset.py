"""Create clearly labeled synthetic hourly dispatch demand examples."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd


WORKSPACE = Path(__file__).resolve().parents[1]
DATASET_PATH = WORKSPACE / "data" / "synthetic_hourly_demand.csv"
START_TIMESTAMP = "2024-01-01T00:00:00Z"
END_TIMESTAMP = "2026-01-01T00:00:00Z"  # Exclusive end: covers 2024 and 2025.
RANDOM_SEED = 303
HOUR_FACTORS = np.array([
    0.12, 0.08, 0.06, 0.05, 0.06, 0.12,
    0.30, 0.55, 0.72, 0.78, 0.76, 0.80,
    0.92, 0.90, 0.83, 0.78, 0.82, 1.00,
    1.18, 1.22, 1.08, 0.82, 0.52, 0.28,
])
SPIKE_PROBABILITY = 0.008


def generate_hourly_demand(seed: int = RANDOM_SEED) -> pd.DataFrame:
    """Generate one synthetic request count for every UTC hour in two years."""
    if not isinstance(seed, int):
        raise ValueError("seed must be an integer.")

    timestamps = pd.date_range(
        start=START_TIMESTAMP,
        end=END_TIMESTAMP,
        freq="h",
        inclusive="left",
    )
    randomizer = np.random.default_rng(seed)
    hour_of_day = timestamps.hour.to_numpy()
    day_of_week = timestamps.dayofweek.to_numpy()
    is_weekend = (day_of_week >= 5).astype(int)
    month = timestamps.month.to_numpy()
    trend_index = np.arange(len(timestamps), dtype=float) / max(len(timestamps) - 1, 1)

    day_indexes = np.arange(len(timestamps)) // 24
    daily_noise = randomizer.lognormal(mean=0.0, sigma=0.12, size=day_indexes.max() + 1)
    weekend_factor = np.where(is_weekend == 1, 0.78, 1.0)
    trend_factor = 0.85 + (0.30 * trend_index)
    seasonal_factor = 1.0 + 0.08 * np.sin(2 * np.pi * (month - 1) / 12)
    has_spike = randomizer.random(len(timestamps)) < SPIKE_PROBABILITY
    spike_factor = np.where(has_spike, randomizer.uniform(1.8, 3.5, len(timestamps)), 1.0)

    average_demand = (
        3.2
        * HOUR_FACTORS[hour_of_day]
        * weekend_factor
        * trend_factor
        * seasonal_factor
        * daily_noise[day_indexes]
        * spike_factor
    )
    request_counts = randomizer.poisson(average_demand)

    dataset = pd.DataFrame({
        "timestamp": timestamps,
        "hour_of_day": hour_of_day,
        "day_of_week": day_of_week,
        "is_weekend": is_weekend,
        "month": month,
        "trend_index": trend_index.round(6),
        "request_count": request_counts.astype("int64"),
        "data_source": "synthetic",
    })
    validate_dataset(dataset)
    return dataset


def validate_dataset(dataset: pd.DataFrame) -> None:
    """Check that hourly timestamps and synthetic request counts are valid."""
    required_columns = {
        "timestamp", "hour_of_day", "day_of_week", "is_weekend",
        "month", "trend_index", "request_count", "data_source",
    }
    missing_columns = required_columns - set(dataset.columns)
    if missing_columns:
        raise ValueError(f"Dataset is missing columns: {', '.join(sorted(missing_columns))}")
    if dataset.empty:
        raise ValueError("Dataset must contain at least one hourly bucket.")
    if dataset[list(required_columns)].isna().any().any():
        raise ValueError("Dataset features and targets must not contain missing values.")

    timestamps = pd.to_datetime(dataset["timestamp"], utc=True, errors="coerce")
    if timestamps.isna().any() or timestamps.duplicated().any():
        raise ValueError("Timestamps must be valid and unique.")
    if len(timestamps) > 1 and not timestamps.diff().iloc[1:].eq(pd.Timedelta(hours=1)).all():
        raise ValueError("Timestamps must form a continuous hourly sequence.")

    counts = pd.to_numeric(dataset["request_count"], errors="coerce")
    if counts.isna().any() or (counts < 0).any() or not np.equal(counts, np.floor(counts)).all():
        raise ValueError("request_count must contain non-negative integers.")
    if not dataset["data_source"].eq("synthetic").all():
        raise ValueError("All rows must be labeled synthetic.")


def main() -> None:
    dataset = generate_hourly_demand()
    DATASET_PATH.parent.mkdir(parents=True, exist_ok=True)
    dataset.to_csv(DATASET_PATH, index=False)
    print(json.dumps({
        "rows": len(dataset),
        "columns": list(dataset.columns),
        "start_utc": dataset["timestamp"].iloc[0].isoformat(),
        "end_utc": dataset["timestamp"].iloc[-1].isoformat(),
        "data_source": "synthetic",
        "dataset_path": str(DATASET_PATH),
    }, indent=2))


if __name__ == "__main__":
    main()

"""Load and cache the bundled synthetic history for forecast inference."""

from __future__ import annotations

from datetime import datetime
from functools import lru_cache

import pandas as pd

from .model_service import WORKSPACE
from .synthetic_dataset import validate_dataset


DATASET_PATH = WORKSPACE / "data" / "synthetic_hourly_demand.csv"
HISTORY_HOURS_REQUIRED = 24 * 7


@lru_cache(maxsize=1)
def load_synthetic_history() -> tuple[tuple[int, ...], datetime]:
    """Return the last 168 validated synthetic counts and their final timestamp."""
    if not DATASET_PATH.is_file():
        raise FileNotFoundError("The bundled synthetic demand dataset is missing.")

    dataset = pd.read_csv(DATASET_PATH)
    validate_dataset(dataset)
    if len(dataset) < HISTORY_HOURS_REQUIRED:
        raise ValueError("The synthetic demand dataset does not contain a full week of history.")

    timestamps = pd.to_datetime(dataset["timestamp"], utc=True)
    counts = tuple(int(value) for value in dataset["request_count"].tail(HISTORY_HOURS_REQUIRED))
    return counts, timestamps.iloc[-1].to_pydatetime()

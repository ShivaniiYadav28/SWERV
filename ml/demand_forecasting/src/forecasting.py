"""Create future hourly features using past observations and forecasts."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from sklearn.base import RegressorMixin

from .features import FEATURE_COLUMNS, HOURS_PER_DAY, HOURS_PER_WEEK
from .model_service import predict_request_counts


def forecast_request_counts(
    model: RegressorMixin,
    forecast_start: datetime,
    historical_request_counts: list[int],
    forecast_periods: int,
    feature_columns: list[str] = FEATURE_COLUMNS,
) -> list[dict[str, object]]:
    """Forecast consecutive hours, feeding earlier predictions into later ones."""
    if forecast_start.tzinfo is None or forecast_start.utcoffset() != timedelta(0):
        raise ValueError("forecast_start must be a timezone-aware UTC timestamp.")
    if forecast_start.minute or forecast_start.second or forecast_start.microsecond:
        raise ValueError("forecast_start must be aligned to the start of an hour.")
    if len(historical_request_counts) != HOURS_PER_WEEK:
        raise ValueError(f"Exactly {HOURS_PER_WEEK} prior hourly counts are required.")
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in historical_request_counts):
        raise ValueError("Historical request counts must be non-negative integers.")
    if not 1 <= forecast_periods <= HOURS_PER_WEEK:
        raise ValueError(f"forecast_periods must be between 1 and {HOURS_PER_WEEK}.")

    observed_and_predicted_counts = list(historical_request_counts)
    predictions: list[dict[str, object]] = []
    for period_index in range(forecast_periods):
        timestamp = forecast_start + timedelta(hours=period_index)
        feature_row = {
            "hour_of_day": timestamp.hour,
            "day_of_week": timestamp.weekday(),
            "month": timestamp.month,
            "is_weekend": int(timestamp.weekday() >= 5),
            "previous_hour_demand": observed_and_predicted_counts[-1],
            "previous_day_same_hour_demand": observed_and_predicted_counts[-HOURS_PER_DAY],
            "previous_week_same_hour_demand": observed_and_predicted_counts[-HOURS_PER_WEEK],
            "previous_24_hour_average": float(np.mean(observed_and_predicted_counts[-HOURS_PER_DAY:])),
        }
        feature_frame = pd.DataFrame([feature_row], columns=feature_columns)
        raw_prediction = predict_request_counts(model, feature_frame, feature_columns)[0]
        request_count = int(np.floor(raw_prediction + 0.5))
        observed_and_predicted_counts.append(request_count)
        predictions.append({
            "timestamp": timestamp.astimezone(timezone.utc),
            "request_count": request_count,
        })

    return predictions

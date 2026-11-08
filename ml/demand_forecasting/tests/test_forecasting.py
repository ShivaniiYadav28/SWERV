"""Checks that multi-hour forecasts use only observed or prior predicted values."""

from __future__ import annotations

import sys
import unittest
from datetime import datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.features import FEATURE_COLUMNS
from src.forecasting import forecast_request_counts


class RecordingModel:
    def __init__(self) -> None:
        self.feature_rows = []

    def predict(self, features):
        self.feature_rows.append(features.iloc[0].to_dict())
        return np.array([4.6])


class ForecastingTests(unittest.TestCase):
    def test_later_hours_use_prior_predictions_not_future_actual_values(self) -> None:
        model = RecordingModel()
        history = list(range(168))
        predictions = forecast_request_counts(
            model,
            forecast_start=datetime.fromisoformat("2026-01-01T00:00:00+00:00"),
            historical_request_counts=history,
            forecast_periods=2,
            feature_columns=FEATURE_COLUMNS,
        )

        self.assertEqual([item["request_count"] for item in predictions], [5, 5])
        self.assertEqual(model.feature_rows[0]["previous_hour_demand"], 167)
        self.assertEqual(model.feature_rows[0]["previous_week_same_hour_demand"], 0)
        self.assertEqual(model.feature_rows[1]["previous_hour_demand"], 5)
        self.assertEqual(model.feature_rows[1]["previous_week_same_hour_demand"], 1)


if __name__ == "__main__":
    unittest.main()

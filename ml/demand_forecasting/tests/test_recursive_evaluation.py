"""Tests for recursive, synthetic-only multi-horizon evaluation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd
from sklearn.dummy import DummyRegressor

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.features import FEATURE_COLUMNS, TARGET_COLUMN, build_time_features, split_chronologically
from src.recursive_evaluation import evaluate_recursive_horizons


class RecursiveEvaluationTests(unittest.TestCase):
    def test_scores_recursive_horizons_against_previous_week_baseline(self) -> None:
        timestamps = pd.date_range("2024-01-01T00:00:00Z", periods=1_600, freq="h")
        dataset = pd.DataFrame({
            "timestamp": timestamps,
            TARGET_COLUMN: [index % 8 for index in range(len(timestamps))],
            "data_source": "synthetic",
        })
        featured = build_time_features(dataset)
        training, validation, _ = split_chronologically(featured)
        model = DummyRegressor(strategy="mean")
        model.fit(
            pd.concat([training, validation])[FEATURE_COLUMNS],
            pd.concat([training, validation])[TARGET_COLUMN],
        )

        report = evaluate_recursive_horizons(dataset, model)

        self.assertTrue(report["synthetic_only"])
        self.assertFalse(report["real_world_accuracy_validated"])
        self.assertEqual(set(report["recursive_metrics_by_horizon"]), {"24", "72", "168"})
        for horizon, metrics in report["recursive_metrics_by_horizon"].items():
            self.assertGreater(metrics["rolling_origin_count"], 0)
            self.assertEqual(metrics["scored_predictions"], metrics["rolling_origin_count"] * int(horizon))
            self.assertEqual(metrics["seasonal_naive_previous_week"]["mae"], 0.0)
            self.assertEqual(metrics["seasonal_naive_previous_week"]["r2"], 1.0)
            self.assertGreater(metrics["zero_demand_targets"], 0)

    def test_rejects_non_synthetic_evaluation_rows(self) -> None:
        dataset = pd.DataFrame({
            "timestamp": pd.date_range("2024-01-01T00:00:00Z", periods=300, freq="h"),
            TARGET_COLUMN: [1] * 300,
            "data_source": "operational",
        })
        with self.assertRaisesRegex(ValueError, "synthetic rows only"):
            evaluate_recursive_horizons(dataset, DummyRegressor())


if __name__ == "__main__":
    unittest.main()

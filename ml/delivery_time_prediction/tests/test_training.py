"""Focused tests for preprocessing and training safety rules."""

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import training  # noqa: E402


def sample_dataset(row_count: int = 12) -> pd.DataFrame:
    assigned = pd.date_range("2026-01-01T09:00:00Z", periods=row_count, freq="h")
    created = assigned - pd.to_timedelta(np.arange(row_count) % 30, unit="m")
    return pd.DataFrame(
        {
            "request_created_at": created,
            "assigned_at": assigned,
            "priority": ["standard", "express"] * (row_count // 2) + (["standard"] if row_count % 2 else []),
            "package_category": ["parcel", "food"] * (row_count // 2) + (["parcel"] if row_count % 2 else []),
            "weight_kg": np.arange(row_count, dtype=float) + 1,
            "quantity": 1,
            "pickup_latitude": [12.9, np.nan] * (row_count // 2) + ([12.9] if row_count % 2 else []),
            "pickup_longitude": 77.5,
            "destination_latitude": 13.0,
            "destination_longitude": 77.6,
            "straight_line_distance_km": [12.0, np.nan] * (row_count // 2) + ([12.0] if row_count % 2 else []),
            "delivery_duration_minutes": np.arange(row_count, dtype=float) + 10,
        }
    )


class TrainingPipelineTests(unittest.TestCase):
    def test_preprocessing_imputes_missing_values_and_one_hot_encodes(self) -> None:
        dataset = sample_dataset()
        dataset.loc[2, "priority"] = None
        dataset.loc[3, "package_category"] = None
        dataset.loc[11, "package_category"] = "new_category"
        features = training.build_features(dataset)
        model = training.create_model_pipeline("linear_regression")
        model.fit(features.iloc[:8], dataset[training.TARGET_COLUMN].iloc[:8])
        predictions = model.predict(features.iloc[8:])
        self.assertEqual(len(predictions), 4)
        self.assertTrue(np.isfinite(predictions).all())
        self.assertIn("priority", features.columns)
        self.assertIn("weight_kg", features.columns)

    def test_feature_allowlist_excludes_target_and_post_assignment_columns(self) -> None:
        dataset = sample_dataset()
        dataset["picked_up_at"] = pd.Timestamp("2026-01-01T12:00:00Z")
        dataset["delivered_at"] = pd.Timestamp("2026-01-01T13:00:00Z")
        dataset["final_status"] = "delivered"
        features = training.build_features(dataset)
        self.assertNotIn(training.TARGET_COLUMN, features.columns)
        self.assertFalse(
            {"picked_up_at", "delivered_at", "final_status"} & set(features.columns)
        )
        self.assertTrue(set(features.columns).issubset(
            set(training.CATEGORICAL_COLUMNS + training.NUMERICAL_COLUMNS)
        ))

    def test_missing_numeric_values_are_kept_for_preprocessor_to_impute(self) -> None:
        dataset = sample_dataset()
        features = training.build_features(dataset)
        self.assertGreater(features["pickup_latitude"].isna().sum(), 0)
        model = training.create_model_pipeline("random_forest")
        model.fit(features.iloc[:8], dataset[training.TARGET_COLUMN].iloc[:8])
        self.assertTrue(np.isfinite(model.predict(features.iloc[8:])).all())

    def test_minimum_data_gate_refuses_metrics_and_saves_no_artifacts(self) -> None:
        dataset = sample_dataset(row_count=5)
        with tempfile.TemporaryDirectory() as temporary_directory:
            models_dir = Path(temporary_directory) / "models"
            report = training.evaluate_models(dataset, models_dir=models_dir)
            self.assertFalse(models_dir.exists())
        self.assertEqual(report["status"], "insufficient_data")
        self.assertEqual(report["usable_rows"], 5)
        self.assertEqual(report["metrics"], {})
        self.assertEqual(report["artifacts_saved"], [])
        self.assertFalse(report["performance_claimed_reliable"])
        self.assertIn("too few examples", report["reason"])

    def test_chronological_split_keeps_newest_assignments_in_test_set(self) -> None:
        dataset = sample_dataset(row_count=50)
        features = training.build_features(dataset)
        train_x, test_x, _, _ = training.chronological_split(
            features,
            dataset[training.TARGET_COLUMN],
            dataset["assigned_at"],
        )
        self.assertEqual(len(test_x), training.MINIMUM_TEST_RECORDS)
        self.assertLess(len(train_x), len(features))
        self.assertLess(
            pd.to_datetime(dataset.loc[train_x.index, "assigned_at"], utc=True).max(),
            pd.to_datetime(dataset.loc[test_x.index, "assigned_at"], utc=True).min(),
        )


if __name__ == "__main__":
    unittest.main()

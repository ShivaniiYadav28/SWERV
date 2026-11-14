"""Focused tests for historical demand features and saved-model handling."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.dummy import DummyRegressor

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.features import FEATURE_COLUMNS, TARGET_COLUMN, build_time_features, split_chronologically
from src.model_service import (
    METADATA_PATH,
    MODEL_PATH,
    load_saved_model,
    predict_request_counts,
    sha256_file,
)


def make_hourly_source(row_count: int) -> pd.DataFrame:
    return pd.DataFrame({
        "timestamp": pd.date_range("2024-01-01T00:00:00Z", periods=row_count, freq="h"),
        TARGET_COLUMN: np.arange(row_count, dtype="int64"),
        "data_source": "synthetic",
    })


class DemandTrainingTests(unittest.TestCase):
    def test_bundled_artifact_hash_and_synthetic_metadata_are_valid(self) -> None:
        _, feature_columns, model_version = load_saved_model()
        metadata = json.loads(METADATA_PATH.read_text(encoding="utf-8"))

        self.assertEqual(model_version, "gradient_boosting-synthetic-a62c1700d5fb")
        self.assertEqual(feature_columns, FEATURE_COLUMNS)
        self.assertEqual(metadata["training_source"], "synthetic")
        self.assertEqual(metadata["artifact_sha256"], sha256_file(MODEL_PATH))

    def test_missing_model_artifact_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            folder = Path(temporary_directory)
            with self.assertRaises(FileNotFoundError):
                load_saved_model(
                    folder / "missing.joblib",
                    folder / "missing.metadata.json",
                    folder / "missing.features.json",
                )

    def test_lags_and_rolling_average_use_only_prior_hours(self) -> None:
        source = make_hourly_source(240)
        featured = build_time_features(source)
        first_feature_row = featured.iloc[0]

        self.assertEqual(first_feature_row["timestamp"], pd.Timestamp("2024-01-08T00:00:00Z"))
        self.assertEqual(first_feature_row["previous_hour_demand"], 167)
        self.assertEqual(first_feature_row["previous_day_same_hour_demand"], 144)
        self.assertEqual(first_feature_row["previous_week_same_hour_demand"], 0)
        self.assertEqual(first_feature_row["previous_24_hour_average"], 155.5)
        self.assertNotIn(TARGET_COLUMN, FEATURE_COLUMNS)

        changed_future = source.copy()
        changed_future.loc[200, TARGET_COLUMN] = 999_999
        changed_features = build_time_features(changed_future)
        check_timestamp = pd.Timestamp("2024-01-09T08:00:00Z")
        original_row = featured.loc[featured["timestamp"] == check_timestamp, FEATURE_COLUMNS]
        changed_row = changed_features.loc[
            changed_features["timestamp"] == check_timestamp,
            FEATURE_COLUMNS,
        ]
        pd.testing.assert_frame_equal(original_row.reset_index(drop=True), changed_row.reset_index(drop=True))

    def test_chronological_split_uses_oldest_seventy_then_fifteen_percent(self) -> None:
        featured = build_time_features(make_hourly_source(240))
        training, validation, final_test = split_chronologically(featured)

        self.assertEqual((len(training), len(validation), len(final_test)), (50, 10, 12))
        self.assertLess(training["timestamp"].max(), validation["timestamp"].min())
        self.assertLess(validation["timestamp"].max(), final_test["timestamp"].min())

    def test_saved_model_loads_and_returns_finite_non_negative_predictions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            folder = Path(temporary_directory)
            model_path = folder / "demand_model.joblib"
            metadata_path = folder / "demand_model.metadata.json"
            feature_path = folder / "feature_columns.json"

            model = DummyRegressor(strategy="constant", constant=-2.0)
            training_example = pd.DataFrame([[0] * len(FEATURE_COLUMNS)], columns=FEATURE_COLUMNS)
            model.fit(training_example, [1])
            joblib.dump(model, model_path)
            feature_path.write_text(json.dumps(FEATURE_COLUMNS), encoding="utf-8")
            metadata_path.write_text(json.dumps({
                "training_source": "synthetic",
                "feature_columns": FEATURE_COLUMNS,
                "model_version": "dummy-synthetic-test",
                "artifact_sha256": sha256_file(model_path),
            }), encoding="utf-8")

            loaded_model, loaded_features, version = load_saved_model(
                model_path, metadata_path, feature_path,
            )
            sample = pd.DataFrame([[1] * len(FEATURE_COLUMNS)], columns=FEATURE_COLUMNS)
            predictions = predict_request_counts(loaded_model, sample, loaded_features)

            self.assertEqual(version, "dummy-synthetic-test")
            self.assertEqual(loaded_features, FEATURE_COLUMNS)
            self.assertTrue(np.isfinite(predictions).all())
            self.assertTrue((predictions >= 0).all())
            self.assertEqual(predictions[0], 0.0)


if __name__ == "__main__":
    unittest.main()

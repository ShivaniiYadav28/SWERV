"""Checks for synthetic data isolation, validity, and leakage safety."""

import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import training
from src.synthetic_dataset import (
    DATA_SOURCE_COLUMN,
    RECORD_ID_COLUMN,
    generate_synthetic_dataset,
    validate_synthetic_dataset,
)


class SyntheticDatasetTests(unittest.TestCase):
    def test_generator_creates_labeled_unique_valid_records(self) -> None:
        dataset = generate_synthetic_dataset(record_count=100)
        self.assertEqual(len(dataset), 100)
        self.assertTrue(dataset[DATA_SOURCE_COLUMN].eq("synthetic").all())
        self.assertTrue(dataset[RECORD_ID_COLUMN].is_unique)
        self.assertFalse(
            dataset.duplicated(training.RAW_FEATURE_COLUMNS + [training.TARGET_COLUMN]).any()
        )
        self.assertTrue((dataset[training.TARGET_COLUMN] > 0).all())
        self.assertTrue((dataset["weight_kg"] > 0).all())

    def test_validation_rejects_bad_timestamp_and_duration(self) -> None:
        dataset = generate_synthetic_dataset(record_count=5)
        invalid_timestamp = dataset.copy()
        invalid_timestamp.loc[0, "assigned_at"] = "not-a-date"
        with self.assertRaisesRegex(ValueError, "timestamps must be valid"):
            validate_synthetic_dataset(invalid_timestamp)

        invalid_duration = dataset.copy()
        invalid_duration.loc[0, training.TARGET_COLUMN] = 0
        with self.assertRaisesRegex(ValueError, "durations must be finite and positive"):
            validate_synthetic_dataset(invalid_duration)

    def test_feature_allowlist_excludes_target_and_synthetic_metadata(self) -> None:
        dataset = generate_synthetic_dataset(record_count=5)
        dataset["delivered_at"] = "2026-01-01T00:00:00Z"
        features = training.build_features(dataset)
        self.assertNotIn(training.TARGET_COLUMN, features.columns)
        self.assertNotIn(DATA_SOURCE_COLUMN, features.columns)
        self.assertNotIn(RECORD_ID_COLUMN, features.columns)
        self.assertNotIn("delivered_at", features.columns)

    def test_chronological_split_separates_newest_twenty_percent(self) -> None:
        dataset = generate_synthetic_dataset(record_count=1_000)
        features = training.build_features(dataset)
        train_x, test_x, _, _ = training.chronological_split(
            features, dataset[training.TARGET_COLUMN], dataset["assigned_at"]
        )
        self.assertEqual(len(train_x), 800)
        self.assertEqual(len(test_x), 200)
        self.assertLess(
            pd.to_datetime(dataset.loc[train_x.index, "assigned_at"], utc=True).max(),
            pd.to_datetime(dataset.loc[test_x.index, "assigned_at"], utc=True).min(),
        )


if __name__ == "__main__":
    unittest.main()

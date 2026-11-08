"""Tests for the separate independent delivery evaluation dataset."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import training
from src.independent_evaluation import (
    DATA_SOURCE,
    generate_independent_dataset,
    validate_independent_dataset,
)


class IndependentEvaluationTests(unittest.TestCase):
    def test_generates_new_labeled_rows_with_valid_independent_features(self) -> None:
        dataset = generate_independent_dataset(record_count=100)
        self.assertEqual(len(dataset), 100)
        self.assertTrue(dataset["data_source"].eq(DATA_SOURCE).all())
        self.assertTrue(dataset["independent_test_id"].is_unique)
        self.assertFalse(
            dataset.duplicated(training.RAW_FEATURE_COLUMNS + [training.TARGET_COLUMN]).any()
        )
        self.assertTrue((dataset[training.TARGET_COLUMN] > 0).all())

    def test_model_features_exclude_target_and_test_metadata(self) -> None:
        dataset = generate_independent_dataset(record_count=10)
        features = training.build_features(dataset)
        self.assertEqual(
            list(features.columns),
            training.CATEGORICAL_COLUMNS + training.NUMERICAL_COLUMNS,
        )
        self.assertNotIn(training.TARGET_COLUMN, features.columns)
        self.assertNotIn("data_source", features.columns)
        self.assertNotIn("independent_test_id", features.columns)

    def test_validation_rejects_invalid_partial_coordinates(self) -> None:
        dataset = generate_independent_dataset(record_count=5)
        dataset.loc[0, "pickup_latitude"] = None
        with self.assertRaisesRegex(ValueError, "must be missing together"):
            validate_independent_dataset(dataset)

    def test_validation_rejects_non_positive_target(self) -> None:
        dataset = generate_independent_dataset(record_count=5)
        dataset.loc[0, training.TARGET_COLUMN] = -1
        with self.assertRaisesRegex(ValueError, "finite and positive"):
            validate_independent_dataset(dataset)


if __name__ == "__main__":
    unittest.main()

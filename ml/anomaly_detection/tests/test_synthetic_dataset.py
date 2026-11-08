"""Dataset-generator tests use synthetic records only, never SWERV database rows."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from src.synthetic_dataset import (
    ANOMALY_WEIGHTS,
    CATEGORICAL_FEATURES,
    DATA_SOURCE,
    FEATURE_COLUMNS,
    NUMERIC_FEATURES,
    OUTPUT_COLUMNS,
    generate_dataset,
    generate_splits,
    write_splits,
)


class SyntheticDatasetTests(unittest.TestCase):
    def test_generation_is_reproducible_for_same_seed(self) -> None:
        first = generate_dataset(250, seed=7001, split_name="train")
        second = generate_dataset(250, seed=7001, split_name="train")

        self.assertEqual(first, second)

    def test_dataset_has_unique_scenarios_and_documented_fields(self) -> None:
        rows = generate_dataset(1000, seed=7002, split_name="train")
        scenario_ids = [row["scenario_id"] for row in rows]

        self.assertEqual(len(set(scenario_ids)), len(rows))
        self.assertTrue(all(set(row) == set(OUTPUT_COLUMNS) for row in rows))
        self.assertTrue(all(row["data_source"] == DATA_SOURCE for row in rows))
        self.assertTrue(all(row["dataset_split"] == "train" for row in rows))
        self.assertNotIn("scenario_id", FEATURE_COLUMNS)
        self.assertNotIn("anomaly_type", FEATURE_COLUMNS)

    def test_labels_have_normal_and_each_supported_anomaly_type(self) -> None:
        rows = generate_dataset(5000, seed=7003, split_name="validation")
        label_counts: dict[str, int] = {}
        for row in rows:
            label_counts[row["anomaly_type"]] = label_counts.get(row["anomaly_type"], 0) + 1
            self.assertEqual(row["is_anomaly"], int(row["anomaly_type"] != "normal"))

        self.assertEqual(set(label_counts), set(ANOMALY_WEIGHTS))
        self.assertGreater(label_counts["normal"], 0)
        self.assertLess(label_counts["normal"], len(rows))
        for category in CATEGORICAL_FEATURES:
            self.assertTrue(all(row[category] for row in rows))

    def test_features_have_valid_ranges_and_allow_expected_missing_gps_values(self) -> None:
        rows = generate_dataset(1500, seed=7004, split_name="train")
        categorical_values = {
            "priority": {"standard", "express", "urgent"},
            "package_category": {"documents", "parcel", "food", "fragile", "heavy_goods", "other"},
            "vehicle_type": {"car", "van", "motorcycle", "truck", "bicycle"},
        }

        for row in rows:
            for column in NUMERIC_FEATURES:
                value = row[column]
                if value is not None:
                    self.assertIsInstance(value, (int, float))
                    self.assertGreaterEqual(value, 0)
            for column, allowed_values in categorical_values.items():
                self.assertIn(row[column], allowed_values)
            self.assertIn(row["gps_coordinates_valid"], (None, 0, 1))
            self.assertIn(row["gps_timestamps_valid"], (None, 0, 1))
            self.assertIn(row["status_transition_valid"], (0, 1))
            if row["gps_pair_available"] == 0:
                self.assertIsNone(row["gps_distance_km"])
                self.assertIsNone(row["gps_interval_minutes"])

    def test_train_validation_and_test_scenarios_are_separate(self) -> None:
        splits = generate_splits(
            train_size=500,
            validation_size=200,
            test_size=200,
            train_seed=11,
            validation_seed=12,
            test_seed=13,
        )
        scenario_ids = {
            name: {row["scenario_id"] for row in rows}
            for name, rows in splits.items()
        }

        self.assertEqual(len(scenario_ids["train"]), 500)
        self.assertEqual(len(scenario_ids["validation"]), 200)
        self.assertEqual(len(scenario_ids["test"]), 200)
        self.assertFalse(scenario_ids["train"] & scenario_ids["validation"])
        self.assertFalse(scenario_ids["train"] & scenario_ids["test"])
        self.assertFalse(scenario_ids["validation"] & scenario_ids["test"])

    def test_generated_files_have_synthetic_provenance_and_split_counts(self) -> None:
        splits = generate_splits(
            train_size=100,
            validation_size=60,
            test_size=60,
            train_seed=21,
            validation_seed=22,
            test_seed=23,
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = write_splits(splits, Path(temporary_directory))
            metadata = json.loads(Path(output["metadata_path"]).read_text(encoding="utf-8"))

            self.assertTrue(metadata["synthetic_only"])
            self.assertFalse(metadata["real_world_accuracy_claim"])
            self.assertFalse(metadata["scenario_id_is_a_model_feature"])
            self.assertEqual(metadata["summary"]["train"]["rows"], 100)
            for filename in output["files"].values():
                self.assertTrue((Path(temporary_directory) / filename).is_file())

    def test_generation_rejects_identical_split_seeds(self) -> None:
        with self.assertRaisesRegex(ValueError, "seeds must be different"):
            generate_splits(train_seed=4, validation_seed=4, test_seed=6)


if __name__ == "__main__":
    unittest.main()

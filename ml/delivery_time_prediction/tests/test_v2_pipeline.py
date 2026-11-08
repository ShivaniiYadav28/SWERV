"""Checks for the versioned v2 data, target, and prediction-time features."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.v2_dataset import generate_dataset, feature_target_fingerprints
from src.v2_features import FEATURE_COLUMNS, build_features
from src.v2_target import bengaluru_local_time, expected_delivery_duration


class V2PipelineTests(unittest.TestCase):
    def test_shared_target_process_is_seeded_and_timezone_aware(self) -> None:
        assigned_at = datetime(2026, 1, 1, 0, tzinfo=timezone.utc)
        first = expected_delivery_duration(
            12, "standard", "parcel", 2.5, 2, assigned_at, np.random.default_rng(77)
        )
        second = expected_delivery_duration(
            12, "standard", "parcel", 2.5, 2, assigned_at, np.random.default_rng(77)
        )
        self.assertEqual(first, second)
        self.assertEqual(bengaluru_local_time(assigned_at).hour, 5)
        self.assertGreater(first, 0)

    def test_generator_supports_24_hours_quantities_and_missing_coordinates(self) -> None:
        dataset = generate_dataset(
            240, 12345, datetime(2025, 1, 1, tzinfo=timezone.utc), "training"
        )
        features = build_features(dataset)
        self.assertEqual(set(features.columns), set(FEATURE_COLUMNS))
        self.assertEqual(set(features["assigned_local_hour"].unique()), set(range(24)))
        self.assertEqual(set(dataset["quantity"].unique()), set(range(1, 6)))
        self.assertGreater(dataset[[
            "pickup_latitude", "destination_latitude", "straight_line_distance_km",
        ]].isna().any(axis=1).sum(), 0)
        self.assertGreater(dataset["straight_line_distance_km"].max(), 35)

    def test_feature_engineering_excludes_targets_and_adds_coordinate_flags(self) -> None:
        dataset = generate_dataset(
            20, 500, datetime(2025, 1, 1, tzinfo=timezone.utc), "training"
        )
        dataset["delivered_at"] = "2026-01-01T00:00:00Z"
        features = build_features(dataset)
        self.assertNotIn("delivery_duration_minutes", features.columns)
        self.assertNotIn("delivered_at", features.columns)
        self.assertIn("complete_coordinates_available", features.columns)
        self.assertIn("assigned_local_hour", features.columns)

    def test_training_and_validation_scenarios_have_distinct_ids_and_rows(self) -> None:
        train = generate_dataset(
            25, 1, datetime(2025, 1, 1, tzinfo=timezone.utc), "training"
        )
        validation = generate_dataset(
            25, 2, datetime(2025, 2, 1, tzinfo=timezone.utc), "validation"
        )
        self.assertFalse(set(train["scenario_id"]) & set(validation["scenario_id"]))
        self.assertFalse(feature_target_fingerprints(train) & feature_target_fingerprints(validation))


if __name__ == "__main__":
    unittest.main()

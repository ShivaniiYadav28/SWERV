"""Focused checks for synthetic hourly demand data."""

from __future__ import annotations

import hashlib
import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.synthetic_dataset import generate_hourly_demand, validate_dataset


PROJECT_ROOT = Path(__file__).resolve().parents[3]
PROTECTED_WORKSPACES = (
    PROJECT_ROOT / "ml" / "delivery_time_prediction",
    PROJECT_ROOT / "ml" / "smart_agent_assignment",
)


def snapshot_protected_files() -> dict[str, str]:
    """Hash sibling feature files while skipping installed virtual environments."""
    snapshot: dict[str, str] = {}
    for workspace in PROTECTED_WORKSPACES:
        for path in workspace.rglob("*"):
            if not path.is_file() or ".venv" in path.parts or "__pycache__" in path.parts:
                continue
            relative_path = path.relative_to(PROJECT_ROOT).as_posix()
            snapshot[relative_path] = hashlib.sha256(path.read_bytes()).hexdigest()
    return snapshot


class SyntheticDemandDatasetTests(unittest.TestCase):
    def test_dataset_has_continuous_utc_hours_for_two_calendar_years(self) -> None:
        dataset = generate_hourly_demand()
        timestamps = pd.to_datetime(dataset["timestamp"], utc=True)

        self.assertEqual(len(dataset), 17_544)
        self.assertTrue(str(timestamps.dtype).endswith("UTC]"))
        self.assertEqual(timestamps.iloc[0], pd.Timestamp("2024-01-01T00:00:00Z"))
        self.assertEqual(timestamps.iloc[-1], pd.Timestamp("2025-12-31T23:00:00Z"))
        self.assertTrue(timestamps.diff().iloc[1:].eq(pd.Timedelta(hours=1)).all())

    def test_request_counts_are_non_negative_integers_without_missing_values(self) -> None:
        dataset = generate_hourly_demand()
        counts = dataset["request_count"]

        self.assertFalse(counts.isna().any())
        self.assertTrue((counts >= 0).all())
        self.assertTrue(pd.api.types.is_integer_dtype(counts))
        self.assertTrue((counts == counts.astype(int)).all())
        self.assertTrue((counts == 0).any())

    def test_generation_is_reproducible_for_the_same_seed(self) -> None:
        first = generate_hourly_demand(seed=1234)
        second = generate_hourly_demand(seed=1234)

        pd.testing.assert_frame_equal(first, second)

    def test_validator_rejects_a_missing_target(self) -> None:
        dataset = generate_hourly_demand().head(3).copy()
        dataset.loc[1, "request_count"] = pd.NA

        with self.assertRaisesRegex(ValueError, "missing values"):
            validate_dataset(dataset)

    def test_generation_does_not_change_features_one_or_two(self) -> None:
        before = snapshot_protected_files()
        generate_hourly_demand(seed=9876)
        after = snapshot_protected_files()

        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()

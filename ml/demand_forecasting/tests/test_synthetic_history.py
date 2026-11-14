"""Checks that the inference service owns and caches its synthetic history."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.synthetic_history import DATASET_PATH, HISTORY_HOURS_REQUIRED, load_synthetic_history


class SyntheticHistoryTests(unittest.TestCase):
    def tearDown(self) -> None:
        load_synthetic_history.cache_clear()

    def test_dataset_and_history_path_are_inside_the_standalone_service_root(self) -> None:
        service_root = Path(__file__).resolve().parents[1]
        self.assertEqual(DATASET_PATH, service_root / "data" / "synthetic_hourly_demand.csv")
        self.assertTrue(DATASET_PATH.is_file())

    def test_loads_valid_synthetic_counts_and_caches_the_result(self) -> None:
        load_synthetic_history.cache_clear()
        with patch("src.synthetic_history.pd.read_csv", wraps=pd.read_csv) as read_csv:
            counts, final_timestamp = load_synthetic_history()
            cached_counts, cached_timestamp = load_synthetic_history()

        self.assertEqual(len(counts), HISTORY_HOURS_REQUIRED)
        self.assertTrue(all(isinstance(value, int) and value >= 0 for value in counts))
        self.assertEqual(final_timestamp.isoformat(), "2025-12-31T23:00:00+00:00")
        self.assertEqual(cached_counts, counts)
        self.assertEqual(cached_timestamp, final_timestamp)
        read_csv.assert_called_once_with(DATASET_PATH)


if __name__ == "__main__":
    unittest.main()

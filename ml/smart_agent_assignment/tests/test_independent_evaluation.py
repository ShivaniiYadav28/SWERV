"""Focused tests for the separate independent evaluation helpers."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.features import GROUP_COLUMN, TARGET_COLUMN
from src.independent_evaluation import (
    FIRST_ASSIGNMENT,
    RANDOM_SEED,
    SCENARIO_PREFIX,
    generate_independent_data,
    ndcg_for_scenario,
    ranking_report,
)
from src.synthetic_dataset import generate_dataset


class IndependentEvaluationTests(unittest.TestCase):
    def test_independent_scenario_generation_uses_a_new_seed_and_prefix(self) -> None:
        dataset = generate_independent_data()
        baseline = generate_dataset(scenario_count=10, seed=121)
        self.assertEqual(dataset[GROUP_COLUMN].nunique(), 2_000)
        self.assertEqual(len(dataset), 20_000)
        self.assertTrue(dataset[GROUP_COLUMN].str.startswith(SCENARIO_PREFIX).all())
        self.assertEqual(RANDOM_SEED, 20_261_107)
        self.assertNotIn(baseline[GROUP_COLUMN].iloc[0], set(dataset[GROUP_COLUMN]))
        self.assertTrue(dataset["agent_id"].is_unique)
        self.assertFalse(dataset.duplicated([GROUP_COLUMN, "candidate_index"]).any())
        local_hours = pd.to_datetime(dataset["recommendation_time"], utc=True).dt.hour
        self.assertGreaterEqual(local_hours.nunique(), 20)

    def test_ndcg_prefers_the_actual_fastest_candidate(self) -> None:
        actual = np.array([10.0, 20.0, 30.0])
        correct_order = np.array([0, 1, 2])
        reverse_order = np.array([2, 1, 0])
        self.assertAlmostEqual(ndcg_for_scenario(actual, correct_order, 1), 1.0)
        self.assertAlmostEqual(ndcg_for_scenario(actual, correct_order, 3), 1.0)
        self.assertLess(ndcg_for_scenario(actual, reverse_order, 3), 1.0)

    def test_ranking_report_checks_each_dispatch_as_a_group(self) -> None:
        dataset = pd.DataFrame({
            GROUP_COLUMN: ["dispatch-a"] * 3,
            "agent_id": ["a", "b", "c"],
            TARGET_COLUMN: [10.0, 20.0, 30.0],
        })
        report = ranking_report(dataset, np.array([11.0, 19.0, 32.0]))
        self.assertEqual(report["scenario_count"], 1)
        self.assertEqual(report["top_candidate_accuracy"], 1.0)
        self.assertEqual(report["ndcg_at_1"], 1.0)
        self.assertEqual(report["ndcg_at_3"], 1.0)
        self.assertTrue(report["all_scenarios_ranked_lowest_duration_first"])


if __name__ == "__main__":
    unittest.main()

"""Training tests use independently generated synthetic scenarios."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from src.synthetic_dataset import FEATURE_COLUMNS, generate_splits
from src.training import (
    choose_validation_threshold,
    model_configurations,
    train_and_evaluate,
)
from src.model_service import InvalidScenarioError, load_model_artifact, score_scenario


class TrainingTests(unittest.TestCase):
    def test_identifiers_and_labels_are_not_model_features(self) -> None:
        self.assertNotIn("scenario_id", FEATURE_COLUMNS)
        self.assertNotIn("is_anomaly", FEATURE_COLUMNS)
        self.assertNotIn("anomaly_type", FEATURE_COLUMNS)

    def test_lof_is_configured_for_new_scenarios(self) -> None:
        models = model_configurations(normal_training_rows=100)
        lof_model = models["local_outlier_factor"]

        self.assertTrue(lof_model.novelty)
        self.assertLessEqual(lof_model.n_neighbors, 99)

    def test_threshold_prefers_validation_threshold_under_false_positive_limit(self) -> None:
        import numpy as np

        actual = np.array([0] * 20 + [1, 1])
        scores = np.array([0.05 + index * 0.9 / 19 for index in range(20)] + [0.96, 0.99])

        threshold, metrics = choose_validation_threshold(actual, scores)

        self.assertGreaterEqual(threshold, 0.9)
        self.assertLessEqual(metrics["false_positive_rate"], 0.10)
        self.assertEqual(metrics["confusion_matrix"], [[20, 0], [0, 2]])

    def test_train_selects_on_validation_then_loads_and_scores_saved_model(self) -> None:
        splits = generate_splits(
            train_size=1000,
            validation_size=350,
            test_size=350,
            train_seed=811,
            validation_seed=812,
            test_seed=813,
        )
        import pandas as pd

        training, validation, test = (
            pd.DataFrame(splits[name]) for name in ("train", "validation", "test")
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            model_directory = Path(temporary_directory) / "models"
            report_directory = Path(temporary_directory) / "reports"
            result = train_and_evaluate(
                training,
                validation,
                test,
                model_directory=model_directory,
                report_directory=report_directory,
            )
            artifact = load_model_artifact(model_directory / "anomaly_detector.joblib")
            example = {column: splits["test"][0][column] for column in FEATURE_COLUMNS}
            prediction = score_scenario(example, artifact)

            self.assertIn(result["selection"]["selected_model"], {
                "isolation_forest", "local_outlier_factor", "random_forest",
            })
            self.assertFalse(result["selection"]["model_selection_used_test_data"])
            self.assertFalse(result["independent_test"]["test_was_used_for_model_selection"])
            self.assertEqual(artifact["data_source"], "synthetic")
            self.assertTrue(artifact["model_version"].endswith(result["selection"]["model_version"].split("-")[-1]))
            self.assertTrue((report_directory / "independent_test_report.json").is_file())
            self.assertIn("is_anomaly_candidate", prediction)
            self.assertTrue(prediction["model_version"].startswith(result["selection"]["selected_model"]))

    def test_prediction_rejects_label_or_identifier_leakage(self) -> None:
        splits = generate_splits(
            train_size=500,
            validation_size=200,
            test_size=200,
            train_seed=821,
            validation_seed=822,
            test_seed=823,
        )
        import pandas as pd

        with tempfile.TemporaryDirectory() as temporary_directory:
            train_and_evaluate(
                pd.DataFrame(splits["train"]),
                pd.DataFrame(splits["validation"]),
                pd.DataFrame(splits["test"]),
                model_directory=Path(temporary_directory) / "models",
                report_directory=Path(temporary_directory) / "reports",
            )
            artifact = load_model_artifact(Path(temporary_directory) / "models" / "anomaly_detector.joblib")
            invalid_features = {column: splits["test"][0][column] for column in FEATURE_COLUMNS}
            invalid_features["scenario_id"] = splits["test"][0]["scenario_id"]

            with self.assertRaisesRegex(InvalidScenarioError, "unexpected"):
                score_scenario(invalid_features, artifact)


if __name__ == "__main__":
    unittest.main()

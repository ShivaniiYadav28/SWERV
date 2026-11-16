"""Training tests use independently generated synthetic scenarios."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from src.synthetic_dataset import FEATURE_COLUMNS, generate_splits
from src.training import (
    choose_validation_contamination,
    choose_validation_threshold,
    create_isolation_forest,
    train_and_evaluate,
    verify_artifact_integrity,
)
from src.model_service import InvalidScenarioError, load_model_artifact, score_scenario


class TrainingTests(unittest.TestCase):
    def test_identifiers_and_labels_are_not_model_features(self) -> None:
        self.assertNotIn("scenario_id", FEATURE_COLUMNS)
        self.assertNotIn("is_anomaly", FEATURE_COLUMNS)
        self.assertNotIn("anomaly_type", FEATURE_COLUMNS)

    def test_isolation_forest_configuration_is_reproducible(self) -> None:
        first = create_isolation_forest(contamination=0.1)
        second = create_isolation_forest(contamination=0.1)

        self.assertEqual(first.n_estimators, 300)
        self.assertEqual(first.contamination, 0.1)
        self.assertEqual(first.random_state, second.random_state)

    def test_contamination_uses_validation_anomaly_prevalence(self) -> None:
        import numpy as np

        actual = np.array([0] * 16 + [1] * 4)

        self.assertEqual(choose_validation_contamination(actual), 0.2)
        with self.assertRaisesRegex(ValueError, "both normal and anomalous"):
            choose_validation_contamination(np.zeros(20, dtype=int))

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
            artifact = load_model_artifact(
                model_directory / "anomaly_detector.joblib",
                expected_model_version=result["selection"]["model_version"],
                expected_artifact_sha256=result["selection"]["artifact_sha256"],
            )
            example = {column: splits["test"][0][column] for column in FEATURE_COLUMNS}
            prediction = score_scenario(example, artifact)
            repeated_training = create_isolation_forest(result["selection"]["validation_contamination"])
            repeated_training.fit(artifact["preprocessor"].transform(training[FEATURE_COLUMNS]))
            repeated_artifact = {**artifact, "model": repeated_training}
            repeated_prediction = score_scenario(example, repeated_artifact)

            self.assertEqual(result["selection"]["selected_model"], "isolation_forest")
            self.assertFalse(result["selection"]["model_selection_used_test_data"])
            self.assertFalse(result["independent_test"]["test_was_used_for_model_selection"])
            self.assertFalse(result["selection"]["isolation_forest_fit_labels_used"])
            self.assertAlmostEqual(
                result["selection"]["validation_contamination"],
                sum(row["is_anomaly"] for row in splits["validation"]) / len(splits["validation"]),
            )
            self.assertLessEqual(result["selection"]["validation_metrics"]["false_positive_rate"], 0.10)
            self.assertEqual(len(result["independent_test"]["metrics"]["confusion_matrix"]), 2)
            for metric in ("precision", "recall", "f1", "roc_auc", "precision_recall_auc"):
                self.assertIn(metric, result["independent_test"]["metrics"])
            self.assertEqual(
                set(result["independent_test"]["metrics"]["category_detection_recall"]),
                {row["anomaly_type"] for row in splits["test"] if row["anomaly_type"] != "normal"},
            )
            self.assertEqual(artifact["data_source"], "synthetic")
            self.assertTrue(artifact["model_version"].endswith(result["selection"]["model_version"].split("-")[-1]))
            self.assertTrue((report_directory / "independent_test_report.json").is_file())
            self.assertIn("is_anomaly_candidate", prediction)
            self.assertTrue(prediction["model_version"].startswith("isolation_forest"))
            self.assertEqual(prediction["anomaly_score"], repeated_prediction["anomaly_score"])
            self.assertIsNone(prediction["predicted_category"])

            artifact_path = model_directory / "anomaly_detector.joblib"
            metadata_path = model_directory / "anomaly_detector.metadata.json"
            digest = verify_artifact_integrity(artifact_path, metadata_path)
            self.assertEqual(digest, result["selection"]["artifact_sha256"])

            invalid_features = dict(example)
            invalid_features["scenario_id"] = splits["test"][0]["scenario_id"]

            with self.assertRaisesRegex(InvalidScenarioError, "unexpected"):
                score_scenario(invalid_features, artifact)

            artifact_path.write_bytes(artifact_path.read_bytes() + b"tampered")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                verify_artifact_integrity(artifact_path, metadata_path)


if __name__ == "__main__":
    unittest.main()

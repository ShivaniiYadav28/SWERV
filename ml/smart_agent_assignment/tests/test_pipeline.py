"""Tests for synthetic candidate data, grouped training, and prediction API."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import joblib
import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, RegressorMixin

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import training
from src.api import API_KEY_ENV, app, get_model_service
from src.features import (
    CATEGORICAL_COLUMNS,
    DATA_SOURCE_COLUMN,
    FEATURE_COLUMNS,
    GROUP_COLUMN,
    NUMERICAL_COLUMNS,
    TARGET_COLUMN,
    build_features,
    create_preprocessor,
)
from src.model_service import DEFAULT_MODEL_PATH, AgentRecommendationModel
from src.synthetic_dataset import generate_dataset, validate_dataset
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import Pipeline


VALID_REQUEST = {
    "dispatch_request_id": "dispatch-test",
    "dispatch": {
        "recommendation_time": "2026-11-07T08:00:00Z",
        "priority": "standard",
        "package_category": "parcel",
        "weight_kg": 2.5,
        "quantity": 1,
        "pickup_latitude": 12.9,
        "pickup_longitude": 77.5,
        "destination_latitude": 13.0,
        "destination_longitude": 77.6,
    },
    "candidates": [
        {
            "agent_id": "agent-1", "agent_code": "AGT-001", "is_active": True,
            "agent_status": "available", "vehicle_type": "van",
            "capabilities": ["parcel_delivery"], "active_workload": 1,
            "max_capacity": 4, "gps_fresh": True, "agent_to_pickup_km": 1.2,
            "completed_delivery_count": 12, "historical_median_minutes": 42.0,
        },
        {
            "agent_id": "agent-2", "agent_code": "AGT-002", "is_active": True,
            "agent_status": "available", "vehicle_type": "motorcycle",
            "capabilities": ["parcel_delivery"], "active_workload": 0,
            "max_capacity": 3, "gps_fresh": False, "agent_to_pickup_km": None,
            "completed_delivery_count": 2, "historical_median_minutes": None,
        },
    ],
}
TEST_API_KEY = "local-test-key"
STAGE_2_MODEL_SHA256 = "c092cee9f5a40e47a93afa4b25e8ffd45c4acb608f45779d07f12145ffe92722"


class ConstantRegressor(RegressorMixin, BaseEstimator):
    fit_targets: list[np.ndarray] = []

    def __init__(self, value: float) -> None:
        self.value = value

    def fit(self, features: np.ndarray, target: np.ndarray) -> "ConstantRegressor":
        del features
        self.constant_ = float(self.value)
        self.fit_targets.append(np.asarray(target, dtype=float).copy())
        return self

    def predict(self, features: np.ndarray) -> np.ndarray:
        return np.full(features.shape[0], self.constant_, dtype=float)


def call_api(
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    server_key: str | None = TEST_API_KEY,
    **kwargs: object,
) -> httpx.Response:
    if headers is None and method.upper() == "POST" and path == "/predict":
        headers = {"Authorization": f"Bearer {TEST_API_KEY}"}

    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, headers=headers, **kwargs)

    with patch.dict(os.environ, {}):
        os.environ.pop(API_KEY_ENV, None)
        if server_key is not None:
            os.environ[API_KEY_ENV] = server_key
        return asyncio.run(send())


class SyntheticCandidatePipelineTests(unittest.TestCase):
    def tearDown(self) -> None:
        app.dependency_overrides.clear()

    def test_openapi_description_uses_public_recommendation_wording(self) -> None:
        info = app.openapi()["info"]
        self.assertEqual(
            info["description"],
            "Ranks eligible agent candidates using a machine-learning recommendation model.",
        )
        self.assertNotIn("synthetic", info["title"].lower())
        self.assertNotIn("synthetic", info["description"].lower())

    def test_generation_has_ten_thousand_labeled_unique_candidates(self) -> None:
        dataset = generate_dataset()
        self.assertEqual(len(dataset), 10_000)
        self.assertEqual(dataset[GROUP_COLUMN].nunique(), 1_000)
        self.assertTrue(dataset[DATA_SOURCE_COLUMN].eq("synthetic").all())
        self.assertFalse(dataset.duplicated([GROUP_COLUMN, "candidate_index"]).any())

    def test_generation_is_reproducible_with_the_fixed_seed(self) -> None:
        first = generate_dataset(scenario_count=5)
        second = generate_dataset(scenario_count=5)
        pd.testing.assert_frame_equal(first, second)

    def test_feature_allowlist_excludes_target_ids_and_future_values(self) -> None:
        dataset = generate_dataset(scenario_count=2)
        dataset["delivered_at"] = "2025-01-02T00:00:00Z"
        features = build_features(dataset)
        self.assertNotIn(TARGET_COLUMN, features.columns)
        self.assertNotIn(GROUP_COLUMN, features.columns)
        self.assertNotIn("delivered_at", features.columns)
        self.assertNotIn(DATA_SOURCE_COLUMN, features.columns)

    def test_validation_rejects_duplicate_or_invalid_target_rows(self) -> None:
        dataset = generate_dataset(scenario_count=2)
        duplicate = pd.concat([dataset, dataset.iloc[[0]]], ignore_index=True)
        with self.assertRaisesRegex(ValueError, "Duplicate candidate"):
            validate_dataset(duplicate)
        invalid_target = dataset.copy()
        invalid_target.loc[0, TARGET_COLUMN] = 0
        with self.assertRaisesRegex(ValueError, "durations must be positive"):
            validate_dataset(invalid_target)

    def test_chronological_split_keeps_each_dispatch_group_intact(self) -> None:
        dataset = generate_dataset(scenario_count=20)
        train_mask, validation_mask, test_mask = training.chronological_group_split(dataset)
        train_groups = set(dataset.loc[train_mask, GROUP_COLUMN])
        validation_groups = set(dataset.loc[validation_mask, GROUP_COLUMN])
        test_groups = set(dataset.loc[test_mask, GROUP_COLUMN])
        self.assertFalse(train_groups & validation_groups)
        self.assertFalse(train_groups & test_groups)
        self.assertFalse(validation_groups & test_groups)
        self.assertEqual((len(train_groups), len(validation_groups), len(test_groups)), (14, 3, 3))
        self.assertTrue((train_mask | validation_mask | test_mask).all())
        self.assertTrue((train_mask | validation_mask | test_mask).equals(pd.Series(True, index=dataset.index)))
        scenario_times = dataset.groupby(GROUP_COLUMN)[training.TIME_COLUMN].first()
        train_end = pd.to_datetime(scenario_times.loc[list(train_groups)], utc=True).max()
        validation_times = pd.to_datetime(scenario_times.loc[list(validation_groups)], utc=True)
        validation_end = validation_times.max()
        test_start = pd.to_datetime(scenario_times.loc[list(test_groups)], utc=True).min()
        self.assertLessEqual(train_end, validation_times.min())
        self.assertLessEqual(validation_end, test_start)

    def test_training_creates_three_models_and_grouped_metrics(self) -> None:
        dataset = generate_dataset(scenario_count=30)
        with tempfile.TemporaryDirectory() as temporary_directory:
            model_dir = Path(temporary_directory) / "models"
            report_dir = Path(temporary_directory) / "reports"
            report = training.train_models(dataset, model_dir, report_dir)
            self.assertEqual(report["split_counts"]["training"], {
                "candidate_rows": 210, "scenarios": 21,
            })
            self.assertEqual(report["split_counts"]["validation"], {
                "candidate_rows": 40, "scenarios": 4,
            })
            self.assertEqual(report["split_counts"]["final_test"], {
                "candidate_rows": 50, "scenarios": 5,
            })
            self.assertEqual(report["model_fit_rows"], 250)
            self.assertEqual(set(report["validation_metrics"]), {
                "linear_regression", "random_forest", "gradient_boosting",
            })
            self.assertTrue(all({
                "mae_minutes", "rmse_minutes", "r2", "top_candidate_accuracy",
                "ndcg_at_1", "ndcg_at_3",
            }.issubset(metrics) for metrics in report["validation_metrics"].values()))
            self.assertTrue({
                "mae_minutes", "rmse_minutes", "r2", "top_candidate_accuracy",
                "ndcg_at_1", "ndcg_at_3",
            }.issubset(report["final_test_metrics"]))
            for model_path in report["model_artifacts"].values():
                self.assertTrue(Path(model_path).is_file())
            validation_report = report_dir / training.VALIDATION_REPORT_PATH.name
            final_test_report = report_dir / training.FINAL_TEST_REPORT_PATH.name
            self.assertTrue(validation_report.is_file())
            self.assertTrue(final_test_report.is_file())
            self.assertEqual(
                json.loads(validation_report.read_text(encoding="utf-8"))["selected_model"],
                report["best_model"],
            )
            test_report = json.loads(final_test_report.read_text(encoding="utf-8"))
            self.assertEqual(test_report["selected_model"], report["best_model"])
            self.assertFalse(test_report["model_selection_used_final_test"])

            model_path = Path(report["best_model_artifact"])
            metadata_path = model_path.with_suffix(".metadata.json")
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(metadata["artifact_sha256"], hashlib.sha256(model_path.read_bytes()).hexdigest())
            self.assertEqual(metadata["feature_columns"], report["feature_columns"])
            self.assertEqual(metadata["feature_schema"], {
                "categorical_columns": CATEGORICAL_COLUMNS,
                "numerical_columns": NUMERICAL_COLUMNS,
            })
            self.assertEqual(metadata["training_seed"], training.TRAINING_SEED)
            self.assertEqual(metadata["dataset_seed"], 121)
            self.assertEqual(metadata["split_configuration"], training.SPLIT_CONFIGURATION)
            self.assertTrue(AgentRecommendationModel(model_path).available)

            metadata["artifact_sha256"] = "0" * 64
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            self.assertFalse(AgentRecommendationModel(model_path).available)

    def test_validation_selects_model_and_final_test_does_not_change_selection(self) -> None:
        factories = {
            "linear_regression": lambda: ConstantRegressor(40),
            "random_forest": lambda: ConstantRegressor(60),
            "gradient_boosting": lambda: ConstantRegressor(80),
        }

        def train_with_test_target(test_target: float, directory: Path) -> dict[str, object]:
            dataset = generate_dataset(scenario_count=30)
            training_mask, validation_mask, final_test_mask = training.chronological_group_split(dataset)
            dataset.loc[training_mask, TARGET_COLUMN] = 45
            dataset.loc[validation_mask, TARGET_COLUMN] = 40
            dataset.loc[final_test_mask, TARGET_COLUMN] = test_target
            with patch.dict(training.MODEL_FACTORIES, factories, clear=True):
                return training.train_models(
                    dataset,
                    directory / "models",
                    directory / "reports",
                )

        ConstantRegressor.fit_targets.clear()
        with tempfile.TemporaryDirectory() as first_directory, tempfile.TemporaryDirectory() as second_directory:
            first = train_with_test_target(60, Path(first_directory))
            first_fit_targets = list(ConstantRegressor.fit_targets)
            ConstantRegressor.fit_targets.clear()
            second = train_with_test_target(100, Path(second_directory))
            second_fit_targets = list(ConstantRegressor.fit_targets)

        self.assertEqual(first["best_model"], "linear_regression")
        self.assertEqual(second["best_model"], first["best_model"])
        self.assertNotEqual(
            first["final_test_metrics"]["mae_minutes"],
            second["final_test_metrics"]["mae_minutes"],
        )
        self.assertTrue(all(set(values).issubset({40.0, 45.0}) for values in first_fit_targets))
        self.assertTrue(all(set(values).issubset({40.0, 45.0}) for values in second_fit_targets))

    def test_api_requires_eligible_candidates_and_returns_ranked_predictions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            model_path = Path(temporary_directory) / "linear_regression.joblib"
            dataset = generate_dataset(scenario_count=30)
            features = build_features(dataset)
            model = Pipeline([
                ("preprocessor", create_preprocessor()),
                ("regressor", LinearRegression()),
            ])
            model.fit(features, dataset[TARGET_COLUMN])
            joblib.dump(model, model_path)
            digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
            model_path.with_suffix(".metadata.json").write_text(json.dumps({
                "training_source": "synthetic",
                "model_name": "linear_regression",
                "model_version": f"linear_regression-synthetic-{digest[:12]}",
                "artifact_sha256": digest,
                "feature_columns": FEATURE_COLUMNS,
                "feature_schema": {
                    "categorical_columns": CATEGORICAL_COLUMNS,
                    "numerical_columns": NUMERICAL_COLUMNS,
                },
            }), encoding="utf-8")
            service = AgentRecommendationModel(model_path)
            app.dependency_overrides[get_model_service] = lambda: service

            health = call_api("GET", "/health")
            health_body = health.json()
            self.assertEqual(
                health_body,
                {"status": "ok", "model_available": True},
            )
            for field in ("model_version", "training_source", "provenance_note"):
                self.assertNotIn(field, health_body)
            response = call_api("POST", "/predict", json=VALID_REQUEST)
            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["training_source"], "synthetic")
            self.assertEqual(len(body["predictions"]), 2)
            self.assertEqual([item["rank"] for item in body["predictions"]], [1, 2])
            self.assertTrue(all(item["predicted_duration_minutes"] > 0 for item in body["predictions"]))

    def test_api_authenticates_prediction_and_keeps_health_public(self) -> None:
        health = call_api("GET", "/health")
        self.assertEqual(health.status_code, 200)

        with tempfile.TemporaryDirectory() as temporary_directory:
            model_path = Path(temporary_directory) / "linear_regression.joblib"
            dataset = generate_dataset(scenario_count=30)
            model = Pipeline([
                ("preprocessor", create_preprocessor()),
                ("regressor", LinearRegression()),
            ])
            model.fit(build_features(dataset), dataset[TARGET_COLUMN])
            joblib.dump(model, model_path)
            digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
            model_path.with_suffix(".metadata.json").write_text(json.dumps({
                "training_source": "synthetic",
                "model_name": "linear_regression",
                "model_version": f"linear_regression-synthetic-{digest[:12]}",
                "artifact_sha256": digest,
                "feature_columns": FEATURE_COLUMNS,
                "feature_schema": {
                    "categorical_columns": CATEGORICAL_COLUMNS,
                    "numerical_columns": NUMERICAL_COLUMNS,
                },
            }), encoding="utf-8")
            app.dependency_overrides[get_model_service] = lambda: AgentRecommendationModel(model_path)

            valid = call_api("POST", "/predict", json=VALID_REQUEST)
            self.assertEqual(valid.status_code, 200)
            self.assertEqual(len(valid.json()["predictions"]), 2)

    def test_api_rejects_missing_invalid_and_malformed_bearer_credentials(self) -> None:
        requests = (
            {},
            {"Authorization": "Bearer wrong-key"},
            {"Authorization": "Basic " + TEST_API_KEY},
            {"Authorization": "Bearer"},
            {"Authorization": "Bearer one two"},
        )
        for headers in requests:
            with self.subTest(headers=headers):
                response = call_api(
                    "POST",
                    "/predict",
                    headers=headers,
                    json=VALID_REQUEST,
                )
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.headers.get("www-authenticate"), "Bearer")
                self.assertNotIn(TEST_API_KEY, response.text)

    def test_api_fails_closed_when_authentication_is_not_configured(self) -> None:
        response = call_api(
            "POST",
            "/predict",
            server_key=None,
            json=VALID_REQUEST,
        )
        self.assertEqual(response.status_code, 503)
        self.assertIn("authentication is not configured", response.json()["detail"])

    def test_api_rejects_duplicate_candidates_and_invalid_candidate_constraints(self) -> None:
        invalid_requests = []

        duplicate = json.loads(json.dumps(VALID_REQUEST))
        duplicate["candidates"][1]["agent_id"] = duplicate["candidates"][0]["agent_id"]
        invalid_requests.append(duplicate)

        no_capacity = json.loads(json.dumps(VALID_REQUEST))
        no_capacity["candidates"][0]["active_workload"] = no_capacity["candidates"][0]["max_capacity"]
        invalid_requests.append(no_capacity)

        missing_capability = json.loads(json.dumps(VALID_REQUEST))
        missing_capability["candidates"][0]["capabilities"] = []
        invalid_requests.append(missing_capability)

        invalid_weight = json.loads(json.dumps(VALID_REQUEST))
        invalid_weight["dispatch"]["weight_kg"] = -1
        invalid_requests.append(invalid_weight)

        for request in invalid_requests:
            with self.subTest(request=request):
                response = call_api("POST", "/predict", json=request)
                self.assertEqual(response.status_code, 422)

    def test_default_gradient_boosting_artifact_matches_stage_2_hash(self) -> None:
        digest = hashlib.sha256(DEFAULT_MODEL_PATH.read_bytes()).hexdigest()
        service = AgentRecommendationModel(DEFAULT_MODEL_PATH)
        self.assertEqual(digest, STAGE_2_MODEL_SHA256)
        self.assertTrue(service.available)
        self.assertEqual(service.model_version, "gradient_boosting-synthetic-c092cee9f5a4")

    def test_model_service_rejects_missing_corrupted_and_incompatible_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            model_path = Path(temporary_directory) / "gradient_boosting.joblib"
            self.assertFalse(AgentRecommendationModel(model_path).available)

            model_path.write_bytes(b"not-a-valid-joblib-artifact")
            digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
            metadata = {
                "training_source": "synthetic",
                "model_name": model_path.stem,
                "model_version": f"{model_path.stem}-synthetic-{digest[:12]}",
                "artifact_sha256": digest,
                "feature_columns": FEATURE_COLUMNS,
                "feature_schema": {
                    "categorical_columns": CATEGORICAL_COLUMNS,
                    "numerical_columns": NUMERICAL_COLUMNS,
                },
            }
            metadata_path = model_path.with_suffix(".metadata.json")
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            self.assertFalse(AgentRecommendationModel(model_path).available)

            metadata["feature_columns"] = ["unexpected_feature"]
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            self.assertFalse(AgentRecommendationModel(model_path).available)

    def test_api_rejects_ineligible_candidates_and_reports_missing_model(self) -> None:
        invalid_request = json.loads(json.dumps(VALID_REQUEST))
        invalid_request["candidates"][0]["active_workload"] = 4
        response = call_api("POST", "/predict", json=invalid_request)
        self.assertEqual(response.status_code, 422)

        with tempfile.TemporaryDirectory() as temporary_directory:
            app.dependency_overrides[get_model_service] = lambda: AgentRecommendationModel(
                Path(temporary_directory) / "missing.joblib"
            )
            unavailable = call_api("POST", "/predict", json=VALID_REQUEST)
            self.assertEqual(unavailable.status_code, 503)


if __name__ == "__main__":
    unittest.main()

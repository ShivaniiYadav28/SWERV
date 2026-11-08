"""Tests for synthetic candidate data, grouped training, and prediction API."""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

import httpx
import joblib
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import training
from src.api import app, get_model_service
from src.features import DATA_SOURCE_COLUMN, GROUP_COLUMN, TARGET_COLUMN, build_features, create_preprocessor
from src.model_service import AgentRecommendationModel
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


def call_api(method: str, path: str, **kwargs: object) -> httpx.Response:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)
    return asyncio.run(send())


class SyntheticCandidatePipelineTests(unittest.TestCase):
    def tearDown(self) -> None:
        app.dependency_overrides.clear()

    def test_generation_has_ten_thousand_labeled_unique_candidates(self) -> None:
        dataset = generate_dataset()
        self.assertEqual(len(dataset), 10_000)
        self.assertEqual(dataset[GROUP_COLUMN].nunique(), 1_000)
        self.assertTrue(dataset[DATA_SOURCE_COLUMN].eq("synthetic").all())
        self.assertFalse(dataset.duplicated([GROUP_COLUMN, "candidate_index"]).any())

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
        train_mask, test_mask = training.chronological_group_split(dataset)
        train_groups = set(dataset.loc[train_mask, GROUP_COLUMN])
        test_groups = set(dataset.loc[test_mask, GROUP_COLUMN])
        self.assertFalse(train_groups & test_groups)
        self.assertEqual(len(train_groups), 16)
        self.assertEqual(len(test_groups), 4)
        self.assertTrue((train_mask | test_mask).all())

    def test_training_creates_three_models_and_grouped_metrics(self) -> None:
        dataset = generate_dataset(scenario_count=30)
        with tempfile.TemporaryDirectory() as temporary_directory:
            report = training.train_models(dataset, Path(temporary_directory))
            self.assertEqual(report["training_rows"], 240)
            self.assertEqual(report["test_rows"], 60)
            self.assertEqual(report["training_scenarios"], 24)
            self.assertEqual(report["test_scenarios"], 6)
            self.assertEqual(set(report["metrics"]), {
                "linear_regression", "random_forest", "gradient_boosting",
            })
            self.assertTrue(all("top_candidate_accuracy" in metrics for metrics in report["metrics"].values()))
            for model_path in report["model_artifacts"].values():
                self.assertTrue(Path(model_path).is_file())

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
                "artifact_sha256": digest,
                "model_version": f"linear_regression-synthetic-{digest[:12]}",
            }), encoding="utf-8")
            service = AgentRecommendationModel(model_path)
            app.dependency_overrides[get_model_service] = lambda: service

            health = call_api("GET", "/health")
            self.assertTrue(health.json()["model_available"])
            self.assertEqual(health.json()["training_source"], "synthetic")
            response = call_api("POST", "/predict", json=VALID_REQUEST)
            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["training_source"], "synthetic")
            self.assertEqual(len(body["predictions"]), 2)
            self.assertEqual([item["rank"] for item in body["predictions"]], [1, 2])
            self.assertTrue(all(item["predicted_duration_minutes"] > 0 for item in body["predictions"]))

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

"""Tests for the FastAPI health and unavailable prediction behavior."""

import asyncio
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import Pipeline

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from src.api import app, get_model_service, make_model_features
from src.model_service import DeliveryModelService
from src.schemas import DeliveryPredictionRequest
from src import training
from src.training import create_preprocessor


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC_REPORT_PATH = WORKSPACE_ROOT / "data" / "processed" / "synthetic_training_evaluation_report.json"


VALID_REQUEST = {
    "request_created_at": "2026-11-07T08:00:00Z",
    "assigned_at": "2026-11-07T08:10:00Z",
    "priority": "standard",
    "package_category": "parcel",
    "weight_kg": 2.5,
    "quantity": 1,
    "pickup_latitude": 12.9,
    "pickup_longitude": 77.5,
    "destination_latitude": 13.0,
    "destination_longitude": 77.6,
}


def call_api(method: str, path: str, **request_data: object) -> httpx.Response:
    async def send_request() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **request_data)

    return asyncio.run(send_request())


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        model_service = DeliveryModelService(Path(self.temporary_directory.name) / "missing.joblib")
        app.dependency_overrides[get_model_service] = lambda: model_service

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.temporary_directory.cleanup()

    def test_health_reports_service_up_and_model_unavailable(self) -> None:
        response = call_api("GET", "/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "status": "ok",
            "model_available": False,
            "model_version": None,
        })

    def test_prediction_returns_structured_unavailable_response_without_model(self) -> None:
        response = call_api("POST", "/predict", json=VALID_REQUEST)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["prediction_status"], "unavailable")
        self.assertIsNone(response.json()["predicted_duration_minutes"])
        self.assertIsNone(response.json()["model_version"])
        self.assertIn("no valid trained model", response.json()["message"])

    def test_invalid_request_values_return_validation_error(self) -> None:
        invalid_request = {**VALID_REQUEST, "weight_kg": -1}
        response = call_api("POST", "/predict", json=invalid_request)
        self.assertEqual(response.status_code, 422)

    def test_request_maps_to_the_training_feature_schema(self) -> None:
        request = DeliveryPredictionRequest.model_validate(VALID_REQUEST)
        features = make_model_features(request)
        self.assertEqual(
            list(features.columns),
            training.CATEGORICAL_COLUMNS + training.NUMERICAL_COLUMNS,
        )
        self.assertGreater(features.iloc[0]["straight_line_distance_km"], 0)
        self.assertNotIn(training.TARGET_COLUMN, features.columns)

    def test_post_assignment_fields_are_rejected(self) -> None:
        invalid_request = {**VALID_REQUEST, "delivered_at": "2026-11-07T09:00:00Z"}
        response = call_api("POST", "/predict", json=invalid_request)
        self.assertEqual(response.status_code, 422)

    def test_invalid_timestamp_order_and_partial_coordinates_are_rejected(self) -> None:
        earlier_assignment = {
            **VALID_REQUEST,
            "assigned_at": "2026-11-07T07:00:00Z",
        }
        partial_coordinates = {
            **VALID_REQUEST,
            "pickup_longitude": None,
        }
        self.assertEqual(call_api("POST", "/predict", json=earlier_assignment).status_code, 422)
        self.assertEqual(call_api("POST", "/predict", json=partial_coordinates).status_code, 422)

    def test_missing_model_artifact_is_not_loaded(self) -> None:
        missing_path = Path(self.temporary_directory.name) / "not-installed.joblib"
        service = DeliveryModelService(missing_path)
        self.assertFalse(service.available)
        self.assertIsNone(service.model_version)

    def test_default_model_is_the_report_selected_synthetic_artifact(self) -> None:
        report = json.loads(SYNTHETIC_REPORT_PATH.read_text(encoding="utf-8"))
        selected_artifact = Path(report["best_model_artifact"]).resolve()
        with patch.dict(os.environ, {}, clear=True):
            service = DeliveryModelService()

        self.assertEqual(service.model_path, selected_artifact)
        self.assertTrue(service.available)
        self.assertEqual(service.model_version, report["best_model_version"])
        self.assertIn("synthetic", service.model_version or "")

    def test_synthetic_artifact_loads_from_absolute_and_package_relative_paths(self) -> None:
        report = json.loads(SYNTHETIC_REPORT_PATH.read_text(encoding="utf-8"))
        selected_artifact = Path(report["best_model_artifact"]).resolve()
        relative_artifact = Path("models/synthetic/gradient_boosting.joblib")
        with tempfile.TemporaryDirectory() as temporary_directory:
            original_directory = Path.cwd()
            try:
                os.chdir(temporary_directory)
                absolute_service = DeliveryModelService(selected_artifact)
                relative_service = DeliveryModelService(relative_artifact)
            finally:
                os.chdir(original_directory)

        self.assertTrue(absolute_service.available)
        self.assertTrue(relative_service.available)
        self.assertEqual(absolute_service.model_version, report["best_model_version"])
        self.assertEqual(relative_service.model_version, report["best_model_version"])

    def test_default_synthetic_artifact_serves_health_and_prediction(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            service = DeliveryModelService()
        app.dependency_overrides[get_model_service] = lambda: service

        health_response = call_api("GET", "/health")
        prediction_response = call_api("POST", "/predict", json=VALID_REQUEST)

        self.assertEqual(health_response.status_code, 200)
        self.assertTrue(health_response.json()["model_available"])
        self.assertIn("synthetic", health_response.json()["model_version"])
        self.assertEqual(prediction_response.status_code, 200)
        self.assertEqual(prediction_response.json()["prediction_status"], "available")
        self.assertGreater(prediction_response.json()["predicted_duration_minutes"], 0)

    def test_corrupt_model_artifact_is_not_loaded(self) -> None:
        corrupt_path = Path(self.temporary_directory.name) / "corrupt.joblib"
        corrupt_path.write_text("not a model", encoding="utf-8")
        service = DeliveryModelService(corrupt_path)
        self.assertFalse(service.available)
        self.assertIsNone(service.model_version)

    def test_synthetic_artifact_loads_and_api_returns_tagged_prediction(self) -> None:
        artifact_path = Path(self.temporary_directory.name) / "linear_regression.joblib"
        features = pd.DataFrame({
            "priority": ["standard", "express", "urgent", "standard"],
            "package_category": ["parcel", "food", "documents", "other"],
            "request_to_assignment_minutes": [10, 8, 5, 12],
            "request_created_hour": [8, 9, 10, 11],
            "request_created_day_of_week": [0, 1, 2, 3],
            "assigned_hour": [8, 9, 10, 11],
            "assigned_day_of_week": [0, 1, 2, 3],
            "weight_kg": [1.0, 2.0, 3.0, 4.0],
            "quantity": [1, 1, 2, 1],
            "pickup_latitude": [12.9, 12.9, 12.9, 12.9],
            "pickup_longitude": [77.5, 77.5, 77.5, 77.5],
            "destination_latitude": [13.0, 13.0, 13.0, 13.0],
            "destination_longitude": [77.6, 77.6, 77.6, 77.6],
            "straight_line_distance_km": [15.0, 15.0, 15.0, 15.0],
        })
        target = np.array([30.0, 25.0, 20.0, 35.0])
        model = Pipeline([
            ("preprocessor", create_preprocessor()),
            ("regressor", LinearRegression()),
        ])
        model.fit(features, target)
        joblib.dump(model, artifact_path)
        artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        metadata = {
            "training_source": "synthetic",
            "model_name": "linear_regression",
            "artifact_sha256": artifact_hash,
        }
        artifact_path.with_suffix(".metadata.json").write_text(
            json.dumps(metadata), encoding="utf-8"
        )

        service = DeliveryModelService(artifact_path)
        app.dependency_overrides[get_model_service] = lambda: service
        self.assertTrue(service.available)
        health_response = call_api("GET", "/health")
        self.assertEqual(health_response.status_code, 200)
        self.assertIn("synthetic", health_response.json()["model_version"])

        response = call_api("POST", "/predict", json=VALID_REQUEST)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["prediction_status"], "available")
        self.assertGreater(body["predicted_duration_minutes"], 0)
        self.assertIn("synthetic", body["model_version"])
        self.assertEqual(
            set(body),
            {"predicted_duration_minutes", "model_version", "prediction_status", "message"},
        )


if __name__ == "__main__":
    unittest.main()

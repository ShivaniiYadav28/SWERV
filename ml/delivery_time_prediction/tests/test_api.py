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
from sklearn.dummy import DummyRegressor
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
            "artifacts_loaded": False,
        })

    def test_health_and_root_support_head_and_get_methods(self) -> None:
        head_health = call_api("HEAD", "/health")
        self.assertEqual(head_health.status_code, 200)
        self.assertEqual(head_health.text, "")

        head_root = call_api("HEAD", "/")
        self.assertEqual(head_root.status_code, 200)
        self.assertEqual(head_root.text, "")

        get_root = call_api("GET", "/")
        self.assertEqual(get_root.status_code, 200)
        self.assertEqual(get_root.json(), {
            "status": "ok",
            "model_available": False,
            "model_version": None,
            "artifacts_loaded": False,
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

    def test_unset_delivery_model_path_never_loads_synthetic_model(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            service = DeliveryModelService()

        self.assertIsNone(service.model_path)
        self.assertFalse(service.available)
        self.assertFalse(service.artifacts_loaded)
        self.assertIsNone(service.model_version)

        app.dependency_overrides[get_model_service] = lambda: service
        health_response = call_api("GET", "/health")
        self.assertEqual(health_response.status_code, 200)
        self.assertFalse(health_response.json()["model_available"])
        self.assertFalse(health_response.json()["artifacts_loaded"])
        self.assertIsNone(health_response.json()["model_version"])

        prediction_response = call_api("POST", "/predict", json=VALID_REQUEST)
        self.assertEqual(prediction_response.status_code, 503)
        self.assertEqual(prediction_response.json()["prediction_status"], "unavailable")
        self.assertIsNone(prediction_response.json()["predicted_duration_minutes"])

    def test_explicit_synthetic_artifact_loads_in_development(self) -> None:
        report = json.loads(SYNTHETIC_REPORT_PATH.read_text(encoding="utf-8"))
        selected_artifact = Path(report["best_model_artifact"]).resolve()
        with patch.dict(os.environ, {"DELIVERY_MODEL_PATH": str(selected_artifact), "SWERV_ENV": "development"}, clear=True):
            service = DeliveryModelService()

        self.assertEqual(service.model_path, selected_artifact)
        self.assertTrue(service.available)
        self.assertTrue(service.artifacts_loaded)
        self.assertIn("synthetic", service.model_version or "")

        app.dependency_overrides[get_model_service] = lambda: service
        health_response = call_api("GET", "/health")
        self.assertEqual(health_response.status_code, 200)
        self.assertTrue(health_response.json()["model_available"])
        self.assertTrue(health_response.json()["artifacts_loaded"])

        prediction_response = call_api("POST", "/predict", json=VALID_REQUEST)
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

    def test_missing_required_fields_return_validation_error(self) -> None:
        for field in ("priority", "package_category", "request_created_at", "assigned_at", "weight_kg", "quantity"):
            invalid = dict(VALID_REQUEST)
            del invalid[field]
            response = call_api("POST", "/predict", json=invalid)
            self.assertEqual(response.status_code, 422, f"Field {field} should be required")

    def test_invalid_input_types_return_validation_error(self) -> None:
        invalid_types = [
            ("weight_kg", "not-a-number"),
            ("quantity", "five"),
            ("priority", 123),
        ]
        for field, value in invalid_types:
            invalid = {**VALID_REQUEST, field: value}
            response = call_api("POST", "/predict", json=invalid)
            self.assertEqual(response.status_code, 422, f"{field}={value} should fail validation")

    def test_invalid_timestamps_return_validation_error(self) -> None:
        # Missing timezone offset (naive)
        naive_request = {**VALID_REQUEST, "request_created_at": "2026-11-07T08:00:00"}
        response = call_api("POST", "/predict", json=naive_request)
        self.assertEqual(response.status_code, 422)

        # Unparseable timestamp
        unparseable = {**VALID_REQUEST, "assigned_at": "invalid-time"}
        response = call_api("POST", "/predict", json=unparseable)
        self.assertEqual(response.status_code, 422)

    def test_unsupported_values_return_validation_error(self) -> None:
        unsupported = [
            {"priority": "unsupported_speed"},
            {"package_category": "unsupported_category"},
            {"quantity": 0},
            {"pickup_latitude": 95.0},
            {"destination_longitude": 185.0},
        ]
        for patch_dict in unsupported:
            payload = {**VALID_REQUEST, **patch_dict}
            response = call_api("POST", "/predict", json=payload)
            self.assertEqual(response.status_code, 422)

    def test_baseline_artifact_loads_and_serves_prediction(self) -> None:
        artifact_path = Path(self.temporary_directory.name) / "median_baseline.joblib"
        features = pd.DataFrame({
            "priority": ["standard", "express"],
            "package_category": ["parcel", "food"],
            "request_to_assignment_minutes": [10, 8],
            "request_created_hour": [8, 9],
            "request_created_day_of_week": [0, 1],
            "assigned_hour": [8, 9],
            "assigned_day_of_week": [0, 1],
            "weight_kg": [1.0, 2.0],
            "quantity": [1, 1],
            "pickup_latitude": [12.9, 12.9],
            "pickup_longitude": [77.5, 77.5],
            "destination_latitude": [13.0, 13.0],
            "destination_longitude": [77.6, 77.6],
            "straight_line_distance_km": [15.0, 15.0],
        })
        target = np.array([28.0, 32.0])
        model = Pipeline([
            ("preprocessor", create_preprocessor()),
            ("regressor", DummyRegressor(strategy="median")),
        ])
        model.fit(features, target)
        joblib.dump(model, artifact_path)
        artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        metadata = {
            "training_source": "baseline",
            "model_name": "median_baseline",
            "artifact_sha256": artifact_hash,
        }
        artifact_path.with_suffix(".metadata.json").write_text(
            json.dumps(metadata), encoding="utf-8"
        )

        service = DeliveryModelService(artifact_path)
        app.dependency_overrides[get_model_service] = lambda: service
        self.assertTrue(service.available)
        self.assertTrue(service.artifacts_loaded)
        self.assertIn("median_baseline", service.model_version or "")

        prediction_response = call_api("POST", "/predict", json=VALID_REQUEST)
        self.assertEqual(prediction_response.status_code, 200)
        body = prediction_response.json()
        self.assertEqual(body["prediction_status"], "available")
        self.assertAlmostEqual(body["predicted_duration_minutes"], 30.0)
        self.assertIn("median_baseline", body["model_version"])

    def test_prediction_units_and_provenance(self) -> None:
        report = json.loads(SYNTHETIC_REPORT_PATH.read_text(encoding="utf-8"))
        service = DeliveryModelService(Path(report["best_model_artifact"]))
        app.dependency_overrides[get_model_service] = lambda: service

        response = call_api("POST", "/predict", json=VALID_REQUEST)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertGreater(data["predicted_duration_minutes"], 0)
        self.assertTrue(np.isfinite(data["predicted_duration_minutes"]))
        self.assertIn("minutes", data["message"])
        self.assertIn("synthetic", data["model_version"])

    def test_explicit_synthetic_artifact_is_rejected_in_production(self) -> None:
        report = json.loads(SYNTHETIC_REPORT_PATH.read_text(encoding="utf-8"))
        selected_artifact = Path(report["best_model_artifact"]).resolve()
        with patch.dict(os.environ, {"DELIVERY_MODEL_PATH": str(selected_artifact), "SWERV_ENV": "production"}, clear=True):
            service = DeliveryModelService()
            self.assertFalse(service.available)
            self.assertFalse(service.artifacts_loaded)
            self.assertIsNone(service.model_version)

            app.dependency_overrides[get_model_service] = lambda: service
            health_response = call_api("GET", "/health")
            self.assertEqual(health_response.status_code, 200)
            self.assertFalse(health_response.json()["model_available"])
            self.assertFalse(health_response.json()["artifacts_loaded"])

            prediction_response = call_api("POST", "/predict", json=VALID_REQUEST)
            self.assertEqual(prediction_response.status_code, 503)
            self.assertEqual(prediction_response.json()["prediction_status"], "unavailable")

    def test_missing_approved_artifact_returns_safe_unavailable_status(self) -> None:
        missing_path = Path(self.temporary_directory.name) / "approved_production.joblib"
        with patch.dict(os.environ, {"DELIVERY_MODEL_PATH": str(missing_path), "SWERV_ENV": "production"}, clear=True):
            service = DeliveryModelService()
            self.assertFalse(service.available)
            self.assertFalse(service.artifacts_loaded)
            self.assertTrue(service._checked)  # Cached missing check

            app.dependency_overrides[get_model_service] = lambda: service
            health_response = call_api("GET", "/health")
            self.assertEqual(health_response.status_code, 200)
            self.assertFalse(health_response.json()["model_available"])
            self.assertFalse(health_response.json()["artifacts_loaded"])

            prediction_response = call_api("POST", "/predict", json=VALID_REQUEST)
            self.assertEqual(prediction_response.status_code, 503)
            self.assertEqual(prediction_response.json()["prediction_status"], "unavailable")

    def test_approved_operational_artifact_loads_successfully(self) -> None:
        artifact_path = Path(self.temporary_directory.name) / "operational_model.joblib"
        features = pd.DataFrame({
            "priority": ["standard", "express"],
            "package_category": ["parcel", "food"],
            "request_to_assignment_minutes": [10, 8],
            "request_created_hour": [8, 9],
            "request_created_day_of_week": [0, 1],
            "assigned_hour": [8, 9],
            "assigned_day_of_week": [0, 1],
            "weight_kg": [1.0, 2.0],
            "quantity": [1, 1],
            "pickup_latitude": [12.9, 12.9],
            "pickup_longitude": [77.5, 77.5],
            "destination_latitude": [13.0, 13.0],
            "destination_longitude": [77.6, 77.6],
            "straight_line_distance_km": [15.0, 15.0],
        })
        target = np.array([25.0, 35.0])
        model = Pipeline([
            ("preprocessor", create_preprocessor()),
            ("regressor", LinearRegression()),
        ])
        model.fit(features, target)
        joblib.dump(model, artifact_path)
        artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        metadata = {
            "training_source": "operational",
            "model_name": "linear_regression",
            "artifact_sha256": artifact_hash,
        }
        artifact_path.with_suffix(".metadata.json").write_text(
            json.dumps(metadata), encoding="utf-8"
        )

        with patch.dict(os.environ, {
            "DELIVERY_MODEL_PATH": str(artifact_path),
            "SWERV_ENV": "production",
            "APPROVED_MODEL_SHA256": artifact_hash,
        }, clear=True):
            service = DeliveryModelService()
            self.assertTrue(service.available)
            self.assertTrue(service.artifacts_loaded)
            self.assertIn("operational", service.model_version or "")

            app.dependency_overrides[get_model_service] = lambda: service
            health_response = call_api("GET", "/health")
            self.assertEqual(health_response.status_code, 200)
            self.assertTrue(health_response.json()["model_available"])
            self.assertTrue(health_response.json()["artifacts_loaded"])

            prediction_response = call_api("POST", "/predict", json=VALID_REQUEST)
            self.assertEqual(prediction_response.status_code, 200)
            body = prediction_response.json()
            self.assertEqual(body["prediction_status"], "available")
            self.assertGreater(body["predicted_duration_minutes"], 0)
            self.assertIn("operational", body["model_version"])

    def test_existing_nodejs_backend_response_contract_compatibility(self) -> None:
        expected_keys = [
            "message",
            "model_version",
            "predicted_duration_minutes",
            "prediction_status",
        ]
        # 1. Unavailable response contract verification
        unavailable_res = call_api("POST", "/predict", json=VALID_REQUEST)
        self.assertEqual(unavailable_res.status_code, 503)
        unavail_body = unavailable_res.json()
        self.assertEqual(sorted(unavail_body.keys()), expected_keys)
        self.assertEqual(unavail_body["prediction_status"], "unavailable")
        self.assertIsNone(unavail_body["predicted_duration_minutes"])
        self.assertIsNone(unavail_body["model_version"])
        self.assertIsInstance(unavail_body["message"], str)
        self.assertGreater(len(unavail_body["message"].strip()), 0)

        # 2. Available response contract verification
        report = json.loads(SYNTHETIC_REPORT_PATH.read_text(encoding="utf-8"))
        service = DeliveryModelService(Path(report["best_model_artifact"]))
        app.dependency_overrides[get_model_service] = lambda: service
        available_res = call_api("POST", "/predict", json=VALID_REQUEST)
        self.assertEqual(available_res.status_code, 200)
        avail_body = available_res.json()
        self.assertEqual(sorted(avail_body.keys()), expected_keys)
        self.assertEqual(avail_body["prediction_status"], "available")
        self.assertIsInstance(avail_body["predicted_duration_minutes"], (int, float))
        self.assertGreater(avail_body["predicted_duration_minutes"], 0)
        self.assertIsInstance(avail_body["model_version"], str)
        self.assertGreater(len(avail_body["model_version"].strip()), 0)
        self.assertIsInstance(avail_body["message"], str)
        self.assertGreater(len(avail_body["message"].strip()), 0)

    def test_coordinate_value_zero_is_preserved(self) -> None:
        zero_coord_request = {
            **VALID_REQUEST,
            "pickup_latitude": 0.0,
            "pickup_longitude": 0.0,
            "destination_latitude": 0.0,
            "destination_longitude": 0.0,
        }
        request = DeliveryPredictionRequest.model_validate(zero_coord_request)
        features = make_model_features(request)
        self.assertEqual(features.iloc[0]["pickup_latitude"], 0.0)
        self.assertEqual(features.iloc[0]["pickup_longitude"], 0.0)
        self.assertEqual(features.iloc[0]["destination_latitude"], 0.0)
        self.assertEqual(features.iloc[0]["destination_longitude"], 0.0)

    def test_lade_baseline_artifact_rejected_in_production(self) -> None:
        artifact_path = Path(self.temporary_directory.name) / "lade_baseline.joblib"
        features = pd.DataFrame({
            "priority": ["standard", "express"],
            "package_category": ["parcel", "food"],
            "request_to_assignment_minutes": [10, 8],
            "request_created_hour": [8, 9],
            "request_created_day_of_week": [0, 1],
            "assigned_hour": [8, 9],
            "assigned_day_of_week": [0, 1],
            "weight_kg": [1.0, 2.0],
            "quantity": [1, 1],
            "pickup_latitude": [12.9, 12.9],
            "pickup_longitude": [77.5, 77.5],
            "destination_latitude": [13.0, 13.0],
            "destination_longitude": [77.6, 77.6],
            "straight_line_distance_km": [15.0, 15.0],
        })
        target = np.array([28.0, 32.0])
        model = Pipeline([
            ("preprocessor", create_preprocessor()),
            ("regressor", DummyRegressor(strategy="median")),
        ])
        model.fit(features, target)
        joblib.dump(model, artifact_path)
        artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        metadata = {
            "training_source": "baseline",
            "model_name": "median_baseline",
            "artifact_sha256": artifact_hash,
        }
        artifact_path.with_suffix(".metadata.json").write_text(
            json.dumps(metadata), encoding="utf-8"
        )

        with patch.dict(os.environ, {
            "DELIVERY_MODEL_PATH": str(artifact_path),
            "SWERV_ENV": "production",
            "APPROVED_MODEL_SHA256": artifact_hash,
        }, clear=True):
            service = DeliveryModelService()
            self.assertFalse(service.available)
            self.assertFalse(service.artifacts_loaded)
            self.assertIsNone(service.model_version)

    def test_operational_artifact_rejected_when_hash_not_pinned(self) -> None:
        artifact_path = Path(self.temporary_directory.name) / "unpinned_operational.joblib"
        features = pd.DataFrame({
            "priority": ["standard", "express"],
            "package_category": ["parcel", "food"],
            "request_to_assignment_minutes": [10, 8],
            "request_created_hour": [8, 9],
            "request_created_day_of_week": [0, 1],
            "assigned_hour": [8, 9],
            "assigned_day_of_week": [0, 1],
            "weight_kg": [1.0, 2.0],
            "quantity": [1, 1],
            "pickup_latitude": [12.9, 12.9],
            "pickup_longitude": [77.5, 77.5],
            "destination_latitude": [13.0, 13.0],
            "destination_longitude": [77.6, 77.6],
            "straight_line_distance_km": [15.0, 15.0],
        })
        target = np.array([25.0, 35.0])
        model = Pipeline([
            ("preprocessor", create_preprocessor()),
            ("regressor", LinearRegression()),
        ])
        model.fit(features, target)
        joblib.dump(model, artifact_path)
        artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        metadata = {
            "training_source": "operational",
            "model_name": "linear_regression",
            "artifact_sha256": artifact_hash,
        }
        artifact_path.with_suffix(".metadata.json").write_text(
            json.dumps(metadata), encoding="utf-8"
        )

        other_valid_hash = "a" * 64
        with patch.dict(os.environ, {
            "DELIVERY_MODEL_PATH": str(artifact_path),
            "SWERV_ENV": "production",
            "APPROVED_MODEL_SHA256": other_valid_hash,
        }, clear=True):
            service = DeliveryModelService()
            self.assertFalse(service.available)
            self.assertFalse(service.artifacts_loaded)

    def test_missing_approved_model_sha256_rejected_in_production(self) -> None:
        report = json.loads(SYNTHETIC_REPORT_PATH.read_text(encoding="utf-8"))
        selected_artifact = Path(report["best_model_artifact"]).resolve()
        with patch.dict(os.environ, {
            "DELIVERY_MODEL_PATH": str(selected_artifact),
            "SWERV_ENV": "production",
        }, clear=True):
            service = DeliveryModelService()
            self.assertFalse(service.available)

    def test_malformed_approved_model_sha256_rejected_in_production(self) -> None:
        report = json.loads(SYNTHETIC_REPORT_PATH.read_text(encoding="utf-8"))
        selected_artifact = Path(report["best_model_artifact"]).resolve()
        for malformed in ("not_a_hash", "1234", "z" * 64):
            with patch.dict(os.environ, {
                "DELIVERY_MODEL_PATH": str(selected_artifact),
                "SWERV_ENV": "production",
                "APPROVED_MODEL_SHA256": malformed,
            }, clear=True):
                service = DeliveryModelService()
                self.assertFalse(service.available, f"Malformed {malformed} should be rejected")

    def test_tampered_artifact_rejected_in_production(self) -> None:
        artifact_path = Path(self.temporary_directory.name) / "tampered_operational.joblib"
        features = pd.DataFrame({
            "priority": ["standard", "express"],
            "package_category": ["parcel", "food"],
            "request_to_assignment_minutes": [10, 8],
            "request_created_hour": [8, 9],
            "request_created_day_of_week": [0, 1],
            "assigned_hour": [8, 9],
            "assigned_day_of_week": [0, 1],
            "weight_kg": [1.0, 2.0],
            "quantity": [1, 1],
            "pickup_latitude": [12.9, 12.9],
            "pickup_longitude": [77.5, 77.5],
            "destination_latitude": [13.0, 13.0],
            "destination_longitude": [77.6, 77.6],
            "straight_line_distance_km": [15.0, 15.0],
        })
        target = np.array([25.0, 35.0])
        model = Pipeline([
            ("preprocessor", create_preprocessor()),
            ("regressor", LinearRegression()),
        ])
        model.fit(features, target)
        joblib.dump(model, artifact_path)
        original_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        metadata = {
            "training_source": "operational",
            "model_name": "linear_regression",
            "artifact_sha256": original_hash,
        }
        artifact_path.with_suffix(".metadata.json").write_text(
            json.dumps(metadata), encoding="utf-8"
        )
        with artifact_path.open("ab") as f:
            f.write(b"tampered")

        with patch.dict(os.environ, {
            "DELIVERY_MODEL_PATH": str(artifact_path),
            "SWERV_ENV": "production",
            "APPROVED_MODEL_SHA256": original_hash,
        }, clear=True):
            service = DeliveryModelService()
            self.assertFalse(service.available)
            self.assertFalse(service.artifacts_loaded)

    def test_render_environment_variable_activates_production_guard(self) -> None:
        report = json.loads(SYNTHETIC_REPORT_PATH.read_text(encoding="utf-8"))
        selected_artifact = Path(report["best_model_artifact"]).resolve()
        with patch.dict(os.environ, {
            "DELIVERY_MODEL_PATH": str(selected_artifact),
            "RENDER": "true",
        }, clear=True):
            service = DeliveryModelService()
            self.assertFalse(service.available)
            self.assertFalse(service.artifacts_loaded)

    def test_application_lifespan_startup(self) -> None:
        async def check_lifespan():
            async with app.router.lifespan_context(app):
                pass
        asyncio.run(check_lifespan())


if __name__ == "__main__":
    unittest.main()

"""Focused tests for the operational vs. demo prediction endpoints and security guards."""

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import httpx
import numpy as np
import pandas as pd

from src.api import app
from src.model_service import (
    DeliveryModelService,
    demo_model_service,
    is_demo_enabled,
    is_production_environment,
    operational_model_service,
)
from src.v2_features import build_features, FEATURE_COLUMNS
from src.v2_dataset import VALIDATION_PATH


V2_MODEL_PATH = "models/v2/gradient_boosting.joblib"
APPROVED_SHA = "2e7b05c087e5bb2fbfed1f4766895d7626e0611b6f60f0b9be638a8822f7cafb"
WRONG_SHA = "0000000000000000000000000000000000000000000000000000000000000000"

VALID_REQUEST_PAYLOAD = {
    "request_created_at": "2026-06-01T08:30:00Z",
    "assigned_at": "2026-06-01T08:45:00Z",
    "priority": "standard",
    "package_category": "parcel",
    "weight_kg": 5.0,
    "quantity": 1,
    "pickup_latitude": 12.9716,
    "pickup_longitude": 77.5946,
    "destination_latitude": 13.0358,
    "destination_longitude": 77.6402,
}


def call_api(method: str, path: str, **kwargs) -> httpx.Response:
    async def _send():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.request(method, path, **kwargs)
    return asyncio.run(_send())


class V2ModelPredictionTests(unittest.TestCase):
    def test_operational_predict_rejects_synthetic_models_in_production(self) -> None:
        """Requirement 1: Operational /predict strictly rejects synthetic models in production."""
        with patch.dict(os.environ, {
            "SWERV_ENV": "production",
            "RENDER": "true",
            "DELIVERY_MODEL_PATH": V2_MODEL_PATH,
            "APPROVED_MODEL_SHA256": APPROVED_SHA,
        }):
            op_service = DeliveryModelService(mode="operational")
            self.assertFalse(op_service.available)
            self.assertIsNone(op_service.model_version)

            with patch("src.api.operational_model_service", op_service):
                resp = call_api("POST", "/predict", json=VALID_REQUEST_PAYLOAD)
                self.assertEqual(resp.status_code, 503)
                data = resp.json()
                self.assertEqual(data["prediction_status"], "unavailable")
                self.assertIsNone(data["predicted_duration_minutes"])

    def test_demo_predict_accepts_verified_synthetic_v2_model(self) -> None:
        """Requirement 2: /demo/predict accepts the verified Synthetic v2 model and returns proper label."""
        with patch.dict(os.environ, {
            "SWERV_ENV": "production",
            "RENDER": "true",
            "ENABLE_DEMO_ENDPOINT": "true",
            "DEMO_MODEL_PATH": V2_MODEL_PATH,
            "DEMO_APPROVED_MODEL_SHA256": APPROVED_SHA,
        }):
            demo_service = DeliveryModelService(mode="demo")
            self.assertTrue(demo_service.available)
            self.assertEqual(demo_service.model_version, "gradient_boosting-synthetic-2e7b05c087e5")

            with patch("src.api.demo_model_service", demo_service):
                resp = call_api("POST", "/demo/predict", json=VALID_REQUEST_PAYLOAD)
                self.assertEqual(resp.status_code, 200)
                data = resp.json()
                self.assertEqual(data["prediction_type"], "simulated_demo")
                self.assertEqual(data["model_version"], "gradient_boosting-synthetic-2e7b05c087e5")
                self.assertEqual(data["prediction_status"], "available")
                self.assertIsNotNone(data["predicted_duration_minutes"])
                self.assertGreater(data["predicted_duration_minutes"], 0.0)

    def test_demo_predict_rejects_incorrect_sha256(self) -> None:
        """Requirement 5: Incorrect SHA-256 is strictly rejected."""
        with patch.dict(os.environ, {
            "ENABLE_DEMO_ENDPOINT": "true",
            "DEMO_MODEL_PATH": V2_MODEL_PATH,
            "DEMO_APPROVED_MODEL_SHA256": WRONG_SHA,
        }):
            demo_service = DeliveryModelService(mode="demo")
            self.assertFalse(demo_service.available)

            with patch("src.api.demo_model_service", demo_service):
                resp = call_api("POST", "/demo/predict", json=VALID_REQUEST_PAYLOAD)
                self.assertEqual(resp.status_code, 503)
                data = resp.json()
                self.assertEqual(data["prediction_status"], "unavailable")

    def test_demo_predict_rejects_missing_demo_opt_in(self) -> None:
        """Requirement 5: Missing demo opt-in (ENABLE_DEMO_ENDPOINT unset) disables the endpoint."""
        with patch.dict(os.environ, {
            "ENABLE_DEMO_ENDPOINT": "",
            "DEMO_MODEL_PATH": V2_MODEL_PATH,
            "DEMO_APPROVED_MODEL_SHA256": APPROVED_SHA,
        }):
            resp = call_api("POST", "/demo/predict", json=VALID_REQUEST_PAYLOAD)
            self.assertEqual(resp.status_code, 503)
            data = resp.json()
            self.assertEqual(data["prediction_status"], "unavailable")
            self.assertIn("disabled", data["message"])

    def test_demo_predictions_are_finite_and_positive(self) -> None:
        """Requirement 5: Demo predictions are finite, positive, and physically realistic."""
        with patch.dict(os.environ, {
            "ENABLE_DEMO_ENDPOINT": "true",
            "DEMO_MODEL_PATH": V2_MODEL_PATH,
            "DEMO_APPROVED_MODEL_SHA256": APPROVED_SHA,
        }):
            demo_service = DeliveryModelService(mode="demo")
            with patch("src.api.demo_model_service", demo_service):
                resp = call_api("POST", "/demo/predict", json=VALID_REQUEST_PAYLOAD)
                self.assertEqual(resp.status_code, 200)
                pred = resp.json()["predicted_duration_minutes"]
                self.assertIsInstance(pred, float)
                self.assertTrue(np.isfinite(pred))
                self.assertGreater(pred, 5.0)

    def test_health_reports_operational_and_demo_availability_separately(self) -> None:
        """Requirement 3: Health endpoint reports operational and demo availability separately."""
        with patch.dict(os.environ, {
            "SWERV_ENV": "production",
            "RENDER": "true",
            "DELIVERY_MODEL_PATH": "",
            "APPROVED_MODEL_SHA256": "",
            "ENABLE_DEMO_ENDPOINT": "true",
            "DEMO_MODEL_PATH": V2_MODEL_PATH,
            "DEMO_APPROVED_MODEL_SHA256": APPROVED_SHA,
        }):
            op_service = DeliveryModelService(mode="operational")
            demo_service = DeliveryModelService(mode="demo")

            with patch("src.api.operational_model_service", op_service):
                with patch("src.api.demo_model_service", demo_service):
                    resp = call_api("GET", "/health")
                    self.assertEqual(resp.status_code, 200)
                    data = resp.json()
                    self.assertEqual(data["status"], "ok")
                    # Operational must be unavailable in standby
                    self.assertFalse(data["operational_model_available"])
                    self.assertIsNone(data["operational_model_version"])
                    self.assertFalse(data["model_available"])
                    # Demo must be available with synthetic v2 model version
                    self.assertTrue(data["demo_model_available"])
                    self.assertEqual(data["demo_model_version"], "gradient_boosting-synthetic-2e7b05c087e5")

                    # Verify HEAD probes on /health and / for Render zero-downtime deployment health checks
                    head_health = call_api("HEAD", "/health")
                    self.assertEqual(head_health.status_code, 200)
                    self.assertEqual(head_health.text, "")

                    head_root = call_api("HEAD", "/")
                    self.assertEqual(head_root.status_code, 200)
                    self.assertEqual(head_root.text, "")

                    get_root = call_api("GET", "/")
                    self.assertEqual(get_root.status_code, 200)
                    self.assertEqual(get_root.json(), data)

    def test_priority_tier_effects_on_demo_predictions(self) -> None:
        """Verify priority tier effect in demo model."""
        with patch.dict(os.environ, {
            "ENABLE_DEMO_ENDPOINT": "true",
            "DEMO_MODEL_PATH": V2_MODEL_PATH,
            "DEMO_APPROVED_MODEL_SHA256": APPROVED_SHA,
        }):
            demo_service = DeliveryModelService(mode="demo")
            with patch("src.api.demo_model_service", demo_service):
                preds = {}
                for tier in ["standard", "express", "urgent"]:
                    payload = dict(VALID_REQUEST_PAYLOAD, priority=tier)
                    resp = call_api("POST", "/demo/predict", json=payload)
                    self.assertEqual(resp.status_code, 200)
                    preds[tier] = resp.json()["predicted_duration_minutes"]

                self.assertLess(preds["urgent"], preds["standard"])
                self.assertLess(preds["express"], preds["standard"])


if __name__ == "__main__":
    unittest.main()

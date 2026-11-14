"""API checks for hourly synthetic demand forecasts."""

from __future__ import annotations

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.api import app, get_model_bundle


def call_api(method: str, path: str, **kwargs: object) -> httpx.Response:
    async def send_request() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(send_request())


def valid_request() -> dict[str, object]:
    return {
        "forecast_start_timestamp": "2026-01-01T00:00:00Z",
        "forecast_periods": 3,
    }


def service_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {os.environ['DEMAND_FORECASTING_API_KEY']}"}


class DemandForecastApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_api_key = os.environ.get("DEMAND_FORECASTING_API_KEY")
        os.environ["DEMAND_FORECASTING_API_KEY"] = "test-demand-forecasting-service-key-32-chars"

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        if self.original_api_key is None:
            os.environ.pop("DEMAND_FORECASTING_API_KEY", None)
        else:
            os.environ["DEMAND_FORECASTING_API_KEY"] = self.original_api_key

    def test_health_reports_loaded_model_and_synthetic_provenance(self) -> None:
        response = call_api("GET", "/health")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["model_available"])
        self.assertTrue(response.json()["synthetic_history_available"])
        self.assertEqual(response.json()["model_version"], "gradient_boosting-synthetic-a62c1700d5fb")
        self.assertEqual(response.json()["training_source"], "synthetic")
        self.assertIn("real-world", response.json()["synthetic_provenance"])

    def test_prediction_returns_each_requested_utc_hour_as_non_negative_integer(self) -> None:
        response = call_api("POST", "/predict", json=valid_request(), headers=service_headers())

        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        predictions = result["predictions"]
        self.assertEqual(len(predictions), 3)
        self.assertEqual(result["model_version"], "gradient_boosting-synthetic-a62c1700d5fb")
        self.assertEqual(result["history_source"], "synthetic_hourly_demand.csv")
        self.assertIn("bundled generated synthetic", result["history_provenance"])
        self.assertEqual(result["training_source"], "synthetic")
        self.assertIn("synthetic", result["synthetic_provenance"].lower())
        self.assertEqual(
            [item["timestamp"] for item in predictions],
            [
                "2026-01-01T00:00:00Z",
                "2026-01-01T01:00:00Z",
                "2026-01-01T02:00:00Z",
            ],
        )
        for item in predictions:
            self.assertIsInstance(item["request_count"], int)
            self.assertGreaterEqual(item["request_count"], 0)
            self.assertTrue(np.isfinite(item["request_count"]))

    def test_invalid_timestamp_horizon_and_client_history_are_rejected(self) -> None:
        invalid_requests = []

        naive_time = valid_request()
        naive_time["forecast_start_timestamp"] = "2026-01-01T00:00:00"
        invalid_requests.append(naive_time)

        misaligned_time = valid_request()
        misaligned_time["forecast_start_timestamp"] = "2026-01-01T00:30:00Z"
        invalid_requests.append(misaligned_time)

        too_many_hours = valid_request()
        too_many_hours["forecast_periods"] = 169
        invalid_requests.append(too_many_hours)

        zero_hours = valid_request()
        zero_hours["forecast_periods"] = 0
        invalid_requests.append(zero_hours)

        latest_history_hour = valid_request()
        latest_history_hour["forecast_start_timestamp"] = "2025-12-31T23:00:00Z"
        invalid_requests.append(latest_history_hour)

        client_history = valid_request()
        client_history["historical_request_counts"] = [1] * 168
        invalid_requests.append(client_history)

        for body in invalid_requests:
            response = call_api("POST", "/predict", json=body, headers=service_headers())
            self.assertEqual(response.status_code, 422, response.text)

    def test_unavailable_model_returns_clear_503(self) -> None:
        app.dependency_overrides[get_model_bundle] = lambda: None
        health = call_api("GET", "/health")
        response = call_api("POST", "/predict", json=valid_request(), headers=service_headers())

        self.assertFalse(health.json()["model_available"])
        self.assertIsNone(health.json()["model_version"])
        self.assertEqual(response.status_code, 503)
        self.assertIn("no forecast was generated", response.json()["detail"])
        self.assertTrue(health.json()["synthetic_history_available"])

    def test_prediction_rejects_missing_or_incorrect_service_credentials(self) -> None:
        missing = call_api("POST", "/predict", json=valid_request())
        incorrect = call_api(
            "POST",
            "/predict",
            json=valid_request(),
            headers={"Authorization": "Bearer incorrect-service-key"},
        )

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(incorrect.status_code, 401)
        self.assertNotIn(os.environ["DEMAND_FORECASTING_API_KEY"], missing.text)
        self.assertNotIn(os.environ["DEMAND_FORECASTING_API_KEY"], incorrect.text)

    def test_predict_returns_safe_configuration_error_when_service_key_is_missing(self) -> None:
        os.environ.pop("DEMAND_FORECASTING_API_KEY")
        response = call_api(
            "POST",
            "/predict",
            json=valid_request(),
            headers={"Authorization": "Bearer test-demand-forecasting-service-key-32-chars"},
        )

        self.assertEqual(response.status_code, 503)
        self.assertNotIn("test-demand-forecasting-service-key-32-chars", response.text)

    def test_health_remains_public(self) -> None:
        response = call_api("GET", "/health")
        self.assertEqual(response.status_code, 200)

    def test_health_reports_missing_synthetic_history_without_exposing_details(self) -> None:
        with patch("src.api.load_synthetic_history", side_effect=FileNotFoundError("private path")):
            response = call_api("GET", "/health")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["synthetic_history_available"])
        self.assertNotIn("private path", response.text)

    def test_missing_synthetic_history_returns_unavailable_without_operational_fallback(self) -> None:
        with patch("src.api.load_synthetic_history", side_effect=FileNotFoundError("private path")):
            response = call_api("POST", "/predict", json=valid_request(), headers=service_headers())

        self.assertEqual(response.status_code, 503)
        self.assertIn("could not produce a valid forecast", response.json()["detail"])
        self.assertNotIn("private path", response.text)


if __name__ == "__main__":
    unittest.main()

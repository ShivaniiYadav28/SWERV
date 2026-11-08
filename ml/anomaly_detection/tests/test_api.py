"""FastAPI tests use synthetic examples and never call MongoDB."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.api import app, restrict_unsupported_category
from src.model_service import ModelUnavailableError
from src.synthetic_dataset import FEATURE_COLUMNS, generate_dataset


async def send_request(method: str, path: str, **kwargs: object) -> httpx.Response:
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)


def call_api(method: str, path: str, **kwargs: object) -> httpx.Response:
    return asyncio.run(send_request(method, path, **kwargs))


def valid_scenario(seed: int = 42) -> dict[str, object]:
    row = generate_dataset(1, seed, "api_test")[0]
    return {
        "features": {column: row[column] for column in FEATURE_COLUMNS},
        "duration_baseline_count": 5,
    }


def valid_request(mode: str = "synthetic_demo") -> dict[str, object]:
    return {"detection_mode": mode, "scenarios": [valid_scenario()]}


class AnomalyApiTests(unittest.TestCase):
    def test_health_reports_loaded_synthetic_model_metadata(self) -> None:
        response = call_api("GET", "/health")
        body = response.json()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(body["model_available"])
        self.assertTrue(body["model_version"].startswith("random_forest-synthetic-"))
        self.assertEqual(body["training_data_source"], "synthetic")
        self.assertIn("not validated", body["synthetic_provenance"])

    def test_predict_handles_multiple_scenarios_and_preserves_selected_mode(self) -> None:
        body = valid_request("synthetic_demo")
        body["scenarios"] = [valid_scenario(43), valid_scenario(44)]

        response = call_api("POST", "/predict", json=body)
        result = response.json()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(result["detection_mode"], "synthetic_demo")
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["training_data_source"], "synthetic")
        self.assertEqual(result["results"][0]["input_data_source"], "synthetic_demo")
        self.assertEqual(result["results"][0]["detection_method"], "machine_learning")
        self.assertEqual(result["results"][0]["model_type"], "supervised")
        self.assertTrue(result["results"][0]["model_version"].startswith("random_forest-synthetic-"))

    def test_real_mode_scores_only_the_supplied_values_and_labels_provenance(self) -> None:
        response = call_api("POST", "/predict", json=valid_request("real"))
        body = response.json()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(body["detection_mode"], "real")
        self.assertEqual(body["results"][0]["input_data_source"], "real")
        self.assertEqual(body["results"][0]["training_data_source"], "synthetic")
        self.assertTrue(any("real-world accuracy is unvalidated" in note for note in body["results"][0]["data_quality_notes"]))

    def test_missing_agent_vehicle_type_is_supported_without_fabricating_a_value(self) -> None:
        body = valid_request("real")
        body["scenarios"][0]["features"]["vehicle_type"] = None
        response = call_api("POST", "/predict", json=body)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["results"][0]["input_data_source"], "real")

    def test_missing_creation_timestamp_feature_is_supported_as_null(self) -> None:
        body = valid_request("real")
        body["scenarios"][0]["features"]["dispatch_creation_hour"] = None
        response = call_api("POST", "/predict", json=body)

        self.assertEqual(response.status_code, 200, response.text)

    def test_keeps_rule_findings_separate_from_model_candidates(self) -> None:
        body = valid_request("real")
        body["dispatches"] = [{"_id": "dispatch-api-test", "status": "delivered", "assignedAgent": "agent-1"}]
        body["dispatch_activities"] = [{
            "dispatchRequestId": "dispatch-api-test",
            "eventType": "status_changed",
            "createdAt": "2026-01-01T01:00:00Z",
            "previousValue": {"status": "pending"},
            "newValue": {"status": "delivered"},
        }]

        response = call_api("POST", "/predict", json=body)
        result = response.json()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(result["rule_based_findings"][0]["anomaly_type"], "invalid_status_transition")
        self.assertEqual(result["results"][0]["detection_method"], "machine_learning")
        self.assertIn("rule_based_limitations", result)

    def test_rejects_missing_features_extra_labels_invalid_categories_and_ranges(self) -> None:
        invalid_bodies = []

        missing_features = valid_request()
        missing_features["scenarios"] = [{"features": {}, "duration_baseline_count": 5}]
        invalid_bodies.append(missing_features)

        extra_label = valid_request()
        extra_label["scenarios"] = [{**valid_scenario(), "is_anomaly": 1}]
        invalid_bodies.append(extra_label)

        bad_hour = valid_request()
        bad_hour["scenarios"] = [valid_scenario()]
        bad_hour["scenarios"][0]["features"]["dispatch_creation_hour"] = 24
        invalid_bodies.append(bad_hour)

        bad_mode = valid_request("real-ish")
        invalid_bodies.append(bad_mode)

        empty_batch = {"detection_mode": "real", "scenarios": []}
        invalid_bodies.append(empty_batch)

        for body in invalid_bodies:
            self.assertEqual(call_api("POST", "/predict", json=body).status_code, 422)

    def test_missing_model_returns_safe_unavailable_response(self) -> None:
        with patch("src.api.load_model_artifact", side_effect=ModelUnavailableError("private model path")):
            health = call_api("GET", "/health")
            response = call_api("POST", "/predict", json=valid_request())

        self.assertFalse(health.json()["model_available"])
        self.assertEqual(response.status_code, 503)
        self.assertIn("no predictions were generated", response.json()["detail"])
        self.assertNotIn("private model path", response.json()["detail"])

    def test_duration_category_is_withheld_without_minimum_baseline(self) -> None:
        result = {
            "is_anomaly_candidate": True,
            "predicted_category": "unusual_delivery_duration",
            "data_quality_notes": [],
        }
        features = {column: 0 for column in FEATURE_COLUMNS}

        restrict_unsupported_category(result, features, duration_baseline_count=5)

        self.assertFalse(result["is_anomaly_candidate"])
        self.assertIsNone(result["predicted_category"])
        self.assertTrue(any("fewer than 30" in note for note in result["data_quality_notes"]))

    def test_gps_jump_category_is_withheld_when_accuracy_is_insufficient(self) -> None:
        result = {
            "is_anomaly_candidate": True,
            "predicted_category": "gps_implausible_jump",
            "data_quality_notes": [],
        }
        features = {column: 0 for column in FEATURE_COLUMNS}
        features.update({
            "gps_pair_available": 1,
            "gps_coordinates_valid": 1,
            "gps_timestamps_valid": 1,
            "gps_freshness_minutes": 1,
            "gps_accuracy_meters": 500,
            "gps_interval_minutes": 1,
        })

        restrict_unsupported_category(result, features, duration_baseline_count=40)

        self.assertFalse(result["is_anomaly_candidate"])
        self.assertIsNone(result["predicted_category"])
        self.assertTrue(any("inaccurate" in note for note in result["data_quality_notes"]))


if __name__ == "__main__":
    unittest.main()

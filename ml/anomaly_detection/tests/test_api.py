"""FastAPI tests cover service security and generated data only."""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import src.api as api_module
from src.api import app, classify_severity, load_demo_scenarios
from src.model_service import (
    EXPECTED_ARTIFACT_SHA256,
    EXPECTED_MODEL_VERSION,
    ModelUnavailableError,
    load_model_artifact,
    score_scenario,
)
from src.synthetic_dataset import ANOMALY_WEIGHTS, FEATURE_COLUMNS, generate_dataset


SERVICE_API_KEY = "test-anomaly-api-key-with-at-least-32-characters"
NORMAL_FEATURES: dict[str, object]
ANOMALOUS_FEATURES: dict[str, object]
MODEL_ARTIFACT: dict[str, object]


async def send_request(method: str, path: str, **kwargs: object) -> httpx.Response:
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)


def call_api(
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    body: object | None = None,
    content: bytes | None = None,
    service_key: str = SERVICE_API_KEY,
) -> httpx.Response:
    request_kwargs: dict[str, object] = {"headers": headers or {}}
    if body is not None:
        request_kwargs["json"] = body
    if content is not None:
        request_kwargs["content"] = content
        request_kwargs["headers"] = {**(headers or {}), "content-type": "application/json"}
    with patch.dict("os.environ", {api_module.API_KEY_ENVIRONMENT_VARIABLE: service_key}):
        return asyncio.run(send_request(method, path, **request_kwargs))


def auth_headers(api_key: str = SERVICE_API_KEY) -> dict[str, str]:
    return {"authorization": f"Bearer {api_key}"}


def prediction_request(features: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "detection_mode": "synthetic_demo",
        "scenarios": [{"features": features or NORMAL_FEATURES}],
    }


class AnomalyApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        global MODEL_ARTIFACT, NORMAL_FEATURES, ANOMALOUS_FEATURES
        MODEL_ARTIFACT = load_model_artifact(
            api_module.MODEL_PATH,
            api_module.MODEL_METADATA_PATH,
        )
        rows = generate_dataset(2500, seed=94001, split_name="api_test")
        normal_candidates = [row for row in rows if row["anomaly_type"] == "normal"]
        anomaly_candidates = [row for row in rows if row["anomaly_type"] == "abnormal_delivery_distance"]

        for row in normal_candidates:
            features = {column: row[column] for column in FEATURE_COLUMNS}
            if not score_scenario(features, MODEL_ARTIFACT)["is_anomaly_candidate"]:
                NORMAL_FEATURES = features
                break
        else:
            raise AssertionError("Could not find a generated normal scenario below the model threshold.")

        for row in anomaly_candidates:
            features = {column: row[column] for column in FEATURE_COLUMNS}
            if score_scenario(features, MODEL_ARTIFACT)["is_anomaly_candidate"]:
                ANOMALOUS_FEATURES = features
                break
        else:
            raise AssertionError("Could not find a generated distance anomaly above the model threshold.")

    def test_public_health_reports_model_integrity_schema_and_provenance(self) -> None:
        response = call_api("GET", "/health")
        body = response.json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["model_available"])
        self.assertEqual(body["model_version"], EXPECTED_MODEL_VERSION)
        self.assertEqual(body["artifact_integrity_status"], "verified")
        self.assertTrue(body["feature_schema_compatible"])
        self.assertTrue(body["demo_data_available"])
        self.assertEqual(body["training_data_source"], "synthetic")
        self.assertIn("generated anomaly scenarios", body["training_provenance"])

    def test_predict_requires_a_valid_bearer_token(self) -> None:
        body = prediction_request()
        missing = call_api("POST", "/predict", body=body)
        invalid = call_api("POST", "/predict", headers=auth_headers("wrong-key"), body=body)

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(invalid.status_code, 401)
        self.assertNotIn(SERVICE_API_KEY, missing.text)
        self.assertNotIn(SERVICE_API_KEY, invalid.text)

    def test_unconfigured_service_key_fails_closed(self) -> None:
        response = call_api(
            "POST",
            "/predict",
            headers=auth_headers(),
            body=prediction_request(),
            service_key="",
        )

        self.assertEqual(response.status_code, 503)
        self.assertNotIn(SERVICE_API_KEY, response.text)

    def test_predict_returns_a_normal_feature_only_result(self) -> None:
        response = call_api(
            "POST", "/predict", headers=auth_headers(), body=prediction_request(NORMAL_FEATURES)
        )
        body = response.json()
        result = body["results"][0]

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(body["model_version"], EXPECTED_MODEL_VERSION)
        self.assertEqual(body["scenario_count"], 1)
        self.assertEqual(body["candidate_count"], 0)
        self.assertFalse(result["is_anomaly"])
        self.assertEqual(result["severity"], "none")
        self.assertIsNone(result["scenario_category"])
        self.assertIsNone(result["scenario_category_source"])
        self.assertFalse(result["scenario_category_is_model_prediction"])
        self.assertEqual(result["scenario_id"], "prediction-0001")
        self.assertIn("timestamp", result)
        self.assertNotIn("probability", result)

    def test_predict_returns_an_anomaly_candidate_without_claiming_category(self) -> None:
        response = call_api(
            "POST", "/predict", headers=auth_headers(), body=prediction_request(ANOMALOUS_FEATURES)
        )
        body = response.json()
        result = body["results"][0]

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(result["is_anomaly"])
        self.assertGreater(result["anomaly_score"], result["decision_threshold"])
        self.assertIn(result["severity"], {"low", "medium", "high", "critical"})
        self.assertIsNone(result["scenario_category"])
        self.assertFalse(result["scenario_category_is_model_prediction"])
        self.assertIn("exceeds the decision threshold", result["explanation"])
        self.assertNotIn("probability", result["explanation"].lower())

    def test_predict_rejects_missing_features_unexpected_fields_and_raw_records(self) -> None:
        missing_feature = prediction_request()
        missing_feature["scenarios"] = [{"features": {}}]
        extra_feature = prediction_request()
        extra_feature["scenarios"] = [{"features": {**NORMAL_FEATURES, "customer_email": "person@example.test"}}]
        raw_records = {**prediction_request(), "dispatches": [{"_id": "dispatch-1"}]}
        real_mode = {**prediction_request(), "detection_mode": "real"}

        for invalid_body in (missing_feature, extra_feature, raw_records, real_mode):
            with self.subTest(body=invalid_body):
                response = call_api("POST", "/predict", headers=auth_headers(), body=invalid_body)
                self.assertEqual(response.status_code, 422)

    def test_predict_rejects_extreme_values_and_oversized_batches(self) -> None:
        extreme = dict(NORMAL_FEATURES)
        extreme["delivery_distance_km"] = 10_001
        too_many = {
            "detection_mode": "synthetic_demo",
            "scenarios": [{"features": NORMAL_FEATURES}] * 101,
        }

        for body in (prediction_request(extreme), too_many):
            self.assertEqual(call_api("POST", "/predict", headers=auth_headers(), body=body).status_code, 422)

        oversized = call_api(
            "POST",
            "/predict",
            headers=auth_headers(),
            content=b" " * (api_module.MAX_REQUEST_BODY_BYTES + 1),
        )
        self.assertEqual(oversized.status_code, 413)

    def test_demo_endpoint_generates_category_metadata_inside_the_service(self) -> None:
        response = call_api("POST", "/analyze-demo", headers=auth_headers())
        body = response.json()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(body["scenario_count"], api_module.DEMO_SCENARIO_COUNT)
        self.assertEqual(len(body["results"]), api_module.DEMO_SCENARIO_COUNT)
        self.assertEqual(body["model_version"], EXPECTED_MODEL_VERSION)
        self.assertIn("generated demonstration data", body["demonstration_provenance"])
        self.assertEqual(
            {result["scenario_category"] for result in body["results"]},
            set(ANOMALY_WEIGHTS),
        )
        self.assertTrue(all(result["scenario_id"].startswith("demo-") for result in body["results"]))
        self.assertTrue(all(result["scenario_category_source"] == "generated_demo_label" for result in body["results"]))
        self.assertTrue(all(result["scenario_category_is_model_prediction"] is False for result in body["results"]))
        self.assertTrue(all("not a model prediction" in result["explanation"] for result in body["results"]))

    def test_demo_endpoint_rejects_unexpected_body_fields(self) -> None:
        response = call_api("POST", "/analyze-demo", headers=auth_headers(), body={"dispatches": []})
        self.assertEqual(response.status_code, 422)

    def test_demo_loader_uses_the_generated_demo_split_and_all_labels(self) -> None:
        scenarios = load_demo_scenarios()

        self.assertEqual(len(scenarios), api_module.DEMO_SCENARIO_COUNT)
        self.assertEqual({row["scenario_category"] for row in scenarios}, set(ANOMALY_WEIGHTS))
        self.assertTrue(all(set(row["features"]) == set(FEATURE_COLUMNS) for row in scenarios))

    def test_demo_loader_fails_safely_when_dataset_is_missing(self) -> None:
        with self.assertRaisesRegex(api_module.DemoDataUnavailableError, "unavailable"):
            load_demo_scenarios(Path("missing-demo.csv"), Path("missing-metadata.json"))

    def test_severity_bands_are_score_margins_not_probabilities(self) -> None:
        threshold = 0.0
        self.assertEqual(classify_severity(-0.001, threshold), "none")
        self.assertEqual(classify_severity(0.005, threshold), "low")
        self.assertEqual(classify_severity(0.02, threshold), "medium")
        self.assertEqual(classify_severity(0.08, threshold), "high")
        self.assertEqual(classify_severity(0.12, threshold), "critical")

    def test_artifact_digest_failure_is_rejected_before_joblib_load(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            artifact_path = Path(directory) / "anomaly_detector.joblib"
            metadata_path = Path(directory) / "anomaly_detector.metadata.json"
            shutil.copyfile(api_module.MODEL_PATH, artifact_path)
            shutil.copyfile(api_module.MODEL_METADATA_PATH, metadata_path)
            artifact_path.write_bytes(artifact_path.read_bytes() + b"corruption")

            with patch("src.model_service.joblib.load") as load_joblib:
                with self.assertRaises(ModelUnavailableError) as raised:
                    load_model_artifact(artifact_path, metadata_path)

            load_joblib.assert_not_called()
            self.assertEqual(raised.exception.artifact_integrity_status, "failed")

    def test_incompatible_sidecar_schema_is_rejected_before_deserialization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            artifact_path = Path(directory) / "anomaly_detector.joblib"
            metadata_path = Path(directory) / "anomaly_detector.metadata.json"
            shutil.copyfile(api_module.MODEL_PATH, artifact_path)
            metadata = json.loads(api_module.MODEL_METADATA_PATH.read_text(encoding="utf-8"))
            metadata["features"] = metadata["features"][:-1]
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

            with patch("src.model_service.joblib.load") as load_joblib:
                with self.assertRaises(ModelUnavailableError) as raised:
                    load_model_artifact(artifact_path, metadata_path)

            load_joblib.assert_not_called()
            self.assertEqual(raised.exception.artifact_integrity_status, "verified")
            self.assertFalse(raised.exception.feature_schema_compatible)

    def test_deserialization_failure_is_reported_without_private_details(self) -> None:
        with patch("src.model_service.joblib.load", side_effect=RuntimeError("private loader detail")):
            with self.assertRaises(ModelUnavailableError) as raised:
                load_model_artifact(api_module.MODEL_PATH, api_module.MODEL_METADATA_PATH)

        self.assertEqual(raised.exception.artifact_integrity_status, "verified")
        self.assertNotIn("private loader detail", str(raised.exception))

    def test_health_and_prediction_fail_closed_when_model_loading_fails(self) -> None:
        failure = ModelUnavailableError("private artifact path", artifact_integrity_status="failed")
        with patch("src.api.load_model_artifact", side_effect=failure):
            health = call_api("GET", "/health")
            prediction = call_api(
                "POST", "/predict", headers=auth_headers(), body=prediction_request()
            )

        self.assertFalse(health.json()["model_available"])
        self.assertEqual(health.json()["artifact_integrity_status"], "failed")
        self.assertEqual(prediction.status_code, 503)
        self.assertNotIn("private artifact path", prediction.text)

    def test_service_has_no_mongodb_dependency_or_operational_record_endpoint(self) -> None:
        self.assertNotIn("pymongo", api_module.__dict__)
        self.assertNotIn("MongoClient", api_module.__dict__)
        self.assertEqual(call_api("POST", "/api/dispatches", headers=auth_headers()).status_code, 404)


if __name__ == "__main__":
    unittest.main()
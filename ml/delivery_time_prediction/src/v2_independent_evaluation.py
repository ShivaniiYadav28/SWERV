"""Generate and evaluate the new v2 independent test after model selection."""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from . import training
from .model_service import DeliveryModelService
from .v2_dataset import (
    GENERATION_REPORT_PATH,
    RECORD_ID_COLUMN,
    TRAIN_PATH,
    VALIDATION_PATH,
    V2_DATA_DIR,
    feature_target_fingerprints,
    generate_dataset,
    validate_dataset,
)
from .v2_features import FEATURE_COLUMNS, build_features
from .v2_training import grouped_error_metrics


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_DIR = WORKSPACE / "models" / "v2"
TRAINING_REPORT_PATH = V2_DATA_DIR / "training_report.json"
INDEPENDENT_DATA_PATH = V2_DATA_DIR / "independent_test_dataset.csv"
INDEPENDENT_REPORT_PATH = V2_DATA_DIR / "independent_evaluation_report.json"
OLD_MODEL_PATH = WORKSPACE / "models" / "synthetic" / "gradient_boosting.joblib"
OLD_INDEPENDENT_PATH = WORKSPACE / "data" / "processed" / "independent_testing" / "independent_delivery_time_test_dataset.csv"
OLD_REPORT_PATH = WORKSPACE / "data" / "processed" / "independent_testing" / "independent_testing_report.json"
API_BASE_URL = "http://127.0.0.1:8003"
INDEPENDENT_RECORDS = 2_000
INDEPENDENT_SEED = 31_500_303


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metrics(actual: pd.Series, predicted: np.ndarray) -> dict[str, float]:
    return {
        "mae_minutes": float(mean_absolute_error(actual, predicted)),
        "rmse_minutes": float(np.sqrt(mean_squared_error(actual, predicted))),
        "r2": float(r2_score(actual, predicted)),
    }


def edge_request(row: pd.Series) -> dict[str, Any]:
    return {
        "request_created_at": row["request_created_at"],
        "assigned_at": row["assigned_at"],
        "priority": row["priority"],
        "package_category": row["package_category"],
        "weight_kg": float(row["weight_kg"]),
        "quantity": int(row["quantity"]),
        "pickup_latitude": None if pd.isna(row["pickup_latitude"]) else float(row["pickup_latitude"]),
        "pickup_longitude": None if pd.isna(row["pickup_longitude"]) else float(row["pickup_longitude"]),
        "destination_latitude": None if pd.isna(row["destination_latitude"]) else float(row["destination_latitude"]),
        "destination_longitude": None if pd.isna(row["destination_longitude"]) else float(row["destination_longitude"]),
    }


def test_v2_api(model_version: str, sample: pd.Series) -> dict[str, Any]:
    checks: dict[str, dict[str, Any]] = {}
    with httpx.Client(base_url=API_BASE_URL, timeout=10) as client:
        health = client.get("/health")
        health_json = health.json() if health.headers.get("content-type", "").startswith("application/json") else {}
        checks["health"] = {
            "passed": health.status_code == 200
            and health_json.get("model_available") is True
            and health_json.get("model_version") == model_version,
            "http_status": health.status_code,
            "model_version": health_json.get("model_version"),
        }

        request_body = edge_request(sample)
        if any(pd.isna(sample[column]) for column in (
            "pickup_latitude", "pickup_longitude", "destination_latitude", "destination_longitude",
        )):
            request_body.update({
                "pickup_latitude": 12.9716,
                "pickup_longitude": 77.5946,
                "destination_latitude": 13.01,
                "destination_longitude": 77.63,
            })
        valid_response = client.post("/predict", json=request_body)
        valid_json = valid_response.json()
        duration = valid_json.get("predicted_duration_minutes")
        checks["valid_prediction"] = {
            "passed": valid_response.status_code == 200
            and valid_json.get("prediction_status") == "available"
            and valid_json.get("model_version") == model_version
            and isinstance(duration, (float, int))
            and math.isfinite(float(duration))
            and float(duration) > 0,
            "http_status": valid_response.status_code,
            "model_version": valid_json.get("model_version"),
            "predicted_duration_minutes": duration,
        }

        no_coordinates = dict(request_body)
        no_coordinates.update({
            "pickup_latitude": None, "pickup_longitude": None,
            "destination_latitude": None, "destination_longitude": None,
        })
        missing_response = client.post("/predict", json=no_coordinates)
        missing_json = missing_response.json()
        missing_duration = missing_json.get("predicted_duration_minutes")
        checks["missing_coordinates"] = {
            "passed": missing_response.status_code == 200
            and missing_json.get("prediction_status") == "available"
            and isinstance(missing_duration, (float, int))
            and math.isfinite(float(missing_duration))
            and float(missing_duration) > 0,
            "http_status": missing_response.status_code,
        }

        invalid_weight = dict(request_body)
        invalid_weight["weight_kg"] = -1
        weight_response = client.post("/predict", json=invalid_weight)
        checks["invalid_weight_rejected"] = {
            "passed": weight_response.status_code == 422,
            "http_status": weight_response.status_code,
        }

        post_assignment = dict(request_body)
        post_assignment["delivered_at"] = "2026-01-01T10:00:00Z"
        leakage_response = client.post("/predict", json=post_assignment)
        checks["post_assignment_feature_rejected"] = {
            "passed": leakage_response.status_code == 422,
            "http_status": leakage_response.status_code,
        }
    checks["all_passed"] = {"passed": all(item["passed"] for item in checks.values())}
    return checks


def evaluate_new_independent_test() -> dict[str, Any]:
    required_paths = [
        TRAIN_PATH, VALIDATION_PATH, TRAINING_REPORT_PATH,
        GENERATION_REPORT_PATH, OLD_MODEL_PATH, OLD_INDEPENDENT_PATH, OLD_REPORT_PATH,
    ]
    missing_paths = [str(path) for path in required_paths if not path.is_file()]
    if missing_paths:
        raise FileNotFoundError(f"Required v2 selection or historical files are missing: {missing_paths}")
    training_report = json.loads(TRAINING_REPORT_PATH.read_text(encoding="utf-8"))
    if training_report.get("status") != "v2_validation_and_model_selection_complete":
        raise ValueError("Select and save the v2 model before generating the independent test.")
    if training_report.get("independent_test_used_for_training_or_model_selection") is not False:
        raise ValueError("The v2 training report does not confirm independent-test isolation.")

    protected_hashes = {
        "old_model": sha256(OLD_MODEL_PATH),
        "old_independent_dataset": sha256(OLD_INDEPENDENT_PATH),
        "old_independent_report": sha256(OLD_REPORT_PATH),
        "training_dataset": sha256(TRAIN_PATH),
        "validation_dataset": sha256(VALIDATION_PATH),
    }
    artifact_path = Path(training_report["model_artifact"])
    model_metadata_path = artifact_path.with_suffix(".metadata.json")
    if not artifact_path.is_file() or not model_metadata_path.is_file():
        raise FileNotFoundError("The selected v2 model artifact or metadata is missing.")
    model_service = DeliveryModelService(artifact_path)
    if not model_service.available or model_service.feature_version != "v2":
        raise RuntimeError("The saved v2 model could not be loaded with v2 features.")
    metadata = json.loads(model_metadata_path.read_text(encoding="utf-8"))
    if metadata.get("training_source") != "synthetic":
        raise ValueError("The selected model is missing synthetic training provenance.")

    # The test is first generated after validation-based model selection is complete.
    independent_data = generate_dataset(
        INDEPENDENT_RECORDS,
        INDEPENDENT_SEED,
        datetime(2026, 3, 1, tzinfo=timezone.utc),
        "independent_test",
    )
    validate_dataset(independent_data, "independent_test")
    training_data = pd.read_csv(TRAIN_PATH)
    validation_data = pd.read_csv(VALIDATION_PATH)
    existing_ids = set(training_data[RECORD_ID_COLUMN]) | set(validation_data[RECORD_ID_COLUMN])
    if existing_ids & set(independent_data[RECORD_ID_COLUMN]):
        raise ValueError("Independent scenarios overlap training or validation IDs.")
    if (
        feature_target_fingerprints(independent_data)
        & (feature_target_fingerprints(training_data) | feature_target_fingerprints(validation_data))
    ):
        raise ValueError("Independent feature/target rows overlap training or validation.")

    INDEPENDENT_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    independent_data.to_csv(INDEPENDENT_DATA_PATH, index=False)
    independent_hash_before = sha256(INDEPENDENT_DATA_PATH)
    features = build_features(independent_data)
    if training.TARGET_COLUMN in features.columns or list(features.columns) != FEATURE_COLUMNS:
        raise ValueError("The v2 model input features failed the leakage allowlist check.")

    model = joblib.load(artifact_path)
    predictions = np.asarray(model.predict(features), dtype=float)
    actual = independent_data[training.TARGET_COLUMN].astype(float)
    if len(predictions) != INDEPENDENT_RECORDS or not np.isfinite(predictions).all() or (predictions <= 0).any():
        raise RuntimeError("Independent predictions were not all finite, positive, and complete.")

    evaluated = independent_data.copy()
    metrics_report = metrics(actual, predictions)
    independent_groups = grouped_error_metrics(evaluated, predictions)
    coordinate_columns = [
        "pickup_latitude", "pickup_longitude", "destination_latitude",
        "destination_longitude", "straight_line_distance_km",
    ]
    complete_coordinates = ~evaluated[coordinate_columns].isna().any(axis=1)
    missing_coordinate_metrics = {
        "complete": metrics(actual[complete_coordinates], predictions[complete_coordinates]),
        "missing_or_incomplete": metrics(actual[~complete_coordinates], predictions[~complete_coordinates]),
    }

    try:
        api_checks = test_v2_api(str(model_service.model_version), evaluated.iloc[0])
    except httpx.HTTPError as error:
        api_checks = {
            "health": {"passed": False, "error": type(error).__name__},
            "all_passed": {"passed": False},
        }

    integrity_after = {
        "old_model_unchanged": sha256(OLD_MODEL_PATH) == protected_hashes["old_model"],
        "old_independent_dataset_unchanged": sha256(OLD_INDEPENDENT_PATH) == protected_hashes["old_independent_dataset"],
        "old_independent_report_unchanged": sha256(OLD_REPORT_PATH) == protected_hashes["old_independent_report"],
        "training_dataset_unchanged": sha256(TRAIN_PATH) == protected_hashes["training_dataset"],
        "validation_dataset_unchanged": sha256(VALIDATION_PATH) == protected_hashes["validation_dataset"],
        "new_independent_dataset_unchanged_during_evaluation": sha256(INDEPENDENT_DATA_PATH) == independent_hash_before,
    }
    report = {
        "status": "v2_final_independent_evaluation_complete",
        "evaluation_type": "new synthetic independent test using the shared v2 target process; not real-world validation",
        "data_source": "synthetic_v2_independent_test",
        "seed": INDEPENDENT_SEED,
        "records": len(independent_data),
        "dataset_path": str(INDEPENDENT_DATA_PATH),
        "training_dataset_path": str(TRAIN_PATH),
        "validation_dataset_path": str(VALIDATION_PATH),
        "target_method": "src.v2_target.expected_delivery_duration",
        "selected_model": training_report["selected_model"],
        "selected_parameters": training_report["selected_parameters"],
        "model_artifact": str(artifact_path),
        "model_version": model_service.model_version,
        "training_provenance": metadata.get("training_source"),
        "training_validation_test_overlap": False,
        "metrics": metrics_report,
        "records_missing_coordinates": int((~complete_coordinates).sum()),
        "missing_coordinate_metrics": missing_coordinate_metrics,
        "error_groups": independent_groups,
        "all_predictions_finite_and_positive": True,
        "api_checks": api_checks,
        "integrity_checks": integrity_after,
        "real_world_accuracy_validated": False,
        "note": "The independent test was generated after validation-based model selection and was not used to train or select the model.",
    }
    INDEPENDENT_REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    report = evaluate_new_independent_test()
    print(json.dumps({
        "report_path": str(INDEPENDENT_REPORT_PATH),
        "dataset_path": str(INDEPENDENT_DATA_PATH),
        "metrics": report["metrics"],
        "missing_coordinate_metrics": report["missing_coordinate_metrics"],
        "api_checks": report["api_checks"],
        "integrity_checks": report["integrity_checks"],
    }, indent=2))
    if not report["api_checks"]["all_passed"]["passed"]:
        raise SystemExit("A v2 FastAPI check failed; details are saved in the report.")


if __name__ == "__main__":
    main()

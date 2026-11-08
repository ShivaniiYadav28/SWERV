"""Evaluate the saved delivery model on newly generated independent scenarios."""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from . import training
from .model_service import DeliveryModelService
from .synthetic_dataset import straight_line_distance_km


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_PATH = WORKSPACE / "models" / "synthetic" / "gradient_boosting.joblib"
MODEL_METADATA_PATH = MODEL_PATH.with_suffix(".metadata.json")
OUTPUT_DIR = WORKSPACE / "data" / "processed" / "independent_testing"
DATASET_PATH = OUTPUT_DIR / "independent_delivery_time_test_dataset.csv"
REPORT_PATH = OUTPUT_DIR / "independent_testing_report.json"
API_BASE_URL = "http://127.0.0.1:8001"
RECORD_COUNT = 2_000
RANDOM_SEED = 20_261_107
DATA_SOURCE = "independent_synthetic_test"
RECORD_ID_COLUMN = "independent_test_id"
TIME_COLUMN = "assigned_at"
SUPPORTED_PRIORITIES = ["standard", "express", "urgent"]
SUPPORTED_CATEGORIES = ["documents", "parcel", "food", "fragile", "heavy_goods", "other"]


def random_bengaluru_point(
    randomizer: np.random.Generator,
) -> tuple[float, float]:
    """Create a random point in a Bengaluru-sized area with a new RNG stream."""
    angle = randomizer.uniform(0, math.tau)
    radius_km = 18 * math.sqrt(randomizer.random())
    latitude = 12.9716 + radius_km * math.cos(angle) / 111.1
    longitude = 77.5946 + radius_km * math.sin(angle) / (
        111.1 * math.cos(math.radians(latitude))
    )
    return round(latitude, 6), round(longitude, 6)


def package_weight(category: str, randomizer: np.random.Generator) -> float:
    """Choose a reasonable weight for the selected package category."""
    ranges = {
        "documents": (0.1, 2.5),
        "parcel": (0.2, 25),
        "food": (0.2, 9),
        "fragile": (0.2, 15),
        "heavy_goods": (5, 90),
        "other": (0.2, 18),
    }
    low, high = ranges[category]
    return round(float(randomizer.uniform(low, high)), 2)


def independent_duration(
    trip_distance_km: float,
    priority: str,
    category: str,
    weight_kg: float,
    quantity: int,
    assigned_at: datetime,
    randomizer: np.random.Generator,
) -> float:
    """Create a varied label using an independent travel and traffic formula."""
    bengaluru_hour = (assigned_at.hour + 5) % 24
    weekday = assigned_at.weekday()
    rush_hour = weekday < 5 and (7 <= bengaluru_hour < 10 or 16 <= bengaluru_hour < 20)
    congestion = randomizer.uniform(1.05, 1.35) if rush_hour else randomizer.uniform(0.95, 1.18)
    route_multiplier = randomizer.uniform(1.12, 1.48)
    average_speed_kmh = randomizer.uniform(20, 29)
    route_distance = trip_distance_km * route_multiplier
    travel_minutes = route_distance / average_speed_kmh * 60 * congestion

    priority_adjustment = {"standard": 1.0, "express": 0.94, "urgent": 0.88}[priority]
    package_adjustment = {
        "documents": 0.96, "parcel": 1.0, "food": 1.06,
        "fragile": 1.12, "heavy_goods": 1.27, "other": 1.03,
    }[category]
    handling_minutes = 6 + 0.72 * math.sqrt(weight_kg) + 1.1 * (quantity - 1)
    unexpected_delay = randomizer.gamma(shape=1.5, scale=1.8)
    random_noise = randomizer.normal(0, max(2.5, travel_minutes * 0.09))
    duration = travel_minutes * priority_adjustment * package_adjustment
    duration += handling_minutes + unexpected_delay + random_noise
    return round(max(5.0, duration), 2)


def generate_independent_dataset(
    record_count: int = RECORD_COUNT,
    random_seed: int = RANDOM_SEED,
) -> pd.DataFrame:
    """Create new delivery features and labels without reading any dataset CSV."""
    if not isinstance(record_count, int) or record_count <= 0:
        raise ValueError("record_count must be a positive integer.")
    randomizer = np.random.default_rng(random_seed)
    first_assignment = datetime(2026, 1, 1, tzinfo=timezone.utc)
    rows: list[dict[str, Any]] = []

    for index in range(record_count):
        assigned_at = first_assignment + timedelta(hours=index * 4)
        created_at = assigned_at - timedelta(minutes=int(randomizer.integers(3, 91)))
        priority = str(randomizer.choice(SUPPORTED_PRIORITIES, p=[0.65, 0.27, 0.08]))
        category = str(randomizer.choice(SUPPORTED_CATEGORIES, p=[0.12, 0.50, 0.16, 0.08, 0.08, 0.06]))
        weight = package_weight(category, randomizer)
        quantity = int(randomizer.integers(1, 6))
        pickup = random_bengaluru_point(randomizer)
        destination = random_bengaluru_point(randomizer)
        underlying_distance = straight_line_distance_km(pickup, destination)
        target_minutes = independent_duration(
            underlying_distance, priority, category, weight, quantity, assigned_at, randomizer
        )

        # Some deliveries have no geocoded coordinates in real operational data.
        include_pickup = randomizer.random() >= 0.035
        include_destination = randomizer.random() >= 0.035
        pickup_latitude, pickup_longitude = pickup if include_pickup else (np.nan, np.nan)
        destination_latitude, destination_longitude = (
            destination if include_destination else (np.nan, np.nan)
        )
        feature_distance = (
            straight_line_distance_km(pickup, destination)
            if include_pickup and include_destination
            else np.nan
        )

        rows.append({
            RECORD_ID_COLUMN: f"INDEP-{index + 1:05d}",
            "request_created_at": created_at.isoformat().replace("+00:00", "Z"),
            "assigned_at": assigned_at.isoformat().replace("+00:00", "Z"),
            "priority": priority,
            "package_category": category,
            "weight_kg": weight,
            "quantity": quantity,
            "pickup_latitude": pickup_latitude,
            "pickup_longitude": pickup_longitude,
            "destination_latitude": destination_latitude,
            "destination_longitude": destination_longitude,
            "straight_line_distance_km": feature_distance,
            training.TARGET_COLUMN: target_minutes,
            "data_source": DATA_SOURCE,
        })

    dataset = pd.DataFrame(rows)
    validate_independent_dataset(dataset)
    return dataset


def validate_independent_dataset(dataset: pd.DataFrame) -> None:
    """Check the independent test file's values and prevent feature leakage."""
    required = set(training.RAW_FEATURE_COLUMNS) | {
        training.TARGET_COLUMN, "data_source", RECORD_ID_COLUMN,
    }
    missing_columns = sorted(required - set(dataset.columns))
    if missing_columns:
        raise ValueError(f"Independent dataset is missing columns: {', '.join(missing_columns)}")
    if dataset.empty or not dataset["data_source"].eq(DATA_SOURCE).all():
        raise ValueError("Every record must be labeled as an independent synthetic test.")
    if not dataset[RECORD_ID_COLUMN].is_unique:
        raise ValueError("Independent test record IDs must be unique.")
    if dataset.duplicated(training.RAW_FEATURE_COLUMNS + [training.TARGET_COLUMN]).any():
        raise ValueError("Duplicate independent feature and target rows were found.")

    created = pd.to_datetime(dataset["request_created_at"], utc=True, errors="coerce")
    assigned = pd.to_datetime(dataset["assigned_at"], utc=True, errors="coerce")
    if created.isna().any() or assigned.isna().any() or (assigned < created).any():
        raise ValueError("Creation and assignment timestamps must be valid and correctly ordered.")

    for latitude_column, longitude_column, latitude_range, longitude_range in (
        ("pickup_latitude", "pickup_longitude", (-90, 90), (-180, 180)),
        ("destination_latitude", "destination_longitude", (-90, 90), (-180, 180)),
    ):
        latitude = pd.to_numeric(dataset[latitude_column], errors="coerce")
        longitude = pd.to_numeric(dataset[longitude_column], errors="coerce")
        invalid_latitude = dataset[latitude_column].notna() & latitude.isna()
        invalid_longitude = dataset[longitude_column].notna() & longitude.isna()
        if invalid_latitude.any() or invalid_longitude.any():
            raise ValueError(f"{latitude_column} or {longitude_column} contains a non-numeric value.")
        if latitude.isna().ne(longitude.isna()).any():
            raise ValueError(f"{latitude_column} and {longitude_column} must be missing together.")
        if ((latitude.dropna() < latitude_range[0]) | (latitude.dropna() > latitude_range[1])).any():
            raise ValueError(f"{latitude_column} is outside valid latitude bounds.")
        if ((longitude.dropna() < longitude_range[0]) | (longitude.dropna() > longitude_range[1])).any():
            raise ValueError(f"{longitude_column} is outside valid longitude bounds.")

    weight = pd.to_numeric(dataset["weight_kg"], errors="coerce")
    quantity = pd.to_numeric(dataset["quantity"], errors="coerce")
    duration = pd.to_numeric(dataset[training.TARGET_COLUMN], errors="coerce")
    if weight.isna().any() or not np.isfinite(weight).all() or (weight <= 0).any():
        raise ValueError("Weights must be finite and positive.")
    if quantity.isna().any() or (quantity <= 0).any() or (quantity % 1 != 0).any():
        raise ValueError("Quantities must be positive whole numbers.")
    if duration.isna().any() or not np.isfinite(duration).all() or (duration <= 0).any():
        raise ValueError("Target durations must be finite and positive.")
    distance = pd.to_numeric(dataset["straight_line_distance_km"], errors="coerce")
    if (distance.dropna() < 0).any() or not np.isfinite(distance.dropna()).all():
        raise ValueError("Straight-line distances must be finite and non-negative when present.")
    if not dataset["priority"].isin(SUPPORTED_PRIORITIES).all():
        raise ValueError("The dataset contains an unsupported priority.")
    if not dataset["package_category"].isin(SUPPORTED_CATEGORIES).all():
        raise ValueError("The dataset contains an unsupported package category.")


def test_api_endpoints(
    model_version: str,
    sample_row: pd.Series,
) -> dict[str, Any]:
    """Check live health, valid prediction, missing coordinates, and bad inputs."""
    checks: dict[str, dict[str, Any]] = {}
    with httpx.Client(base_url=API_BASE_URL, timeout=10) as client:
        health_response = client.get("/health")
        health_passed = False
        try:
            health_body = health_response.json()
            health_passed = (
                health_response.status_code == 200
                and health_body.get("model_available") is True
                and health_body.get("model_version") == model_version
                and "synthetic" in str(health_body.get("model_version", ""))
            )
        except ValueError:
            health_body = {}
        checks["health"] = {
            "passed": health_passed,
            "http_status": health_response.status_code,
            "model_available": health_body.get("model_available"),
            "model_version": health_body.get("model_version"),
        }

        def make_request(row: pd.Series) -> dict[str, Any]:
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

        complete_row = sample_row.copy()
        complete_row["pickup_latitude"] = 12.9716
        complete_row["pickup_longitude"] = 77.5946
        complete_row["destination_latitude"] = 13.01
        complete_row["destination_longitude"] = 77.63
        valid_response = client.post("/predict", json=make_request(complete_row))
        try:
            valid_body = valid_response.json()
            predicted_value = valid_body.get("predicted_duration_minutes")
            valid_passed = (
                valid_response.status_code == 200
                and valid_body.get("prediction_status") == "available"
                and valid_body.get("model_version") == model_version
                and isinstance(predicted_value, (int, float))
                and math.isfinite(float(predicted_value))
                and float(predicted_value) > 0
            )
        except ValueError:
            valid_body = {}
            valid_passed = False
        checks["valid_prediction"] = {
            "passed": valid_passed,
            "http_status": valid_response.status_code,
            "prediction_status": valid_body.get("prediction_status"),
            "model_version": valid_body.get("model_version"),
            "predicted_duration_minutes": valid_body.get("predicted_duration_minutes"),
        }

        missing_coordinates = make_request(sample_row)
        missing_coordinates.update({
            "pickup_latitude": None, "pickup_longitude": None,
            "destination_latitude": None, "destination_longitude": None,
        })
        missing_response = client.post("/predict", json=missing_coordinates)
        try:
            missing_body = missing_response.json()
            missing_duration = missing_body.get("predicted_duration_minutes")
            missing_passed = (
                missing_response.status_code == 200
                and missing_body.get("prediction_status") == "available"
                and isinstance(missing_duration, (int, float))
                and math.isfinite(float(missing_duration))
                and float(missing_duration) > 0
            )
        except ValueError:
            missing_passed = False
        checks["missing_coordinates"] = {
            "passed": missing_passed,
            "http_status": missing_response.status_code,
        }

        invalid_weight = make_request(complete_row)
        invalid_weight["weight_kg"] = -1
        weight_response = client.post("/predict", json=invalid_weight)
        checks["invalid_weight_rejected"] = {
            "passed": weight_response.status_code == 422,
            "http_status": weight_response.status_code,
        }

        partial_coordinates = make_request(complete_row)
        partial_coordinates["pickup_longitude"] = None
        coordinate_response = client.post("/predict", json=partial_coordinates)
        checks["partial_coordinates_rejected"] = {
            "passed": coordinate_response.status_code == 422,
            "http_status": coordinate_response.status_code,
        }

        leaked_target = make_request(complete_row)
        leaked_target["delivered_at"] = "2026-01-01T12:00:00Z"
        leakage_response = client.post("/predict", json=leaked_target)
        checks["post_assignment_field_rejected"] = {
            "passed": leakage_response.status_code == 422,
            "http_status": leakage_response.status_code,
        }

    checks["all_passed"] = {"passed": all(check["passed"] for check in checks.values())}
    return checks


def run_independent_evaluation() -> dict[str, Any]:
    """Generate test inputs, evaluate the existing artifact, and save results."""
    if not MODEL_PATH.is_file() or not MODEL_METADATA_PATH.is_file():
        raise FileNotFoundError("The existing synthetic Gradient Boosting model and metadata are required.")
    model_hash_before = hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest()
    metadata = json.loads(MODEL_METADATA_PATH.read_text(encoding="utf-8"))
    if metadata.get("training_source") != "synthetic":
        raise ValueError("The selected model metadata does not identify synthetic training provenance.")

    dataset = generate_independent_dataset()
    model_service = DeliveryModelService(MODEL_PATH)
    if not model_service.available:
        raise RuntimeError("The existing Gradient Boosting artifact could not be loaded.")
    features = training.build_features(dataset)
    if list(features.columns) != training.CATEGORICAL_COLUMNS + training.NUMERICAL_COLUMNS:
        raise RuntimeError("The independent dataset does not match the approved feature schema.")
    artifact = joblib.load(MODEL_PATH)
    predicted = np.asarray(artifact.predict(features), dtype=float)
    actual = dataset[training.TARGET_COLUMN].astype(float)
    prediction_check = bool(np.isfinite(predicted).all() and (predicted > 0).all())
    if not prediction_check or len(predicted) != RECORD_COUNT:
        raise RuntimeError("The model returned invalid or incomplete independent predictions.")

    dataset["predicted_duration_minutes"] = predicted
    dataset["absolute_error_minutes"] = np.abs(actual.to_numpy() - predicted)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    dataset.to_csv(DATASET_PATH, index=False)

    try:
        edge_case_results = test_api_endpoints(str(model_service.model_version), dataset.iloc[0])
    except httpx.HTTPError as error:
        edge_case_results = {
            "health": {"passed": False, "error": type(error).__name__},
            "all_passed": {"passed": False},
        }
    model_hash_after = hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest()
    report = {
        "status": "independent_synthetic_evaluation_complete",
        "evaluation_type": "independent synthetic test; not real-world validation",
        "data_source": DATA_SOURCE,
        "random_seed": RANDOM_SEED,
        "records_generated": len(dataset),
        "dataset_path": str(DATASET_PATH),
        "report_path": str(REPORT_PATH),
        "model_artifact": str(MODEL_PATH),
        "model_version": model_service.model_version,
        "training_provenance": metadata.get("training_source"),
        "model_modified": model_hash_before != model_hash_after,
        "model_sha256_before": model_hash_before,
        "model_sha256_after": model_hash_after,
        "approved_raw_feature_columns": training.RAW_FEATURE_COLUMNS,
        "feature_leakage_check": {
            "passed": training.TARGET_COLUMN not in features.columns
            and not ({"delivered_at", "picked_up_at", "final_status"} & set(features.columns)),
            "model_input_columns": list(features.columns),
        },
        "data_quality": {
            "invalid_rows": 0,
            "duplicate_feature_target_rows": int(
                dataset.duplicated(training.RAW_FEATURE_COLUMNS + [training.TARGET_COLUMN]).sum()
            ),
            "duplicate_record_ids": int(dataset[RECORD_ID_COLUMN].duplicated().sum()),
            "missing_feature_values": {
                column: int(pd.isna(dataset[column]).sum())
                for column in training.RAW_FEATURE_COLUMNS
            },
            "records_missing_one_or_more_coordinate_pairs": int(
                dataset[[
                    "pickup_latitude", "pickup_longitude",
                    "destination_latitude", "destination_longitude",
                ]].isna().any(axis=1).sum()
            ),
            "invalid_or_non_positive_durations": int((~np.isfinite(actual) | (actual <= 0)).sum()),
            "invalid_or_non_positive_predictions": int((~np.isfinite(predicted) | (predicted <= 0)).sum()),
        },
        "metrics": {
            "mae_minutes": float(mean_absolute_error(actual, predicted)),
            "rmse_minutes": float(np.sqrt(mean_squared_error(actual, predicted))),
            "r2": float(r2_score(actual, predicted)),
        },
        "prediction_checks": {
            "predictions_generated": len(predicted),
            "all_predictions_finite_and_positive": prediction_check,
        },
        "api_tests": edge_case_results,
        "real_world_accuracy_validated": False,
        "note": "This independent generated dataset was not part of training or the existing holdout. Results are synthetic-only and are not evidence of real-world accuracy.",
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    report = run_independent_evaluation()
    print(json.dumps(report, indent=2))
    if not report["api_tests"]["all_passed"]["passed"]:
        raise SystemExit("One or more FastAPI endpoint checks failed; see the report for details.")


if __name__ == "__main__":
    main()

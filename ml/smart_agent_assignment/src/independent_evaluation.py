"""Evaluate the saved agent-ranking model on new synthetic scenarios."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from .api import app, get_model_service
from .features import (
    FEATURE_COLUMNS,
    GROUP_COLUMN,
    TARGET_COLUMN,
    build_features,
)
from .model_service import AgentRecommendationModel
from .synthetic_dataset import (
    CANDIDATES_PER_SCENARIO,
    generate_dataset,
    validate_dataset,
)


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_PATH = WORKSPACE / "models" / "synthetic" / "gradient_boosting.joblib"
MODEL_METADATA_PATH = MODEL_PATH.with_suffix(".metadata.json")
OUTPUT_DIR = WORKSPACE / "data" / "processed" / "independent_testing"
DATASET_OUTPUT_PATH = OUTPUT_DIR / "independent_agent_candidate_dataset.csv"
METRICS_REPORT_PATH = OUTPUT_DIR / "evaluation_metrics.json"
RANKING_REPORT_PATH = OUTPUT_DIR / "ranking_evaluation_report.json"
EDGE_CASE_REPORT_PATH = OUTPUT_DIR / "edge_case_test_report.json"
INTEGRITY_REPORT_PATH = OUTPUT_DIR / "model_integrity_report.json"
SUMMARY_REPORT_PATH = OUTPUT_DIR / "independent_evaluation_report.json"
API_BASE_URL = "http://127.0.0.1:8002"
SCENARIO_COUNT = 2_000
RANDOM_SEED = 20_261_107
SCENARIO_PREFIX = "independent-20261107-"
FIRST_ASSIGNMENT = datetime(2026, 11, 7, tzinfo=timezone.utc)
SIMILAR_DURATION_THRESHOLD_MINUTES = 0.5

MODEL_CANDIDATE_FEATURE_COLUMNS = [
    "priority", "package_category", "vehicle_type", "capability_profile",
    "weight_kg", "quantity", "pickup_to_destination_km",
    "agent_to_pickup_km", "active_workload", "max_capacity", "workload_ratio",
    "gps_fresh", "completed_delivery_count", "historical_median_minutes",
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def haversine_km(first: tuple[float, float], second: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, first)
    lat2, lon2 = map(math.radians, second)
    latitude_delta = lat2 - lat1
    longitude_delta = lon2 - lon1
    haversine = math.sin(latitude_delta / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(longitude_delta / 2) ** 2
    return 6371.0088 * 2 * math.atan2(math.sqrt(haversine), math.sqrt(1 - haversine))


def coordinates_for_distance(distance_km: float) -> tuple[float, float, float, float]:
    """Create two Bengaluru-area points whose straight-line distance is known."""
    pickup_latitude, pickup_longitude = 12.9716, 77.5946
    destination_latitude = pickup_latitude + (distance_km * 0.6) / 111.1
    destination_longitude = pickup_longitude + (distance_km * 0.8) / (
        111.1 * math.cos(math.radians(pickup_latitude))
    )
    return pickup_latitude, pickup_longitude, destination_latitude, destination_longitude


def generate_independent_data() -> pd.DataFrame:
    """Generate fresh dispatches using the documented training target formula."""
    dataset = generate_dataset(
        scenario_count=SCENARIO_COUNT,
        seed=RANDOM_SEED,
        first_assignment=FIRST_ASSIGNMENT,
        scenario_prefix=SCENARIO_PREFIX,
        randomize_assignment_times=True,
    )
    dataset["data_source"] = "independent_synthetic_test"
    dataset["dataset_split"] = "independent_test"
    dataset["agent_id"] = dataset.apply(
        lambda row: f"{row[GROUP_COLUMN]}-agent-{int(row['candidate_index']) + 1:02d}", axis=1
    )
    validate_dataset(dataset.assign(data_source="synthetic"))
    if len(dataset) != SCENARIO_COUNT * CANDIDATES_PER_SCENARIO:
        raise ValueError("Generated candidate row count does not match expected scenarios.")
    if dataset[GROUP_COLUMN].nunique() != SCENARIO_COUNT:
        raise ValueError("Generated dispatch scenario IDs are not unique.")
    if dataset.duplicated([GROUP_COLUMN, "candidate_index"]).any():
        raise ValueError("Duplicate candidate combinations were generated.")
    if dataset["agent_id"].duplicated().any():
        raise ValueError("Independent agent profile IDs must be unique.")
    return dataset


def regression_report(dataset: pd.DataFrame, predictions: np.ndarray) -> dict[str, Any]:
    actual = dataset[TARGET_COLUMN].astype(float)
    error = predictions - actual.to_numpy()
    return {
        "metrics": {
            "mae_minutes": float(mean_absolute_error(actual, predictions)),
            "rmse_minutes": float(np.sqrt(mean_squared_error(actual, predictions))),
            "r2": float(r2_score(actual, predictions)),
        },
        "predictions": {
            "count": int(len(predictions)),
            "finite_and_positive": bool(np.isfinite(predictions).all() and (predictions > 0).all()),
            "minimum_minutes": float(np.min(predictions)),
            "maximum_minutes": float(np.max(predictions)),
        },
        "error_by_conditions": {
            column: group_error_report(dataset, predictions, column)
            for column in (
                "priority", "package_category", "vehicle_type", "gps_fresh",
            )
        },
        "signed_error_mean_minutes": float(np.mean(error)),
    }


def group_error_report(
    dataset: pd.DataFrame,
    predictions: np.ndarray,
    group_column: str,
) -> dict[str, dict[str, float | int]]:
    rows = dataset[[group_column, TARGET_COLUMN]].copy()
    rows["prediction"] = predictions
    result: dict[str, dict[str, float | int]] = {}
    for name, group in rows.groupby(group_column, dropna=False, sort=True):
        error = group["prediction"] - group[TARGET_COLUMN]
        result[str(name)] = {
            "candidate_rows": int(len(group)),
            "mae_minutes": float(error.abs().mean()),
            "rmse_minutes": float(np.sqrt(np.square(error).mean())),
        }
    return result


def ndcg_for_scenario(actual: np.ndarray, predicted_order: np.ndarray, cutoff: int) -> float:
    """NDCG with reciprocal actual-rank gain; lower true duration is better."""
    actual_order = pd.Series(actual).rank(method="average", ascending=True).to_numpy()
    relevance = 1.0 / actual_order
    ordered_relevance = relevance[predicted_order]
    ideal_relevance = np.sort(relevance)[::-1]

    def discounted_gain(values: np.ndarray) -> float:
        selected = values[:cutoff]
        positions = np.arange(2, len(selected) + 2)
        return float(np.sum(selected / np.log2(positions)))

    ideal = discounted_gain(ideal_relevance)
    return discounted_gain(ordered_relevance) / ideal if ideal > 0 else 0.0


def ranking_report(dataset: pd.DataFrame, predictions: np.ndarray) -> dict[str, Any]:
    ranked = dataset[[GROUP_COLUMN, "agent_id", TARGET_COLUMN]].copy()
    ranked["predicted_duration_minutes"] = predictions
    ranked["predicted_rank"] = ranked.groupby(GROUP_COLUMN)[
        "predicted_duration_minutes"
    ].rank(method="first", ascending=True).astype(int)
    scenario_results: list[dict[str, Any]] = []
    tie_scenarios = 0
    for scenario_id, group in ranked.groupby(GROUP_COLUMN, sort=True):
        actual_best = group.sort_values(
            [TARGET_COLUMN, "agent_id"], kind="stable"
        ).iloc[0]
        prediction_order = group.sort_values(
            ["predicted_duration_minutes", "agent_id"], kind="stable"
        )
        predicted_best = prediction_order.iloc[0]
        predicted_differences = prediction_order["predicted_duration_minutes"].diff().dropna()
        if (predicted_differences <= SIMILAR_DURATION_THRESHOLD_MINUTES).any():
            tie_scenarios += 1
        actual = group[TARGET_COLUMN].to_numpy(dtype=float)
        row_indices = group.index.to_numpy()
        ordered_indices = prediction_order.index.to_numpy()
        position_by_row = {row_index: position for position, row_index in enumerate(row_indices)}
        predicted_order = np.array([position_by_row[row_index] for row_index in ordered_indices])
        scenario_results.append({
            "dispatch_scenario_id": scenario_id,
            "top_candidate_correct": bool(predicted_best["agent_id"] == actual_best["agent_id"]),
            "top_candidate_actual_duration_minutes": float(actual_best[TARGET_COLUMN]),
            "top_candidate_predicted_duration_minutes": float(predicted_best["predicted_duration_minutes"]),
            "ndcg_at_1": ndcg_for_scenario(actual, predicted_order, 1),
            "ndcg_at_3": ndcg_for_scenario(actual, predicted_order, 3),
            "ranking_is_ascending": bool(
                prediction_order["predicted_duration_minutes"].is_monotonic_increasing
            ),
        })

    return {
        "scenario_count": len(scenario_results),
        "candidates_per_scenario": CANDIDATES_PER_SCENARIO,
        "top_candidate_accuracy": float(np.mean([
            scenario["top_candidate_correct"] for scenario in scenario_results
        ])),
        "ndcg_at_1": float(np.mean([scenario["ndcg_at_1"] for scenario in scenario_results])),
        "ndcg_at_3": float(np.mean([scenario["ndcg_at_3"] for scenario in scenario_results])),
        "all_scenarios_ranked_lowest_duration_first": all(
            scenario["ranking_is_ascending"] for scenario in scenario_results
        ),
        "scenarios_with_candidates_within_0_5_minutes": tie_scenarios,
        "similar_prediction_threshold_minutes": SIMILAR_DURATION_THRESHOLD_MINUTES,
        "ndcg_gain_definition": "Gain is reciprocal rank of actual duration within each dispatch; lower actual duration gets a higher gain.",
        "scenario_results": scenario_results,
    }


def make_api_request(
    scenario: pd.DataFrame,
    missing_dispatch_coordinates: bool = False,
    tie_candidates: bool = False,
) -> dict[str, Any]:
    first = scenario.iloc[0]
    if missing_dispatch_coordinates:
        pickup_latitude = pickup_longitude = destination_latitude = destination_longitude = None
    else:
        pickup_latitude, pickup_longitude, destination_latitude, destination_longitude = coordinates_for_distance(
            float(first["pickup_to_destination_km"])
        )
    candidates = []
    selected = scenario.head(2) if tie_candidates else scenario
    for index, (_, row) in enumerate(selected.iterrows()):
        if tie_candidates and index > 0:
            row = selected.iloc[0]
        capabilities = str(row["capability_profile"]).split("|")
        candidates.append({
            "agent_id": str(row["agent_id"]),
            "agent_code": f"SYN-{index + 1:03d}",
            "is_active": True,
            "agent_status": "available",
            "vehicle_type": row["vehicle_type"],
            "capabilities": capabilities,
            "active_workload": int(row["active_workload"]),
            "max_capacity": int(row["max_capacity"]),
            "gps_fresh": bool(row["gps_fresh"]),
            "agent_to_pickup_km": (
                None if pd.isna(row["agent_to_pickup_km"])
                else float(row["agent_to_pickup_km"])
            ),
            "completed_delivery_count": int(row["completed_delivery_count"]),
            "historical_median_minutes": (
                None if pd.isna(row["historical_median_minutes"])
                else float(row["historical_median_minutes"])
            ),
        })
    if tie_candidates:
        candidates[1]["agent_id"] = f"{candidates[1]['agent_id']}-tie"
        candidates[1]["agent_code"] = "SYN-TIE"
    return {
        "dispatch_request_id": str(first[GROUP_COLUMN]),
        "dispatch": {
            "recommendation_time": str(first["recommendation_time"]),
            "priority": first["priority"],
            "package_category": first["package_category"],
            "weight_kg": float(first["weight_kg"]),
            "quantity": int(first["quantity"]),
            "pickup_latitude": pickup_latitude,
            "pickup_longitude": pickup_longitude,
            "destination_latitude": destination_latitude,
            "destination_longitude": destination_longitude,
        },
        "candidates": candidates,
    }


async def post_to_local_api(body: dict[str, Any]) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post("/predict", json=body)


def run_api_edge_tests(dataset: pd.DataFrame, expected_model_version: str) -> dict[str, Any]:
    checks: dict[str, Any] = {}
    with httpx.Client(base_url=API_BASE_URL, timeout=15) as client:
        health_response = client.get("/health")
        health = health_response.json()
        checks["health"] = {
            "passed": health_response.status_code == 200
            and health.get("model_available") is True
            and health.get("model_version") == expected_model_version
            and health.get("training_source") == "synthetic",
            "http_status": health_response.status_code,
            "model_version": health.get("model_version"),
            "training_source": health.get("training_source"),
        }

        scenario = dataset.loc[dataset["priority"] == "standard"].groupby(
            GROUP_COLUMN, sort=True
        ).head(CANDIDATES_PER_SCENARIO).groupby(GROUP_COLUMN, sort=True).head(CANDIDATES_PER_SCENARIO)
        scenario_id = scenario[GROUP_COLUMN].iloc[0]
        scenario = dataset[dataset[GROUP_COLUMN] == scenario_id]
        valid_response = client.post("/predict", json=make_api_request(scenario))
        valid_body = valid_response.json()
        valid_predictions = valid_body.get("predictions", [])
        checks["multiple_candidate_prediction"] = {
            "passed": valid_response.status_code == 200
            and len(valid_predictions) == CANDIDATES_PER_SCENARIO
            and valid_body.get("prediction_status") == "available"
            and valid_body.get("model_version") == expected_model_version
            and valid_body.get("training_source") == "synthetic"
            and all(
                isinstance(item.get("predicted_duration_minutes"), (float, int))
                and math.isfinite(item["predicted_duration_minutes"])
                and item["predicted_duration_minutes"] > 0
                for item in valid_predictions
            )
            and [item["rank"] for item in valid_predictions] == list(range(1, len(valid_predictions) + 1)),
            "http_status": valid_response.status_code,
            "candidate_predictions": len(valid_predictions),
            "model_version": valid_body.get("model_version"),
        }

        missing_gps = scenario.copy()
        missing_gps["gps_fresh"] = 0
        missing_gps["agent_to_pickup_km"] = np.nan
        missing_gps["completed_delivery_count"] = 0
        missing_gps["historical_median_minutes"] = np.nan
        missing_response = client.post("/predict", json=make_api_request(
            missing_gps, missing_dispatch_coordinates=True
        ))
        missing_body = missing_response.json()
        checks["missing_optional_information"] = {
            "passed": missing_response.status_code == 200
            and len(missing_body.get("predictions", [])) == CANDIDATES_PER_SCENARIO,
            "http_status": missing_response.status_code,
            "gps_missing": True,
            "historical_performance_missing": True,
            "dispatch_coordinates_missing": True,
        }

        tie_response = client.post("/predict", json=make_api_request(scenario, tie_candidates=True))
        tie_body = tie_response.json()
        tie_items = tie_body.get("predictions", [])
        checks["similar_prediction_tie"] = {
            "passed": tie_response.status_code == 200
            and len(tie_items) == 2
            and tie_items[0]["predicted_duration_minutes"] == tie_items[1]["predicted_duration_minutes"]
            and [item["rank"] for item in tie_items] == [1, 2],
            "http_status": tie_response.status_code,
            "predictions": [item.get("predicted_duration_minutes") for item in tie_items],
        }

        invalid_body = make_api_request(scenario.head(1))
        invalid_body["dispatch"]["weight_kg"] = -1
        weight_response = client.post("/predict", json=invalid_body)
        checks["invalid_weight_rejected"] = {
            "passed": weight_response.status_code == 422,
            "http_status": weight_response.status_code,
        }

        ineligible_body = make_api_request(scenario.head(1))
        ineligible_body["candidates"][0]["active_workload"] = ineligible_body["candidates"][0]["max_capacity"]
        ineligible_response = client.post("/predict", json=ineligible_body)
        checks["ineligible_candidate_rejected_before_scoring"] = {
            "passed": ineligible_response.status_code == 422,
            "http_status": ineligible_response.status_code,
        }

        capability_body = make_api_request(scenario.head(1))
        required_capability = {
            "documents": "document_delivery",
            "parcel": "parcel_delivery",
            "food": "food_delivery",
            "fragile": "parcel_delivery",
            "heavy_goods": "heavy_goods",
            "other": "parcel_delivery",
        }[scenario["package_category"].iloc[0]]
        invalid_capability = "heavy_goods" if required_capability != "heavy_goods" else "food_delivery"
        capability_body["candidates"][0]["capabilities"] = [invalid_capability]
        capability_response = client.post("/predict", json=capability_body)
        checks["incompatible_capability_rejected"] = {
            "passed": capability_response.status_code == 422,
            "http_status": capability_response.status_code,
        }

        duplicate_body = make_api_request(scenario.head(2))
        duplicate_body["candidates"][1]["agent_id"] = duplicate_body["candidates"][0]["agent_id"]
        duplicate_response = client.post("/predict", json=duplicate_body)
        checks["duplicate_agent_rejected"] = {
            "passed": duplicate_response.status_code == 422,
            "http_status": duplicate_response.status_code,
        }

    with tempfile.TemporaryDirectory() as temporary_directory:
        missing_model_service = AgentRecommendationModel(Path(temporary_directory) / "missing.joblib")
        app.dependency_overrides[get_model_service] = lambda: missing_model_service
        try:
            unavailable_response = asyncio.run(post_to_local_api(make_api_request(scenario.head(1))))
        finally:
            app.dependency_overrides.clear()
    checks["model_unavailable"] = {
        "passed": unavailable_response.status_code == 503,
        "http_status": unavailable_response.status_code,
        "message": unavailable_response.json().get("detail"),
    }
    checks["all_passed"] = all(check["passed"] for check in checks.values())
    return checks


def evaluate_independent_dataset() -> dict[str, Any]:
    if not MODEL_PATH.is_file() or not MODEL_METADATA_PATH.is_file():
        raise FileNotFoundError("The existing Feature 2 model artifact or metadata is missing.")
    model_hash_before = sha256(MODEL_PATH)
    metadata = json.loads(MODEL_METADATA_PATH.read_text(encoding="utf-8"))
    if metadata.get("training_source") != "synthetic":
        raise ValueError("The existing model is not labeled as synthetic-trained.")
    if metadata.get("artifact_sha256") != model_hash_before:
        raise ValueError("The model hash does not match its provenance metadata.")
    service = AgentRecommendationModel(MODEL_PATH)
    if not service.available or service.model_version != "gradient_boosting-synthetic-c22e749e234e":
        raise RuntimeError("The expected saved Gradient Boosting model could not be loaded.")

    dataset = generate_independent_data()
    features = build_features(dataset)
    if TARGET_COLUMN in features.columns or list(features.columns) != FEATURE_COLUMNS:
        raise ValueError("Candidate model features failed the approved feature allowlist check.")
    predictions = service.predict(features)
    if predictions is None or len(predictions) != len(dataset):
        raise RuntimeError("The existing model did not return predictions for all candidate rows.")
    predicted_array = np.asarray(predictions, dtype=float)
    if not np.isfinite(predicted_array).all() or (predicted_array <= 0).any():
        raise RuntimeError("One or more candidate predictions were invalid.")

    dataset["data_source"] = "independent_synthetic_test"
    dataset["dataset_split"] = "independent_test"
    dataset["agent_id"] = dataset.apply(
        lambda row: f"{row[GROUP_COLUMN]}-agent-{int(row['candidate_index']) + 1:02d}", axis=1
    )
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    dataset.to_csv(DATASET_OUTPUT_PATH, index=False)

    regression = regression_report(dataset, predicted_array)
    ranking = ranking_report(dataset, predicted_array)
    edges = run_api_edge_tests(dataset, str(service.model_version))
    model_hash_after = sha256(MODEL_PATH)
    integrity = {
        "model_artifact": str(MODEL_PATH),
        "expected_model_version": metadata.get("model_version"),
        "loaded_model_version": service.model_version,
        "model_sha256_before": model_hash_before,
        "model_sha256_after": model_hash_after,
        "model_unchanged": model_hash_before == model_hash_after,
        "training_source": metadata.get("training_source"),
        "model_retrained": False,
    }
    metrics_report = {
        "evaluation_type": "independent synthetic-data evaluation; not real-world validation",
        "scenario_count": SCENARIO_COUNT,
        "candidate_row_count": len(dataset),
        "seed": RANDOM_SEED,
        "target_method": "Existing src.synthetic_dataset.delivery_duration function, with a new RNG seed and independently generated scenarios.",
        **regression,
        "model_version": service.model_version,
        "dataset_path": str(DATASET_OUTPUT_PATH),
    }
    ranking.update({
        "evaluation_type": "independent synthetic ranking evaluation",
        "scenario_count": SCENARIO_COUNT,
        "candidate_row_count": len(dataset),
        "dataset_path": str(DATASET_OUTPUT_PATH),
        "ranking_metrics_are_separate_from_regression_metrics": True,
    })
    edge_report = {
        "fastapi_base_url": API_BASE_URL,
        "api_tests": edges,
        "ineligible_agent_behavior": (
            "The Python API rejects ineligible candidate input before model scoring. The Admin/Operator backend performs eligibility filtering before sending candidates; verified separately by backend agent recommendation tests."
        ),
    }
    summary = {
        "status": "independent_feature_2_evaluation_complete",
        "evaluation_type": "synthetic-only independent test; no real-world accuracy claim",
        "scenario_count": SCENARIO_COUNT,
        "candidate_row_count": len(dataset),
        "candidates_per_scenario": CANDIDATES_PER_SCENARIO,
        "random_seed": RANDOM_SEED,
        "scenario_prefix": SCENARIO_PREFIX,
        "training_dataset_read": False,
        "holdout_dataset_read": False,
        "model_integrity": integrity,
        "metrics_report": str(METRICS_REPORT_PATH),
        "ranking_report": str(RANKING_REPORT_PATH),
        "edge_case_report": str(EDGE_CASE_REPORT_PATH),
        "integrity_report": str(INTEGRITY_REPORT_PATH),
        "dataset_path": str(DATASET_OUTPUT_PATH),
        "api_edge_tests_passed": edges["all_passed"],
        "real_world_accuracy_validated": False,
    }
    METRICS_REPORT_PATH.write_text(json.dumps(metrics_report, indent=2) + "\n", encoding="utf-8")
    RANKING_REPORT_PATH.write_text(json.dumps(ranking, indent=2) + "\n", encoding="utf-8")
    EDGE_CASE_REPORT_PATH.write_text(json.dumps(edge_report, indent=2) + "\n", encoding="utf-8")
    INTEGRITY_REPORT_PATH.write_text(json.dumps(integrity, indent=2) + "\n", encoding="utf-8")
    SUMMARY_REPORT_PATH.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return {
        "summary": summary,
        "metrics": metrics_report["metrics"],
        "ranking": {key: ranking[key] for key in (
            "top_candidate_accuracy", "ndcg_at_1", "ndcg_at_3",
            "all_scenarios_ranked_lowest_duration_first",
            "scenarios_with_candidates_within_0_5_minutes",
        )},
        "edge_cases": edges,
        "integrity": integrity,
    }


def main() -> None:
    result = evaluate_independent_dataset()
    print(json.dumps(result, indent=2))
    if not result["edge_cases"]["all_passed"]:
        raise SystemExit("One or more independent API checks failed; reports include details.")


if __name__ == "__main__":
    main()

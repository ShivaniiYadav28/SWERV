"""Evaluate saved synthetic forecasts recursively against a seasonal baseline."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.base import RegressorMixin
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from .features import FEATURE_COLUMNS, HOURS_PER_WEEK, TARGET_COLUMN, build_time_features, split_chronologically
from .forecasting import forecast_request_counts
from .model_service import MODEL_PATH, WORKSPACE, load_saved_model, sha256_file
from .training import FINAL_TEST_REPORT_PATH, DATASET_PATH


FORECAST_HORIZONS = (24, 72, 168)
ORIGIN_STEP_HOURS = 24
EVALUATION_REPORT_PATH = WORKSPACE / "data" / "processed" / "recursive_forecast_evaluation.json"


def _metrics(actual: list[int], predicted: list[int]) -> dict[str, float | None]:
    if not actual or len(actual) != len(predicted):
        raise ValueError("Actual and predicted values must have the same non-empty length.")
    r_squared = float(r2_score(actual, predicted)) if len(set(actual)) > 1 else None
    return {
        "mae": float(mean_absolute_error(actual, predicted)),
        "rmse": float(np.sqrt(mean_squared_error(actual, predicted))),
        "r2": r_squared,
    }


def evaluate_recursive_horizons(
    dataset: pd.DataFrame,
    model: RegressorMixin,
    feature_columns: list[str] = FEATURE_COLUMNS,
    horizons: tuple[int, ...] = FORECAST_HORIZONS,
    origin_step_hours: int = ORIGIN_STEP_HOURS,
    model_version: str | None = None,
) -> dict[str, Any]:
    """Score daily rolling origins using only history available at each origin."""
    if "data_source" not in dataset or not dataset["data_source"].eq("synthetic").all():
        raise ValueError("Recursive evaluation accepts synthetic rows only.")
    if (
        not horizons
        or any(not isinstance(value, int) or value < 1 or value > HOURS_PER_WEEK for value in horizons)
        or not isinstance(origin_step_hours, int)
        or origin_step_hours < 1
    ):
        raise ValueError("Evaluation horizons and origin step must be valid hourly intervals.")

    featured_rows = build_time_features(dataset)
    training_rows, validation_rows, test_rows = split_chronologically(featured_rows)
    timestamps = pd.to_datetime(dataset["timestamp"], utc=True, errors="coerce")
    counts = pd.to_numeric(dataset[TARGET_COLUMN], errors="coerce").astype("int64").tolist()
    timestamp_to_index = {timestamp: index for index, timestamp in enumerate(timestamps)}
    test_start_index = timestamp_to_index[test_rows["timestamp"].iloc[0]]
    test_end_timestamp = test_rows["timestamp"].iloc[-1]

    results: dict[str, Any] = {}
    for horizon in horizons:
        actual_values: list[int] = []
        model_values: list[int] = []
        seasonal_naive_values: list[int] = []
        origin_count = 0

        latest_origin_index = timestamp_to_index[test_end_timestamp] - horizon + 1
        for origin_index in range(test_start_index, latest_origin_index + 1, origin_step_hours):
            history = counts[origin_index - HOURS_PER_WEEK:origin_index]
            if len(history) != HOURS_PER_WEEK:
                raise ValueError("A rolling forecast origin is missing its preceding synthetic history.")

            forecast_start = pd.Timestamp(timestamps.iloc[origin_index]).to_pydatetime()
            predictions = forecast_request_counts(
                model,
                forecast_start,
                history,
                horizon,
                feature_columns,
            )
            target_values = counts[origin_index:origin_index + horizon]
            baseline_values = history[:horizon]
            if len(target_values) != horizon or len(baseline_values) != horizon:
                raise ValueError("A forecast window extends beyond the chronological test period.")

            actual_values.extend(target_values)
            model_values.extend(int(item["request_count"]) for item in predictions)
            seasonal_naive_values.extend(baseline_values)
            origin_count += 1

        if origin_count == 0:
            raise ValueError(f"The chronological test period is too short for a {horizon}-hour forecast.")

        results[str(horizon)] = {
            "forecast_horizon_hours": horizon,
            "rolling_origin_count": origin_count,
            "origin_step_hours": origin_step_hours,
            "scored_predictions": len(actual_values),
            "zero_demand_targets": sum(value == 0 for value in actual_values),
            "gradient_boosting": _metrics(actual_values, model_values),
            "seasonal_naive_previous_week": _metrics(actual_values, seasonal_naive_values),
        }

    return {
        "evaluation_type": "recursive rolling-origin multi-horizon evaluation",
        "training_source": "synthetic",
        "synthetic_only": True,
        "real_world_accuracy_validated": False,
        "feature_columns": feature_columns,
        "forecast_origin_policy": (
            "Origins are spaced by 24 hours within the chronological final test period. "
            "Each origin uses only the preceding 168 observed synthetic counts; model predictions "
            "are fed recursively within that origin. The seasonal-naive value for each lead is "
            "the count from the same UTC hour one week earlier, which is known at the origin."
        ),
        "chronological_split": {
            "training_start_utc": training_rows["timestamp"].iloc[0].isoformat(),
            "training_end_utc": training_rows["timestamp"].iloc[-1].isoformat(),
            "validation_start_utc": validation_rows["timestamp"].iloc[0].isoformat(),
            "validation_end_utc": validation_rows["timestamp"].iloc[-1].isoformat(),
            "final_test_start_utc": test_rows["timestamp"].iloc[0].isoformat(),
            "final_test_end_utc": test_rows["timestamp"].iloc[-1].isoformat(),
        },
        "dataset": {"rows": len(dataset)},
        "model": {
            "version": model_version,
            "retrained_for_evaluation": False,
        },
        "recursive_metrics_by_horizon": results,
    }


def run_recursive_evaluation() -> dict[str, Any]:
    """Evaluate the verified artifact and save a separate report without retraining."""
    if not DATASET_PATH.is_file() or not FINAL_TEST_REPORT_PATH.is_file():
        raise FileNotFoundError("The synthetic dataset or existing one-step test report is missing.")

    dataset = pd.read_csv(DATASET_PATH)
    model, feature_columns, model_version = load_saved_model()
    report = evaluate_recursive_horizons(dataset, model, feature_columns, model_version=model_version)
    existing_test_report = json.loads(FINAL_TEST_REPORT_PATH.read_text(encoding="utf-8"))
    if existing_test_report.get("training_source") != "synthetic":
        raise ValueError("The existing one-step report is not labeled as synthetic.")
    report["dataset"].update({
        "path": str(DATASET_PATH),
        "sha256": hashlib.sha256(DATASET_PATH.read_bytes()).hexdigest(),
    })
    report["model"].update({
        "path": str(MODEL_PATH),
        "artifact_sha256": sha256_file(MODEL_PATH),
    })
    report["existing_one_step_test"] = {
        "report_path": str(FINAL_TEST_REPORT_PATH),
        "evaluation_scope": "existing rolling one-step test metrics using observed historical lags",
        "final_test_start_utc": existing_test_report["final_test_start_utc"],
        "final_test_end_utc": existing_test_report["final_test_end_utc"],
        "metrics": existing_test_report["final_test_metrics"],
        "not_comparable_as_recursive_multi_hour_accuracy": True,
    }
    EVALUATION_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVALUATION_REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    print(json.dumps(run_recursive_evaluation(), indent=2))


if __name__ == "__main__":
    main()

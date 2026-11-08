"""Train and evaluate hourly demand models on synthetic data."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.base import RegressorMixin

from .features import FEATURE_COLUMNS, TARGET_COLUMN, build_time_features, split_chronologically
from .model_service import predict_request_counts, sha256_file


WORKSPACE = Path(__file__).resolve().parents[1]
DATASET_PATH = WORKSPACE / "data" / "synthetic_hourly_demand.csv"
MODEL_DIR = WORKSPACE / "models" / "synthetic"
MODEL_PATH = MODEL_DIR / "best_demand_model.joblib"
METADATA_PATH = MODEL_PATH.with_suffix(".metadata.json")
FEATURE_COLUMNS_PATH = MODEL_DIR / "feature_columns.json"
TRAINING_REPORT_PATH = WORKSPACE / "data" / "processed" / "training_validation_report.json"
FINAL_TEST_REPORT_PATH = WORKSPACE / "data" / "processed" / "final_test_report.json"


def create_models() -> dict[str, RegressorMixin]:
    """Create small, reproducible baseline and tree-based regressors."""
    return {
        "linear_regression": LinearRegression(),
        "random_forest": RandomForestRegressor(
            n_estimators=100,
            min_samples_leaf=2,
            random_state=303,
            n_jobs=-1,
        ),
        "gradient_boosting": GradientBoostingRegressor(
            n_estimators=100,
            learning_rate=0.05,
            max_depth=2,
            loss="huber",
            random_state=303,
        ),
    }


def calculate_metrics(actual: pd.Series, predicted: np.ndarray) -> dict[str, float]:
    """Calculate standard regression metrics for demand counts."""
    return {
        "mae": float(mean_absolute_error(actual, predicted)),
        "rmse": float(np.sqrt(mean_squared_error(actual, predicted))),
        "r2": float(r2_score(actual, predicted)),
    }


def fit_and_score(
    model: RegressorMixin,
    training_rows: pd.DataFrame,
    evaluation_rows: pd.DataFrame,
) -> dict[str, dict[str, float]]:
    """Fit on the earlier period and score on the requested later period."""
    model.fit(training_rows[FEATURE_COLUMNS], training_rows[TARGET_COLUMN])
    training_predictions = predict_request_counts(model, training_rows)
    validation_predictions = predict_request_counts(model, evaluation_rows)
    return {
        "training": calculate_metrics(training_rows[TARGET_COLUMN], training_predictions),
        "validation": calculate_metrics(evaluation_rows[TARGET_COLUMN], validation_predictions),
    }


def write_json(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def train_and_evaluate() -> dict[str, Any]:
    """Select by validation MAE, then evaluate the chosen model once on test."""
    if not DATASET_PATH.is_file():
        raise FileNotFoundError(f"Synthetic demand dataset not found: {DATASET_PATH}")
    source = pd.read_csv(DATASET_PATH)
    if "data_source" not in source or not source["data_source"].eq("synthetic").all():
        raise ValueError("Training is limited to rows labeled synthetic.")

    featured_rows = build_time_features(source)
    training_rows, validation_rows, final_test_rows = split_chronologically(featured_rows)
    models = create_models()
    validation_results: dict[str, dict[str, dict[str, float]]] = {}
    for name, model in models.items():
        validation_results[name] = fit_and_score(model, training_rows, validation_rows)

    selected_model_name = min(
        validation_results,
        key=lambda name: validation_results[name]["validation"]["mae"],
    )
    selected_model = models[selected_model_name]
    training_and_validation_rows = pd.concat(
        [training_rows, validation_rows],
        ignore_index=True,
    )
    selected_model.fit(
        training_and_validation_rows[FEATURE_COLUMNS],
        training_and_validation_rows[TARGET_COLUMN],
    )
    final_test_predictions = predict_request_counts(selected_model, final_test_rows)
    final_test_metrics = calculate_metrics(final_test_rows[TARGET_COLUMN], final_test_predictions)

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(selected_model, MODEL_PATH)
    artifact_hash = sha256_file(MODEL_PATH)
    model_version = f"{selected_model_name}-synthetic-{artifact_hash[:12]}"
    FEATURE_COLUMNS_PATH.write_text(json.dumps(FEATURE_COLUMNS, indent=2) + "\n", encoding="utf-8")

    source_hash = hashlib.sha256(DATASET_PATH.read_bytes()).hexdigest()
    common_provenance = {
        "training_source": "synthetic",
        "synthetic_only": True,
        "real_world_accuracy_validated": False,
        "source_dataset": str(DATASET_PATH),
        "source_dataset_sha256": source_hash,
        "source_row_count": len(source),
        "featured_row_count": len(featured_rows),
        "forecast_granularity": "hourly UTC request counts",
        "model_version": model_version,
        "selected_model": selected_model_name,
        "selection_metric": "validation MAE",
        "feature_columns": FEATURE_COLUMNS,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    training_report = {
        **common_provenance,
        "split": {
            "training_rows": len(training_rows),
            "validation_rows": len(validation_rows),
            "final_test_rows": len(final_test_rows),
            "training_start_utc": training_rows["timestamp"].iloc[0].isoformat(),
            "training_end_utc": training_rows["timestamp"].iloc[-1].isoformat(),
            "validation_start_utc": validation_rows["timestamp"].iloc[0].isoformat(),
            "validation_end_utc": validation_rows["timestamp"].iloc[-1].isoformat(),
            "final_test_start_utc": final_test_rows["timestamp"].iloc[0].isoformat(),
            "final_test_end_utc": final_test_rows["timestamp"].iloc[-1].isoformat(),
        },
        "model_metrics": validation_results,
        "model_artifact": str(MODEL_PATH),
        "feature_columns_file": str(FEATURE_COLUMNS_PATH),
    }
    final_test_report = {
        **common_provenance,
        "final_test_rows": len(final_test_rows),
        "final_model_training_rows": len(training_and_validation_rows),
        "final_test_start_utc": final_test_rows["timestamp"].iloc[0].isoformat(),
        "final_test_end_utc": final_test_rows["timestamp"].iloc[-1].isoformat(),
        "final_test_metrics": final_test_metrics,
        "test_used_for_model_selection": False,
        "model_artifact": str(MODEL_PATH),
    }
    metadata = {
        **common_provenance,
        "artifact_sha256": artifact_hash,
        "feature_columns_file": str(FEATURE_COLUMNS_PATH),
    }
    write_json(TRAINING_REPORT_PATH, training_report)
    write_json(FINAL_TEST_REPORT_PATH, final_test_report)
    write_json(METADATA_PATH, metadata)
    return {
        "selected_model": selected_model_name,
        "model_version": model_version,
        "validation_metrics": {
            name: results["validation"] for name, results in validation_results.items()
        },
        "final_test_metrics": final_test_metrics,
        "training_report": str(TRAINING_REPORT_PATH),
        "final_test_report": str(FINAL_TEST_REPORT_PATH),
        "model_artifact": str(MODEL_PATH),
        "source_dataset_sha256": source_hash,
    }


def main() -> None:
    print(json.dumps(train_and_evaluate(), indent=2))


if __name__ == "__main__":
    main()

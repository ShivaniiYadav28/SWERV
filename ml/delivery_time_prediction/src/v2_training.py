"""Tune regressors on v2 training/validation data and save a separate artifact."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

from . import training
from .v2_dataset import (
    DATA_SOURCE,
    GENERATION_REPORT_PATH,
    TRAIN_PATH,
    VALIDATION_PATH,
    V2_DATA_DIR,
    validate_dataset,
)
from .v2_features import CATEGORICAL_COLUMNS, FEATURE_COLUMNS, FEATURE_VERSION, NUMERICAL_COLUMNS, build_features


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_DIR = WORKSPACE / "models" / "v2"
REPORT_PATH = V2_DATA_DIR / "training_report.json"


def create_preprocessor() -> ColumnTransformer:
    numeric = Pipeline([("imputer", SimpleImputer(strategy="median"))])
    categorical = Pipeline([
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("one_hot", OneHotEncoder(handle_unknown="ignore")),
    ])
    return ColumnTransformer([
        ("numeric", numeric, NUMERICAL_COLUMNS),
        ("categorical", categorical, CATEGORICAL_COLUMNS),
    ])


def create_pipeline(regressor: Any) -> Pipeline:
    return Pipeline([
        ("preprocessor", create_preprocessor()),
        ("regressor", regressor),
    ])


def model_configurations() -> dict[str, list[dict[str, Any]]]:
    return {
        "linear_regression": [{}],
        "random_forest": [
            {"n_estimators": 160, "min_samples_leaf": 2, "max_features": 1.0},
            {"n_estimators": 200, "min_samples_leaf": 4, "max_features": 0.9},
        ],
        "gradient_boosting": [
            {"n_estimators": 120, "learning_rate": 0.05, "max_depth": 2, "min_samples_leaf": 5},
            {"n_estimators": 180, "learning_rate": 0.04, "max_depth": 3, "min_samples_leaf": 5},
        ],
    }


def make_regressor(model_name: str, parameters: dict[str, Any]) -> Any:
    if model_name == "linear_regression":
        return LinearRegression()
    if model_name == "random_forest":
        return RandomForestRegressor(random_state=42, n_jobs=-1, **parameters)
    if model_name == "gradient_boosting":
        return GradientBoostingRegressor(random_state=42, **parameters)
    raise ValueError(f"Unknown model family: {model_name}")


def regression_metrics(actual: pd.Series, predicted: np.ndarray) -> dict[str, float]:
    return {
        "mae_minutes": float(mean_absolute_error(actual, predicted)),
        "rmse_minutes": float(np.sqrt(mean_squared_error(actual, predicted))),
        "r2": float(r2_score(actual, predicted)),
    }


def grouped_error_metrics(
    validation: pd.DataFrame,
    predicted: np.ndarray,
) -> dict[str, dict[str, dict[str, float | int]]]:
    """Summarize holdout errors for useful assignment-time groups."""
    rows = validation.copy()
    rows["predicted_duration_minutes"] = predicted
    rows["signed_error_minutes"] = predicted - rows[training.TARGET_COLUMN].to_numpy()
    local_features = build_features(rows)
    rows["assigned_local_hour"] = local_features["assigned_local_hour"].to_numpy()
    coordinate_columns = [
        "pickup_latitude", "pickup_longitude", "destination_latitude",
        "destination_longitude", "straight_line_distance_km",
    ]
    rows["coordinate_group"] = np.where(
        rows[coordinate_columns].isna().any(axis=1), "missing_or_incomplete", "complete"
    )
    rows["distance_group"] = pd.cut(
        rows["straight_line_distance_km"],
        bins=[-0.001, 5, 10, 20, 35, 50, np.inf],
        labels=["0-5 km", "5-10 km", "10-20 km", "20-35 km", "35-50 km", "50+ km"],
        include_lowest=True,
    ).astype("string").fillna("distance_missing")
    rows["weight_group"] = pd.cut(
        rows["weight_kg"],
        bins=[0, 2, 10, 25, 50, np.inf],
        labels=["0-2 kg", "2-10 kg", "10-25 kg", "25-50 kg", "50+ kg"],
        include_lowest=True,
    ).astype("string")
    rows["quantity_group"] = rows["quantity"].astype(str)
    grouping_columns = {
        "distance": "distance_group",
        "priority": "priority",
        "package_category": "package_category",
        "weight": "weight_group",
        "quantity": "quantity_group",
        "coordinates": "coordinate_group",
        "assigned_local_hour": "assigned_local_hour",
    }
    summaries: dict[str, dict[str, dict[str, float | int]]] = {}
    for report_name, column in grouping_columns.items():
        groups: dict[str, dict[str, float | int]] = {}
        for name, group in rows.groupby(column, dropna=False, observed=False, sort=True):
            errors = group["signed_error_minutes"]
            groups[str(name)] = {
                "records": int(len(group)),
                "mae_minutes": float(errors.abs().mean()),
                "rmse_minutes": float(np.sqrt(np.square(errors).mean())),
                "mean_signed_error_minutes": float(errors.mean()),
            }
        summaries[report_name] = groups
    return summaries


def tune_and_save() -> dict[str, Any]:
    if not TRAIN_PATH.is_file() or not VALIDATION_PATH.is_file():
        raise FileNotFoundError("Generate v2 training and validation datasets first.")
    train_data = pd.read_csv(TRAIN_PATH)
    validation_data = pd.read_csv(VALIDATION_PATH)
    validate_dataset(train_data, "training")
    validate_dataset(validation_data, "validation")
    if not train_data["data_source"].eq(DATA_SOURCE).all() or not validation_data["data_source"].eq(DATA_SOURCE).all():
        raise ValueError("Only v2 synthetic datasets may be used for this workflow.")

    train_features = build_features(train_data)
    validation_features = build_features(validation_data)
    train_target = train_data[training.TARGET_COLUMN].astype(float)
    validation_target = validation_data[training.TARGET_COLUMN].astype(float)
    tuning_results: dict[str, list[dict[str, Any]]] = {}
    selected_by_family: dict[str, dict[str, Any]] = {}

    for family, configurations in model_configurations().items():
        family_results: list[dict[str, Any]] = []
        for parameters in configurations:
            candidate = create_pipeline(make_regressor(family, parameters))
            candidate.fit(train_features, train_target)
            predictions = np.asarray(candidate.predict(validation_features), dtype=float)
            result = {
                "parameters": parameters,
                "metrics": regression_metrics(validation_target, predictions),
            }
            family_results.append(result)
        tuning_results[family] = family_results
        selected_by_family[family] = min(
            family_results, key=lambda result: result["metrics"]["mae_minutes"]
        )

    selected_family = min(
        selected_by_family,
        key=lambda family: selected_by_family[family]["metrics"]["mae_minutes"],
    )
    best_parameters = selected_by_family[selected_family]["parameters"]
    best_validation_model = create_pipeline(make_regressor(selected_family, best_parameters))
    best_validation_model.fit(train_features, train_target)
    validation_predictions = np.asarray(
        best_validation_model.predict(validation_features), dtype=float
    )

    combined_data = pd.concat([train_data, validation_data], ignore_index=True)
    combined_features = build_features(combined_data)
    combined_target = combined_data[training.TARGET_COLUMN].astype(float)
    final_model = create_pipeline(make_regressor(selected_family, best_parameters))
    final_model.fit(combined_features, combined_target)

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    artifact_path = MODEL_DIR / f"{selected_family}.joblib"
    joblib.dump(final_model, artifact_path)
    artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    model_version = f"{selected_family}-synthetic-{artifact_hash[:12]}"
    category_comparisons = {
        column: {
            "training_percent": {
                str(name): float(value * 100)
                for name, value in train_data[column].value_counts(normalize=True).items()
            },
            "validation_percent": {
                str(name): float(value * 100)
                for name, value in validation_data[column].value_counts(normalize=True).items()
            },
        }
        for column in ("priority", "package_category")
    }
    metadata = {
        "training_source": "synthetic",
        "model_name": selected_family,
        "model_version": model_version,
        "feature_version": FEATURE_VERSION,
        "artifact_sha256": artifact_hash,
        "dataset_paths": [str(TRAIN_PATH), str(VALIDATION_PATH)],
        "training_rows": len(train_data),
        "validation_rows_used_for_selection": len(validation_data),
        "final_fit_rows": len(combined_data),
        "feature_columns": FEATURE_COLUMNS,
        "target_column": training.TARGET_COLUMN,
        "real_world_accuracy_validated": False,
    }
    artifact_path.with_suffix(".metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )
    report = {
        "status": "v2_validation_and_model_selection_complete",
        "data_source": DATA_SOURCE,
        "target_method": "src.v2_target.expected_delivery_duration shared across all v2 splits",
        "training_rows": len(train_data),
        "validation_rows": len(validation_data),
        "final_fit_rows_training_plus_validation": len(combined_data),
        "scenario_overlap": False,
        "tuning_results": tuning_results,
        "validation_metrics_by_model": {
            family: selected_by_family[family]["metrics"] for family in selected_by_family
        },
        "selected_model": selected_family,
        "selected_parameters": best_parameters,
        "validation_error_groups": grouped_error_metrics(
            validation_data, validation_predictions
        ),
        "category_mix": category_comparisons,
        "coordinate_missing_rows": {
            "training": int(train_data[[
                "pickup_latitude", "pickup_longitude", "destination_latitude",
                "destination_longitude",
            ]].isna().any(axis=1).sum()),
            "validation": int(validation_data[[
                "pickup_latitude", "pickup_longitude", "destination_latitude",
                "destination_longitude",
            ]].isna().any(axis=1).sum()),
        },
        "model_artifact": str(artifact_path),
        "model_version": model_version,
        "model_metadata": str(artifact_path.with_suffix(".metadata.json")),
        "validation_metrics_are_model_selection_metrics": True,
        "independent_test_used_for_training_or_model_selection": False,
        "real_world_accuracy_validated": False,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    report = tune_and_save()
    print(json.dumps({
        "report_path": str(REPORT_PATH),
        "selected_model": report["selected_model"],
        "selected_parameters": report["selected_parameters"],
        "validation_metrics_by_model": report["validation_metrics_by_model"],
        "artifact": report["model_artifact"],
        "model_version": report["model_version"],
    }, indent=2))


if __name__ == "__main__":
    main()

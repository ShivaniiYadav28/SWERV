"""Train and compare delivery-duration regressors when enough data exists."""

from __future__ import annotations

import json
import math
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


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DATASET_PATH = WORKSPACE_ROOT / "data" / "processed" / "delivery_time_dataset.csv"
REPORT_PATH = WORKSPACE_ROOT / "data" / "processed" / "training_evaluation_report.json"
MODEL_DIR = WORKSPACE_ROOT / "models"

TARGET_COLUMN = "delivery_duration_minutes"
MINIMUM_RECORDS_FOR_TRAINING = 200
TEST_FRACTION = 0.20
MINIMUM_TEST_RECORDS = 40

# Keep this list explicit. The target and post-assignment values are not inputs.
RAW_FEATURE_COLUMNS = [
    "request_created_at",
    "assigned_at",
    "priority",
    "package_category",
    "weight_kg",
    "quantity",
    "pickup_latitude",
    "pickup_longitude",
    "destination_latitude",
    "destination_longitude",
    "straight_line_distance_km",
]
CATEGORICAL_COLUMNS = ["priority", "package_category"]
NUMERICAL_COLUMNS = [
    "request_to_assignment_minutes",
    "request_created_hour",
    "request_created_day_of_week",
    "assigned_hour",
    "assigned_day_of_week",
    "weight_kg",
    "quantity",
    "pickup_latitude",
    "pickup_longitude",
    "destination_latitude",
    "destination_longitude",
    "straight_line_distance_km",
]
MODEL_FACTORIES = {
    "linear_regression": lambda: LinearRegression(),
    "random_forest": lambda: RandomForestRegressor(
        n_estimators=300, min_samples_leaf=2, random_state=42, n_jobs=-1
    ),
    "gradient_boosting": lambda: GradientBoostingRegressor(random_state=42),
}


def build_features(dataset: pd.DataFrame) -> pd.DataFrame:
    """Build features known when the agent is assigned to the request."""
    missing_columns = sorted(set(RAW_FEATURE_COLUMNS) - set(dataset.columns))
    if missing_columns:
        raise ValueError(f"Dataset is missing required columns: {', '.join(missing_columns)}")

    # Select only this allowlist, so extra target, status, and event columns
    # cannot enter the model even if present in the input CSV.
    features = dataset.loc[:, RAW_FEATURE_COLUMNS].copy()
    created_at = pd.to_datetime(features.pop("request_created_at"), utc=True, errors="coerce")
    assigned_at = pd.to_datetime(features.pop("assigned_at"), utc=True, errors="coerce")

    features["request_to_assignment_minutes"] = (
        assigned_at - created_at
    ).dt.total_seconds() / 60
    features["request_created_hour"] = created_at.dt.hour
    features["request_created_day_of_week"] = created_at.dt.dayofweek
    features["assigned_hour"] = assigned_at.dt.hour
    features["assigned_day_of_week"] = assigned_at.dt.dayofweek
    return features.loc[:, CATEGORICAL_COLUMNS + NUMERICAL_COLUMNS]


def create_preprocessor() -> ColumnTransformer:
    """Impute missing values and one-hot encode category features."""
    numeric_pipeline = Pipeline(
        steps=[("imputer", SimpleImputer(strategy="median"))]
    )
    categorical_pipeline = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="most_frequent")),
            ("one_hot", OneHotEncoder(handle_unknown="ignore")),
        ]
    )
    return ColumnTransformer(
        transformers=[
            ("numeric", numeric_pipeline, NUMERICAL_COLUMNS),
            ("categorical", categorical_pipeline, CATEGORICAL_COLUMNS),
        ]
    )


def create_model_pipeline(model_name: str) -> Pipeline:
    if model_name not in MODEL_FACTORIES:
        raise ValueError(f"Unknown model: {model_name}")
    return Pipeline(
        steps=[("preprocessor", create_preprocessor()), ("regressor", MODEL_FACTORIES[model_name]())]
    )


def chronological_split(
    features: pd.DataFrame,
    target: pd.Series,
    assigned_at: pd.Series,
    test_fraction: float = TEST_FRACTION,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.Series, pd.Series]:
    """Use earlier assignments for training and the newest ones for testing."""
    order = pd.to_datetime(assigned_at, utc=True, errors="coerce").sort_values(kind="stable").index
    ordered_features = features.loc[order]
    ordered_target = target.loc[order]
    test_count = max(MINIMUM_TEST_RECORDS, math.ceil(len(order) * test_fraction))
    split_at = len(order) - test_count
    if split_at <= 0:
        raise ValueError("Not enough rows for both a training set and chronological test set.")
    return (
        ordered_features.iloc[:split_at],
        ordered_features.iloc[split_at:],
        ordered_target.iloc[:split_at],
        ordered_target.iloc[split_at:],
    )


def _valid_training_rows(dataset: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    if TARGET_COLUMN not in dataset.columns:
        raise ValueError(f"Dataset is missing target column: {TARGET_COLUMN}")
    target = pd.to_numeric(dataset[TARGET_COLUMN], errors="coerce")
    created_at = pd.to_datetime(dataset["request_created_at"], utc=True, errors="coerce")
    assigned_at = pd.to_datetime(dataset["assigned_at"], utc=True, errors="coerce")
    valid = (
        target.notna()
        & np.isfinite(target)
        & (target > 0)
        & created_at.notna()
        & assigned_at.notna()
        & (assigned_at >= created_at)
    )
    return dataset.loc[valid].copy(), int((~valid).sum())


def evaluate_models(
    dataset: pd.DataFrame, models_dir: Path | None = None
) -> dict[str, Any]:
    """Train only above the data floor; otherwise return a clear refusal."""
    valid_data, invalid_target_rows = _valid_training_rows(dataset)
    row_count = len(valid_data)
    report: dict[str, Any] = {
        "status": "insufficient_data",
        "usable_rows": row_count,
        "invalid_target_or_time_rows_excluded": invalid_target_rows,
        "minimum_rows_required": MINIMUM_RECORDS_FOR_TRAINING,
        "minimum_chronological_test_rows": MINIMUM_TEST_RECORDS,
        "target_column": TARGET_COLUMN,
        "metrics": {},
        "artifacts_saved": [],
        "performance_claimed_reliable": False,
    }

    if row_count < MINIMUM_RECORDS_FOR_TRAINING:
        report["reason"] = (
            f"Only {row_count} usable rows are available; at least "
            f"{MINIMUM_RECORDS_FOR_TRAINING} are required. With five rows, a "
            "chronological holdout would leave too few examples to fit and test "
            "the models, so performance estimates would be unstable. No model "
            "was trained and no model artifact was saved."
        )
        return report

    features = build_features(valid_data)
    target = pd.to_numeric(valid_data[TARGET_COLUMN], errors="coerce")
    train_x, test_x, train_y, test_y = chronological_split(
        features, target, valid_data["assigned_at"]
    )
    report["status"] = "exploratory_evaluation_complete"
    report["training_rows"] = len(train_x)
    report["test_rows"] = len(test_x)
    report["missing_feature_values"] = {
        column: int(features[column].isna().sum()) for column in features.columns
    }
    report["metrics"] = {}

    for model_name in MODEL_FACTORIES:
        model = create_model_pipeline(model_name)
        model.fit(train_x, train_y)
        predictions = model.predict(test_x)
        report["metrics"][model_name] = {
            "mae_minutes": float(mean_absolute_error(test_y, predictions)),
            "rmse_minutes": float(np.sqrt(mean_squared_error(test_y, predictions))),
            "r2": float(r2_score(test_y, predictions)),
        }
        if models_dir is not None:
            models_dir.mkdir(parents=True, exist_ok=True)
            artifact_path = models_dir / f"{model_name}.joblib"
            joblib.dump(model, artifact_path)
            report["artifacts_saved"].append(str(artifact_path))

    report["performance_claimed_reliable"] = False
    report["reliability_note"] = (
        "The minimum row and holdout thresholds permit an exploratory comparison, "
        "but do not by themselves establish production reliability. Validate on "
        "additional later deliveries before relying on predictions."
    )
    return report


def main() -> None:
    if not DATASET_PATH.exists():
        raise SystemExit(f"Dataset not found: {DATASET_PATH}. Run src/dataset.py first.")
    dataset = pd.read_csv(DATASET_PATH)
    report = evaluate_models(dataset, models_dir=MODEL_DIR)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({**report, "report_path": str(REPORT_PATH)}, indent=2))


if __name__ == "__main__":
    main()

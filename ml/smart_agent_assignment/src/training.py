"""Train and compare candidate delivery-time regression models."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline

from .features import DATA_SOURCE_COLUMN, GROUP_COLUMN, TARGET_COLUMN, TIME_COLUMN, build_features, create_preprocessor
from .synthetic_dataset import DATASET_PATH, validate_dataset


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_DIR = WORKSPACE / "models" / "synthetic"
REPORT_PATH = WORKSPACE / "data" / "processed" / "synthetic_training_report.json"
MODEL_FACTORIES = {
    "linear_regression": LinearRegression,
    "random_forest": lambda: RandomForestRegressor(
        n_estimators=120, min_samples_leaf=2, random_state=42, n_jobs=-1
    ),
    "gradient_boosting": lambda: GradientBoostingRegressor(random_state=42),
}


def chronological_group_split(dataset: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """Keep every candidate in a scenario together and test on newer scenarios."""
    scenario_times = dataset.groupby(GROUP_COLUMN)[TIME_COLUMN].first()
    scenario_times = pd.to_datetime(scenario_times, utc=True, errors="coerce")
    if scenario_times.isna().any() or scenario_times.nunique() < 2:
        raise ValueError("At least two valid, chronologically ordered scenarios are required.")
    ordered_groups = scenario_times.sort_values(kind="stable").index.tolist()
    test_group_count = max(1, int(np.ceil(len(ordered_groups) * 0.20)))
    training_groups = set(ordered_groups[:-test_group_count])
    test_groups = set(ordered_groups[-test_group_count:])
    train_mask = dataset[GROUP_COLUMN].isin(training_groups)
    test_mask = dataset[GROUP_COLUMN].isin(test_groups)
    return train_mask, test_mask


def rank_accuracy(
    groups: pd.Series, actual: pd.Series, predicted: np.ndarray
) -> float:
    """Return the fraction of dispatches where the predicted top candidate is fastest."""
    scored = pd.DataFrame({GROUP_COLUMN: groups, "actual": actual, "predicted": predicted})
    successful = 0
    for _, scenario in scored.groupby(GROUP_COLUMN):
        predicted_best = scenario["predicted"].idxmin()
        actual_best = scenario["actual"].idxmin()
        successful += int(predicted_best == actual_best)
    return successful / scored[GROUP_COLUMN].nunique()


def train_models(dataset: pd.DataFrame, model_dir: Path = MODEL_DIR) -> dict[str, Any]:
    validate_dataset(dataset)
    if not dataset[DATA_SOURCE_COLUMN].eq("synthetic").all():
        raise ValueError("This training command accepts only synthetic data.")
    if len(dataset) < 200:
        raise ValueError("At least 200 valid candidate rows are required for training.")

    train_mask, test_mask = chronological_group_split(dataset)
    train_rows = dataset.loc[train_mask]
    test_rows = dataset.loc[test_mask]
    train_features = build_features(train_rows)
    test_features = build_features(test_rows)
    train_target = train_rows[TARGET_COLUMN].astype(float)
    test_target = test_rows[TARGET_COLUMN].astype(float)
    models: dict[str, Pipeline] = {}
    results: dict[str, dict[str, float]] = {}
    model_dir.mkdir(parents=True, exist_ok=True)

    for name, factory in MODEL_FACTORIES.items():
        model = Pipeline([
            ("preprocessor", create_preprocessor()),
            ("regressor", factory()),
        ])
        model.fit(train_features, train_target)
        predicted = model.predict(test_features)
        results[name] = {
            "mae_minutes": float(mean_absolute_error(test_target, predicted)),
            "rmse_minutes": float(np.sqrt(mean_squared_error(test_target, predicted))),
            "r2": float(r2_score(test_target, predicted)),
            "top_candidate_accuracy": rank_accuracy(
                test_rows[GROUP_COLUMN], test_target, predicted
            ),
        }
        models[name] = model

    best_name = min(
        results,
        key=lambda name: (results[name]["mae_minutes"], -results[name]["top_candidate_accuracy"]),
    )
    model_versions: dict[str, str] = {}
    artifacts: dict[str, str] = {}
    for name, model in models.items():
        artifact_path = model_dir / f"{name}.joblib"
        joblib.dump(model, artifact_path)
        digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        version = f"{name}-synthetic-{digest[:12]}"
        metadata = {
            "training_source": "synthetic",
            "model_name": name,
            "model_version": version,
            "artifact_sha256": digest,
            "target_column": TARGET_COLUMN,
            "feature_columns": list(train_features.columns),
            "training_rows": len(train_rows),
            "test_rows": len(test_rows),
            "training_scenarios": int(train_rows[GROUP_COLUMN].nunique()),
            "test_scenarios": int(test_rows[GROUP_COLUMN].nunique()),
            "real_world_accuracy_validated": False,
        }
        artifact_path.with_suffix(".metadata.json").write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )
        artifacts[name] = str(artifact_path)
        model_versions[name] = version

    return {
        "status": "synthetic_exploratory_evaluation_complete",
        "data_source": "synthetic",
        "dataset_path": str(DATASET_PATH),
        "candidate_rows": len(dataset),
        "dispatch_scenarios": int(dataset[GROUP_COLUMN].nunique()),
        "training_rows": len(train_rows),
        "test_rows": len(test_rows),
        "training_scenarios": int(train_rows[GROUP_COLUMN].nunique()),
        "test_scenarios": int(test_rows[GROUP_COLUMN].nunique()),
        "target_column": TARGET_COLUMN,
        "feature_columns": list(train_features.columns),
        "metrics": results,
        "best_model": best_name,
        "best_model_artifact": artifacts[best_name],
        "best_model_version": model_versions[best_name],
        "model_artifacts": artifacts,
        "model_versions": model_versions,
        "real_world_accuracy_validated": False,
        "note": "Metrics are based on synthetic candidate data and must not be treated as real-world performance.",
    }


def main() -> None:
    if not DATASET_PATH.is_file():
        raise SystemExit("Synthetic candidate dataset is missing; run python -m src.synthetic_dataset first.")
    report = train_models(pd.read_csv(DATASET_PATH))
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({**report, "report_path": str(REPORT_PATH)}, indent=2))


if __name__ == "__main__":
    main()

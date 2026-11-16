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

from .features import (
    CATEGORICAL_COLUMNS,
    DATA_SOURCE_COLUMN,
    FEATURE_COLUMNS,
    GROUP_COLUMN,
    NUMERICAL_COLUMNS,
    TARGET_COLUMN,
    TIME_COLUMN,
    build_features,
    create_preprocessor,
)
from .ranking_metrics import ndcg_for_scenario
from .synthetic_dataset import DATASET_PATH, SEED, validate_dataset


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_DIR = WORKSPACE / "models" / "synthetic"
REPORT_DIR = WORKSPACE / "data" / "processed"
REPORT_PATH = REPORT_DIR / "synthetic_training_report.json"
VALIDATION_REPORT_PATH = REPORT_DIR / "validation_evaluation_report.json"
FINAL_TEST_REPORT_PATH = REPORT_DIR / "final_test_evaluation_report.json"
TRAINING_SEED = SEED
TRAINING_FRACTION = 0.70
VALIDATION_FRACTION = 0.15
FINAL_TEST_FRACTION = 0.15
SPLIT_CONFIGURATION = {
    "method": "chronological_dispatch_grouped",
    "training_fraction": TRAINING_FRACTION,
    "validation_fraction": VALIDATION_FRACTION,
    "final_test_fraction": FINAL_TEST_FRACTION,
}
MODEL_FACTORIES = {
    "linear_regression": LinearRegression,
    "random_forest": lambda: RandomForestRegressor(
        n_estimators=120, min_samples_leaf=2, random_state=TRAINING_SEED, n_jobs=-1
    ),
    "gradient_boosting": lambda: GradientBoostingRegressor(random_state=TRAINING_SEED),
}


def chronological_group_split(
    dataset: pd.DataFrame,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Split newest dispatch groups into validation and final test partitions."""
    scenario_times = dataset.groupby(GROUP_COLUMN, sort=False)[TIME_COLUMN].first()
    scenario_times = pd.to_datetime(scenario_times, utc=True, errors="coerce")
    if scenario_times.isna().any() or scenario_times.nunique() < 3:
        raise ValueError("At least three valid, chronologically ordered scenarios are required.")

    ordered_groups = scenario_times.sort_values(kind="stable").index.tolist()
    training_end = int(len(ordered_groups) * TRAINING_FRACTION)
    validation_end = int(len(ordered_groups) * (TRAINING_FRACTION + VALIDATION_FRACTION))
    if training_end < 1 or validation_end <= training_end or validation_end >= len(ordered_groups):
        raise ValueError("At least one dispatch scenario is required in each split.")

    training_groups = set(ordered_groups[:training_end])
    validation_groups = set(ordered_groups[training_end:validation_end])
    final_test_groups = set(ordered_groups[validation_end:])
    return (
        dataset[GROUP_COLUMN].isin(training_groups),
        dataset[GROUP_COLUMN].isin(validation_groups),
        dataset[GROUP_COLUMN].isin(final_test_groups),
    )


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


def mean_ndcg(
    groups: pd.Series,
    actual: pd.Series,
    predicted: np.ndarray,
    cutoff: int,
) -> float:
    """Average per-dispatch NDCG using lower delivery duration as higher relevance."""
    scored = pd.DataFrame({GROUP_COLUMN: groups, "actual": actual, "predicted": predicted})
    scores = []
    for _, scenario in scored.groupby(GROUP_COLUMN):
        predicted_order = np.argsort(scenario["predicted"].to_numpy(), kind="stable")
        scores.append(ndcg_for_scenario(
            scenario["actual"].to_numpy(dtype=float),
            predicted_order,
            cutoff,
        ))
    return float(np.mean(scores))


def evaluate_model(model: Pipeline, rows: pd.DataFrame) -> dict[str, float]:
    features = build_features(rows)
    target = rows[TARGET_COLUMN].astype(float)
    predicted = np.asarray(model.predict(features), dtype=float)
    return {
        "mae_minutes": float(mean_absolute_error(target, predicted)),
        "rmse_minutes": float(np.sqrt(mean_squared_error(target, predicted))),
        "r2": float(r2_score(target, predicted)),
        "top_candidate_accuracy": rank_accuracy(rows[GROUP_COLUMN], target, predicted),
        "ndcg_at_1": mean_ndcg(rows[GROUP_COLUMN], target, predicted, 1),
        "ndcg_at_3": mean_ndcg(rows[GROUP_COLUMN], target, predicted, 3),
    }


def model_selection_key(name: str, metrics: dict[str, float]) -> tuple[float, ...]:
    return (
        -metrics["ndcg_at_1"],
        -metrics["top_candidate_accuracy"],
        -metrics["ndcg_at_3"],
        metrics["mae_minutes"],
        metrics["rmse_minutes"],
        name,
    )


def _split_counts(
    dataset: pd.DataFrame,
    masks: tuple[pd.Series, pd.Series, pd.Series],
) -> dict[str, dict[str, int]]:
    result: dict[str, dict[str, int]] = {}
    for name, mask in zip(("training", "validation", "final_test"), masks, strict=True):
        rows = dataset.loc[mask]
        result[name] = {
            "candidate_rows": len(rows),
            "scenarios": int(rows[GROUP_COLUMN].nunique()),
        }
    return result


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def train_models(
    dataset: pd.DataFrame,
    model_dir: Path = MODEL_DIR,
    report_dir: Path | None = None,
) -> dict[str, Any]:
    validate_dataset(dataset)
    if not dataset[DATA_SOURCE_COLUMN].eq("synthetic").all():
        raise ValueError("This training command accepts only synthetic data.")
    if len(dataset) < 200:
        raise ValueError("At least 200 valid candidate rows are required for training.")

    masks = chronological_group_split(dataset)
    training_mask, validation_mask, final_test_mask = masks
    split_counts = _split_counts(dataset, masks)
    training_rows = dataset.loc[training_mask]
    validation_rows = dataset.loc[validation_mask]
    final_test_rows = dataset.loc[final_test_mask]
    validation_metrics: dict[str, dict[str, float]] = {}

    training_features = build_features(training_rows)
    training_target = training_rows[TARGET_COLUMN].astype(float)
    validation_features = build_features(validation_rows)
    validation_target = validation_rows[TARGET_COLUMN].astype(float)

    for name, factory in MODEL_FACTORIES.items():
        model = Pipeline([
            ("preprocessor", create_preprocessor()),
            ("regressor", factory()),
        ])
        model.fit(training_features, training_target)
        predicted = np.asarray(model.predict(validation_features), dtype=float)
        validation_metrics[name] = {
            "mae_minutes": float(mean_absolute_error(validation_target, predicted)),
            "rmse_minutes": float(np.sqrt(mean_squared_error(validation_target, predicted))),
            "r2": float(r2_score(validation_target, predicted)),
            "top_candidate_accuracy": rank_accuracy(
                validation_rows[GROUP_COLUMN], validation_target, predicted
            ),
            "ndcg_at_1": mean_ndcg(
                validation_rows[GROUP_COLUMN], validation_target, predicted, 1
            ),
            "ndcg_at_3": mean_ndcg(
                validation_rows[GROUP_COLUMN], validation_target, predicted, 3
            ),
        }

    best_name = min(
        validation_metrics,
        key=lambda name: model_selection_key(name, validation_metrics[name]),
    )
    validation_report: dict[str, Any] = {
        "evaluation": "validation_model_selection",
        "data_source": "synthetic",
        "training_seed": TRAINING_SEED,
        "split_configuration": SPLIT_CONFIGURATION,
        "split_counts": split_counts,
        "model_selection_order": [
            "ndcg_at_1 descending",
            "top_candidate_accuracy descending",
            "ndcg_at_3 descending",
            "mae_minutes ascending",
            "rmse_minutes ascending",
            "model name ascending",
        ],
        "metrics": validation_metrics,
        "selected_model": best_name,
        "real_world_performance_validated": False,
    }

    fit_rows = dataset.loc[training_mask | validation_mask]
    fit_features = build_features(fit_rows)
    fit_target = fit_rows[TARGET_COLUMN].astype(float)
    model_dir.mkdir(parents=True, exist_ok=True)
    artifacts: dict[str, str] = {}
    model_versions: dict[str, str] = {}
    final_models: dict[str, Pipeline] = {}

    for name, factory in MODEL_FACTORIES.items():
        model = Pipeline([
            ("preprocessor", create_preprocessor()),
            ("regressor", factory()),
        ])
        model.fit(fit_features, fit_target)
        artifact_path = model_dir / f"{name}.joblib"
        joblib.dump(model, artifact_path)
        digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        version = f"{name}-synthetic-{digest[:12]}"
        metadata: dict[str, Any] = {
            "training_source": "synthetic",
            "model_name": name,
            "model_version": version,
            "artifact_sha256": digest,
            "target_column": TARGET_COLUMN,
            "feature_columns": list(FEATURE_COLUMNS),
            "feature_schema": {
                "categorical_columns": list(CATEGORICAL_COLUMNS),
                "numerical_columns": list(NUMERICAL_COLUMNS),
            },
            "dataset_seed": SEED,
            "training_seed": TRAINING_SEED,
            "split_configuration": SPLIT_CONFIGURATION,
            "split_counts": split_counts,
            "training_rows": len(fit_rows),
            "training_scenarios": int(fit_rows[GROUP_COLUMN].nunique()),
            "validation_rows": split_counts["validation"]["candidate_rows"],
            "validation_scenarios": split_counts["validation"]["scenarios"],
            "final_test_rows": split_counts["final_test"]["candidate_rows"],
            "final_test_scenarios": split_counts["final_test"]["scenarios"],
            "validation_metrics": validation_metrics[name],
            "selected_for_final_evaluation": name == best_name,
            "real_world_performance_validated": False,
        }
        artifact_path.with_suffix(".metadata.json").write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )
        artifacts[name] = str(artifact_path)
        model_versions[name] = version
        final_models[name] = model

    final_test_metrics = evaluate_model(final_models[best_name], final_test_rows)
    final_test_report: dict[str, Any] = {
        "evaluation": "selected_model_final_test",
        "data_source": "synthetic",
        "training_seed": TRAINING_SEED,
        "split_configuration": SPLIT_CONFIGURATION,
        "split_counts": split_counts,
        "selected_model": best_name,
        "model_version": model_versions[best_name],
        "metrics": final_test_metrics,
        "model_selection_used_final_test": False,
        "real_world_performance_validated": False,
    }

    if report_dir is not None:
        _write_report(report_dir / VALIDATION_REPORT_PATH.name, validation_report)
        _write_report(report_dir / FINAL_TEST_REPORT_PATH.name, final_test_report)

    return {
        "status": "synthetic_exploratory_evaluation_complete",
        "data_source": "synthetic",
        "dataset_path": str(DATASET_PATH),
        "candidate_rows": len(dataset),
        "dispatch_scenarios": int(dataset[GROUP_COLUMN].nunique()),
        "split_configuration": SPLIT_CONFIGURATION,
        "split_counts": split_counts,
        "training_seed": TRAINING_SEED,
        "dataset_seed": SEED,
        "model_fit_rows": len(fit_rows),
        "model_fit_scenarios": int(fit_rows[GROUP_COLUMN].nunique()),
        "target_column": TARGET_COLUMN,
        "feature_columns": list(FEATURE_COLUMNS),
        "validation_metrics": validation_metrics,
        "final_test_metrics": final_test_metrics,
        "best_model": best_name,
        "best_model_artifact": artifacts[best_name],
        "best_model_version": model_versions[best_name],
        "model_artifacts": artifacts,
        "model_versions": model_versions,
        "validation_report_path": str(
            (report_dir or REPORT_DIR) / VALIDATION_REPORT_PATH.name
        ),
        "final_test_report_path": str(
            (report_dir or REPORT_DIR) / FINAL_TEST_REPORT_PATH.name
        ),
        "real_world_performance_validated": False,
        "note": "Metrics are based on generated demo data and do not establish real-world performance.",
    }


def main() -> None:
    if not DATASET_PATH.is_file():
        raise SystemExit("Synthetic candidate dataset is missing; run python -m src.synthetic_dataset first.")
    report = train_models(pd.read_csv(DATASET_PATH), report_dir=REPORT_DIR)
    _write_report(REPORT_PATH, report)
    print(json.dumps({**report, "report_path": str(REPORT_PATH)}, indent=2))


if __name__ == "__main__":
    main()

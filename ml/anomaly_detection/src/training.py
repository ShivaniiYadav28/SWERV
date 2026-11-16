"""Train and evaluate Isolation Forest on generated anomaly scenarios."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from .synthetic_dataset import (
    CATEGORICAL_FEATURES,
    DATA_SOURCE,
    FEATURE_COLUMNS,
    NORMAL_LABEL,
    NUMERIC_FEATURES,
    OUTPUT_COLUMNS,
    PROJECT_ROOT,
)


DATA_DIRECTORY = PROJECT_ROOT / "data" / "processed" / "synthetic"
MODEL_DIRECTORY = PROJECT_ROOT / "models" / "synthetic"
REPORT_DIRECTORY = DATA_DIRECTORY
TRAINING_PATH = DATA_DIRECTORY / "synthetic_train.csv"
VALIDATION_PATH = DATA_DIRECTORY / "synthetic_validation.csv"
TEST_PATH = DATA_DIRECTORY / "synthetic_test.csv"
FALSE_POSITIVE_LIMIT = 0.10
RANDOM_SEED = 9301
MODEL_NAME = "isolation_forest"


def load_splits(
    training_path: Path = TRAINING_PATH,
    validation_path: Path = VALIDATION_PATH,
    test_path: Path = TEST_PATH,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Load disjoint, generated splits and validate their labels and provenance."""
    frames = {
        "train": pd.read_csv(training_path),
        "validation": pd.read_csv(validation_path),
        "test": pd.read_csv(test_path),
    }
    identifiers: list[set[str]] = []
    for split_name, frame in frames.items():
        if frame.empty or not set(OUTPUT_COLUMNS).issubset(frame.columns):
            raise ValueError(f"The {split_name} dataset is empty or has a missing column.")
        if not (frame["dataset_split"] == split_name).all():
            raise ValueError(f"The {split_name} dataset has an incorrect split label.")
        if not (frame["data_source"] == DATA_SOURCE).all():
            raise ValueError(f"The {split_name} data is not labelled generated-only.")
        if frame["scenario_id"].duplicated().any():
            raise ValueError(f"The {split_name} dataset contains duplicate scenario IDs.")
        if not set(frame["is_anomaly"].unique()).issubset({0, 1}):
            raise ValueError(f"The {split_name} labels must be binary.")
        if not (frame["is_anomaly"].astype(int) == (frame["anomaly_type"] != NORMAL_LABEL).astype(int)).all():
            raise ValueError(f"The {split_name} anomaly labels do not match their categories.")
        if frame["anomaly_type"].nunique() < 2:
            raise ValueError(f"The {split_name} dataset must include normal and anomalous scenarios.")
        identifiers.append(set(frame["scenario_id"].astype(str)))

    if any(identifiers[left] & identifiers[right] for left in range(3) for right in range(left + 1, 3)):
        raise ValueError("A scenario ID appears in more than one train, validation, or test split.")
    return frames["train"], frames["validation"], frames["test"]


def create_preprocessor() -> ColumnTransformer:
    """Fit missing-value handling and scaling from training features only."""
    numeric_pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
    ])
    categorical_pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("one_hot", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
    ])
    return ColumnTransformer([
        ("numeric", numeric_pipeline, NUMERIC_FEATURES),
        ("categorical", categorical_pipeline, CATEGORICAL_FEATURES),
    ])


def choose_validation_contamination(actual: np.ndarray) -> float:
    """Estimate the expected anomaly fraction from validation labels only."""
    if actual.ndim != 1 or len(actual) == 0 or len(np.unique(actual)) != 2:
        raise ValueError("Validation data must contain both normal and anomalous labels.")
    contamination = float(np.mean(actual))
    if not 0 < contamination <= 0.5:
        raise ValueError("Validation anomaly prevalence must be greater than zero and at most one half.")
    return contamination


def create_isolation_forest(contamination: float) -> IsolationForest:
    return IsolationForest(
        n_estimators=300,
        max_samples="auto",
        contamination=contamination,
        max_features=1.0,
        bootstrap=False,
        random_state=RANDOM_SEED,
        n_jobs=-1,
    )


def anomaly_scores(model: IsolationForest, features: np.ndarray) -> np.ndarray:
    """Return larger scores for observations farther outside the learned distribution."""
    return -model.decision_function(features)


def binary_metrics(actual: np.ndarray, scores: np.ndarray, threshold: float) -> dict[str, Any]:
    predicted = (scores >= threshold).astype(int)
    matrix = confusion_matrix(actual, predicted, labels=[0, 1])
    true_negative, false_positive, false_negative, true_positive = matrix.ravel()
    false_positive_rate = false_positive / (false_positive + true_negative) if false_positive + true_negative else 0.0
    false_negative_rate = false_negative / (false_negative + true_positive) if false_negative + true_positive else 0.0
    has_both_classes = len(np.unique(actual)) == 2
    return {
        "threshold": float(threshold),
        "precision": float(precision_score(actual, predicted, zero_division=0)),
        "recall": float(recall_score(actual, predicted, zero_division=0)),
        "f1": float(f1_score(actual, predicted, zero_division=0)),
        "accuracy": float(accuracy_score(actual, predicted)),
        "confusion_matrix": matrix.tolist(),
        "false_positive_rate": float(false_positive_rate),
        "false_negative_rate": float(false_negative_rate),
        "roc_auc": float(roc_auc_score(actual, scores)) if has_both_classes else None,
        "precision_recall_auc": float(average_precision_score(actual, scores)) if has_both_classes else None,
    }


def choose_validation_threshold(actual: np.ndarray, scores: np.ndarray) -> tuple[float, dict[str, Any]]:
    """Maximize validation F1 while keeping the false-positive rate at or below 10%."""
    candidates = np.append(np.unique(scores), np.nextafter(np.max(scores), np.inf))
    feasible: list[tuple[tuple[float, float, float], float, dict[str, Any]]] = []
    all_candidates: list[tuple[tuple[float, float, float, float], float, dict[str, Any]]] = []
    for candidate in candidates:
        metrics = binary_metrics(actual, scores, float(candidate))
        rank = (metrics["f1"], metrics["recall"], metrics["precision"], -metrics["false_positive_rate"])
        all_candidates.append((rank, float(candidate), metrics))
        if metrics["false_positive_rate"] <= FALSE_POSITIVE_LIMIT:
            feasible.append(((metrics["f1"], metrics["recall"], metrics["precision"]), float(candidate), metrics))
    if feasible:
        _, threshold, metrics = max(feasible, key=lambda item: item[0])
        metrics["threshold_selection_rule"] = (
            "Best validation F1 with false-positive rate at or below 10%; ties favor recall then precision."
        )
        return threshold, metrics

    _, threshold, metrics = min(
        all_candidates,
        key=lambda item: (item[2]["false_positive_rate"], -item[2]["recall"], -item[2]["precision"]),
    )
    metrics["threshold_selection_rule"] = (
        "No threshold met the 10% validation false-positive limit; selected the lowest false-positive rate, then highest recall."
    )
    return threshold, metrics


def category_detection_recall(
    actual_categories: pd.Series,
    predicted_anomalies: np.ndarray,
) -> dict[str, dict[str, float | int]]:
    """Report binary detector recall separately for each generated anomaly label."""
    report: dict[str, dict[str, float | int]] = {}
    for category in sorted(set(actual_categories) - {NORMAL_LABEL}):
        category_mask = actual_categories.to_numpy() == category
        report[str(category)] = {
            "scenarios": int(category_mask.sum()),
            "detected": int(predicted_anomalies[category_mask].sum()),
            "recall": float(predicted_anomalies[category_mask].mean()),
        }
    return report


def deterministic_model_version(training_hash: str) -> str:
    version_input = f"{MODEL_NAME}|{DATA_SOURCE}|{training_hash}|{RANDOM_SEED}|v2"
    short_hash = hashlib.sha256(version_input.encode("utf-8")).hexdigest()[:12]
    return f"{MODEL_NAME}-synthetic-{short_hash}"


def verify_artifact_integrity(artifact_path: Path, metadata_path: Path) -> str:
    """Confirm the saved artifact matches the digest recorded in its sidecar."""
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        actual_digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("The saved anomaly artifact or metadata could not be verified.") from error
    if metadata.get("artifact_sha256") != actual_digest:
        raise ValueError("The saved anomaly artifact does not match its metadata SHA-256 digest.")
    return actual_digest


def train_and_evaluate(
    training: pd.DataFrame,
    validation: pd.DataFrame,
    test: pd.DataFrame,
    *,
    model_directory: Path = MODEL_DIRECTORY,
    report_directory: Path = REPORT_DIRECTORY,
) -> dict[str, Any]:
    """Fit on training features, calibrate on validation, then evaluate test once."""
    if "scenario_id" in FEATURE_COLUMNS or "anomaly_type" in FEATURE_COLUMNS or "is_anomaly" in FEATURE_COLUMNS:
        raise ValueError("Identifiers and generated labels cannot be model features.")
    if min(len(training), len(validation), len(test)) < 100:
        raise ValueError("At least 100 rows are required in each train, validation, and test split.")

    preprocessor = create_preprocessor()
    training_features = preprocessor.fit_transform(training[FEATURE_COLUMNS])
    validation_features = preprocessor.transform(validation[FEATURE_COLUMNS])
    validation_labels = validation["is_anomaly"].to_numpy(dtype=int)

    # Labels set the contamination estimate from validation, but are never passed to fit.
    contamination = choose_validation_contamination(validation_labels)
    model = create_isolation_forest(contamination)
    model.fit(training_features)

    validation_scores = anomaly_scores(model, validation_features)
    threshold, validation_metrics = choose_validation_threshold(validation_labels, validation_scores)
    validation_metrics["category_detection_recall"] = category_detection_recall(
        validation["anomaly_type"],
        (validation_scores >= threshold).astype(int),
    )
    native_validation_metrics = binary_metrics(validation_labels, validation_scores, 0.0)

    training_hash = hashlib.sha256(
        training[FEATURE_COLUMNS].to_csv(index=False).encode("utf-8")
    ).hexdigest()
    model_version = deterministic_model_version(training_hash)
    artifact = {
        "model": model,
        "preprocessor": preprocessor,
        "model_name": MODEL_NAME,
        "model_version": model_version,
        "detection_mode": "unsupervised",
        "threshold": threshold,
        "contamination": contamination,
        "feature_columns": FEATURE_COLUMNS,
        "numeric_features": NUMERIC_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "normal_label": NORMAL_LABEL,
        "data_source": DATA_SOURCE,
        "synthetic_provenance": (
            "Isolation Forest trained on generated anomaly scenarios; "
            "metrics do not establish real-world SWERV detection accuracy."
        ),
    }

    model_directory.mkdir(parents=True, exist_ok=True)
    report_directory.mkdir(parents=True, exist_ok=True)
    artifact_path = model_directory / "anomaly_detector.joblib"
    metadata_path = model_directory / "anomaly_detector.metadata.json"
    joblib.dump(artifact, artifact_path, compress=3)
    artifact_digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    selection_report = {
        "data_source": DATA_SOURCE,
        "synthetic_only": True,
        "real_world_accuracy_claim": False,
        "model_selection_used_test_data": False,
        "model_name": MODEL_NAME,
        "selected_model": MODEL_NAME,
        "model_version": model_version,
        "training_rows": len(training),
        "validation_rows": len(validation),
        "independent_test_rows_held_until_selection": len(test),
        "validation_contamination": contamination,
        "contamination_selection_rule": "Observed anomaly prevalence in the validation split only.",
        "decision_threshold": threshold,
        "threshold_selection_rule": validation_metrics["threshold_selection_rule"],
        "false_positive_target": FALSE_POSITIVE_LIMIT,
        "native_validation_metrics_at_zero_score": native_validation_metrics,
        "validation_metrics": validation_metrics,
        "features": FEATURE_COLUMNS,
        "preprocessing_fit_on": "training split only",
        "isolation_forest_fit_labels_used": False,
        "random_seed": RANDOM_SEED,
        "artifact_sha256": artifact_digest,
        "limitations": [
            "All scenarios and labels are generated; reported metrics are not SWERV operational accuracy.",
            "Scenario rates and thresholds are illustrative generator assumptions.",
            "Each anomaly label is a generated scenario class; category recall is binary detector recall, not a predicted category classification score.",
        ],
    }
    metadata_path.write_text(json.dumps(selection_report, indent=2) + "\n", encoding="utf-8")
    verify_artifact_integrity(artifact_path, metadata_path)

    # The independent test split is first scored only after model and threshold selection.
    test_features = preprocessor.transform(test[FEATURE_COLUMNS])
    test_labels = test["is_anomaly"].to_numpy(dtype=int)
    test_scores = anomaly_scores(model, test_features)
    test_metrics = binary_metrics(test_labels, test_scores, threshold)
    test_metrics["category_detection_recall"] = category_detection_recall(
        test["anomaly_type"],
        (test_scores >= threshold).astype(int),
    )
    test_report = {
        "data_source": DATA_SOURCE,
        "synthetic_only": True,
        "real_world_accuracy_claim": False,
        "model_name": MODEL_NAME,
        "model_version": model_version,
        "test_scenarios": len(test),
        "metrics": test_metrics,
        "test_was_used_for_model_selection": False,
        "artifact_sha256": artifact_digest,
        "limitations": selection_report["limitations"],
    }
    (report_directory / "model_selection_report.json").write_text(
        json.dumps(selection_report, indent=2) + "\n", encoding="utf-8"
    )
    (report_directory / "independent_test_report.json").write_text(
        json.dumps(test_report, indent=2) + "\n", encoding="utf-8"
    )
    return {"selection": selection_report, "independent_test": test_report}


def main() -> None:
    parser = argparse.ArgumentParser(description="Train and evaluate the synthetic Isolation Forest model.")
    parser.add_argument("--train", type=Path, default=TRAINING_PATH)
    parser.add_argument("--validation", type=Path, default=VALIDATION_PATH)
    parser.add_argument("--test", type=Path, default=TEST_PATH)
    arguments = parser.parse_args()
    splits = load_splits(arguments.train, arguments.validation, arguments.test)
    report = train_and_evaluate(*splits)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
"""Compare anomaly models using separate synthetic scenario splits."""

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
from sklearn.ensemble import IsolationForest, RandomForestClassifier
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
from sklearn.neighbors import LocalOutlierFactor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from .synthetic_dataset import (
    CATEGORICAL_FEATURES,
    DATA_SOURCE,
    FEATURE_COLUMNS,
    NUMERIC_FEATURES,
    NORMAL_LABEL,
    PROJECT_ROOT,
)


DATA_DIRECTORY = PROJECT_ROOT / "data" / "processed" / "synthetic"
MODEL_DIRECTORY = PROJECT_ROOT / "models" / "synthetic"
REPORT_DIRECTORY = PROJECT_ROOT / "data" / "processed" / "synthetic"
TRAINING_PATH = DATA_DIRECTORY / "synthetic_train.csv"
VALIDATION_PATH = DATA_DIRECTORY / "synthetic_validation.csv"
TEST_PATH = DATA_DIRECTORY / "synthetic_test.csv"
FALSE_POSITIVE_LIMIT = 0.10
RANDOM_SEED = 9301


def load_splits(
    training_path: Path = TRAINING_PATH,
    validation_path: Path = VALIDATION_PATH,
    test_path: Path = TEST_PATH,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Load and validate split files, keeping scenarios in one split."""
    training = pd.read_csv(training_path)
    validation = pd.read_csv(validation_path)
    test = pd.read_csv(test_path)
    for frame, split_name in (
        (training, "train"),
        (validation, "validation"),
        (test, "test"),
    ):
        if frame.empty or not (frame["dataset_split"] == split_name).all():
            raise ValueError(f"The {split_name} dataset is empty or has an incorrect split label.")
        if not (frame["data_source"] == DATA_SOURCE).all():
            raise ValueError(f"The {split_name} data is not labelled synthetic.")
        if frame["scenario_id"].duplicated().any():
            raise ValueError(f"The {split_name} dataset contains duplicate scenario IDs.")
        if not set(frame["is_anomaly"].unique()).issubset({0, 1}):
            raise ValueError(f"The {split_name} labels must be binary.")
        if not (frame["is_anomaly"].astype(int) == (frame["anomaly_type"] != NORMAL_LABEL).astype(int)).all():
            raise ValueError(f"The {split_name} anomaly labels do not match their categories.")

    split_ids = [set(frame["scenario_id"]) for frame in (training, validation, test)]
    if split_ids[0] & split_ids[1] or split_ids[0] & split_ids[2] or split_ids[1] & split_ids[2]:
        raise ValueError("A scenario ID appears in more than one split.")
    return training, validation, test


def create_preprocessor() -> ColumnTransformer:
    """Create numeric and categorical preprocessing fitted on training rows."""
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


def model_configurations(normal_training_rows: int) -> dict[str, Any]:
    """Create reproducible models; LOF is configured for unseen records."""
    neighbor_count = min(25, max(2, normal_training_rows - 1))
    return {
        "isolation_forest": IsolationForest(
            n_estimators=200,
            contamination="auto",
            random_state=RANDOM_SEED,
            n_jobs=-1,
        ),
        "local_outlier_factor": LocalOutlierFactor(
            n_neighbors=neighbor_count,
            novelty=True,
            contamination="auto",
        ),
        "random_forest": RandomForestClassifier(
            n_estimators=180,
            max_features="sqrt",
            min_samples_leaf=2,
            class_weight="balanced_subsample",
            random_state=RANDOM_SEED,
            n_jobs=-1,
        ),
    }


def model_anomaly_scores(model_name: str, model: Any, features: np.ndarray) -> np.ndarray:
    """Return higher values for more likely anomalies."""
    if model_name == "isolation_forest":
        return -model.decision_function(features)
    if model_name == "local_outlier_factor":
        # With novelty=True this is valid for previously unseen validation/test rows.
        return -model.decision_function(features)
    probabilities = model.predict_proba(features)
    normal_index = list(model.classes_).index(NORMAL_LABEL)
    return 1.0 - probabilities[:, normal_index]


def binary_metrics(actual: np.ndarray, scores: np.ndarray, threshold: float) -> dict[str, Any]:
    predicted = (scores >= threshold).astype(int)
    matrix = confusion_matrix(actual, predicted, labels=[0, 1])
    true_negative, false_positive, false_negative, true_positive = matrix.ravel()
    false_positive_rate = false_positive / (false_positive + true_negative) if false_positive + true_negative else 0.0
    false_negative_rate = false_negative / (false_negative + true_positive) if false_negative + true_positive else 0.0
    return {
        "threshold": float(threshold),
        "precision": float(precision_score(actual, predicted, zero_division=0)),
        "recall": float(recall_score(actual, predicted, zero_division=0)),
        "f1": float(f1_score(actual, predicted, zero_division=0)),
        "accuracy": float(accuracy_score(actual, predicted)),
        "confusion_matrix": matrix.tolist(),
        "false_positive_rate": float(false_positive_rate),
        "false_negative_rate": float(false_negative_rate),
        "roc_auc": float(roc_auc_score(actual, scores)) if len(np.unique(actual)) == 2 else None,
        "precision_recall_auc": float(average_precision_score(actual, scores)) if len(np.unique(actual)) == 2 else None,
    }


def choose_validation_threshold(actual: np.ndarray, scores: np.ndarray) -> tuple[float, dict[str, Any]]:
    """Choose a validation threshold that limits false positives when possible."""
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
        metrics["threshold_selection_rule"] = "Best validation F1 with false-positive rate at or below 10%; ties favor recall then precision."
        return threshold, metrics

    _, threshold, metrics = min(
        all_candidates,
        key=lambda item: (item[2]["false_positive_rate"], -item[2]["recall"], -item[2]["precision"]),
    )
    metrics["threshold_selection_rule"] = "No threshold met the 10% validation false-positive limit; selected the lowest false-positive rate, then highest recall."
    return threshold, metrics


def predicted_categories(model_name: str, model: Any, features: np.ndarray, scores: np.ndarray, threshold: float) -> list[str | None]:
    predicted: list[str | None] = []
    if model_name != "random_forest":
        return ["unsupervised_outlier" if score >= threshold else "normal" for score in scores]

    probabilities = model.predict_proba(features)
    classes = list(model.classes_)
    anomaly_indices = [index for index, label in enumerate(classes) if label != NORMAL_LABEL]
    for row, score in zip(probabilities, scores):
        if score < threshold or not anomaly_indices:
            predicted.append("normal")
        else:
            best_index = max(anomaly_indices, key=lambda index: row[index])
            predicted.append(str(classes[best_index]))
    return predicted


def evaluate_model(
    model_name: str,
    model: Any,
    transformed_features: np.ndarray,
    rows: pd.DataFrame,
    threshold: float,
) -> dict[str, Any]:
    scores = model_anomaly_scores(model_name, model, transformed_features)
    metrics = binary_metrics(rows["is_anomaly"].to_numpy(dtype=int), scores, threshold)
    categories = predicted_categories(model_name, model, transformed_features, scores, threshold)
    metrics["predicted_category_counts"] = dict(sorted(pd.Series(categories).value_counts().to_dict().items()))
    if model_name == "random_forest":
        metrics["category_accuracy"] = float(accuracy_score(rows["anomaly_type"], categories))
    return metrics


def deterministic_model_version(model_name: str, train_data_hash: str) -> str:
    version_input = f"{model_name}|synthetic|{train_data_hash}|{RANDOM_SEED}|v1"
    short_hash = hashlib.sha256(version_input.encode("utf-8")).hexdigest()[:12]
    return f"{model_name}-synthetic-{short_hash}"


def train_and_evaluate(
    training: pd.DataFrame,
    validation: pd.DataFrame,
    test: pd.DataFrame,
    *,
    model_directory: Path = MODEL_DIRECTORY,
    report_directory: Path = REPORT_DIRECTORY,
) -> dict[str, Any]:
    """Fit candidates on training, choose on validation, and test the winner once."""
    if "scenario_id" in FEATURE_COLUMNS or "anomaly_type" in FEATURE_COLUMNS:
        raise ValueError("Identifiers and ground-truth categories cannot be model features.")
    if len(training) < 100:
        raise ValueError("At least 100 training scenarios are required for this prototype.")

    preprocessor = create_preprocessor()
    training_features = preprocessor.fit_transform(training[FEATURE_COLUMNS])
    validation_features = preprocessor.transform(validation[FEATURE_COLUMNS])
    normal_mask = training["is_anomaly"].to_numpy(dtype=int) == 0
    normal_training_features = training_features[normal_mask]
    if len(normal_training_features) < 30:
        raise ValueError("At least 30 normal training scenarios are required for unsupervised models.")

    models = model_configurations(len(normal_training_features))
    validation_results: dict[str, dict[str, Any]] = {}
    thresholds: dict[str, float] = {}
    for model_name, model in models.items():
        if model_name == "random_forest":
            model.fit(training_features, training["anomaly_type"].astype(str))
        else:
            # Both unsupervised models learn only from representative normal scenarios.
            model.fit(normal_training_features)
        validation_scores = model_anomaly_scores(model_name, model, validation_features)
        threshold, validation_metrics = choose_validation_threshold(
            validation["is_anomaly"].to_numpy(dtype=int), validation_scores
        )
        thresholds[model_name] = threshold
        validation_metrics["category_accuracy"] = float(
            accuracy_score(
                validation["anomaly_type"],
                predicted_categories(model_name, model, validation_features, validation_scores, threshold),
            )
        )
        validation_results[model_name] = validation_metrics

    eligible = [
        (name, metrics)
        for name, metrics in validation_results.items()
        if metrics["false_positive_rate"] <= FALSE_POSITIVE_LIMIT
    ]
    selection_pool = eligible or list(validation_results.items())
    selected_name, _ = max(
        selection_pool,
        key=lambda item: (
            item[1]["f1"],
            item[1]["recall"],
            item[1]["precision"],
            -item[1]["false_positive_rate"],
        ),
    )
    selected_model = models[selected_name]

    # The final test split is transformed and scored only after selection is fixed.
    test_features = preprocessor.transform(test[FEATURE_COLUMNS])
    test_metrics = evaluate_model(selected_name, selected_model, test_features, test, thresholds[selected_name])
    train_data_hash = hashlib.sha256(
        training[FEATURE_COLUMNS + ["is_anomaly", "anomaly_type"]].to_csv(index=False).encode("utf-8")
    ).hexdigest()
    model_version = deterministic_model_version(selected_name, train_data_hash)
    artifact = {
        "model": selected_model,
        "preprocessor": preprocessor,
        "model_name": selected_name,
        "model_version": model_version,
        "detection_mode": "supervised" if selected_name == "random_forest" else "unsupervised",
        "threshold": thresholds[selected_name],
        "feature_columns": FEATURE_COLUMNS,
        "numeric_features": NUMERIC_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "normal_label": NORMAL_LABEL,
        "data_source": DATA_SOURCE,
        "synthetic_provenance": "Trained on generated synthetic anomaly scenarios; real-world SWERV detection accuracy is not validated.",
    }

    model_directory.mkdir(parents=True, exist_ok=True)
    report_directory.mkdir(parents=True, exist_ok=True)
    artifact_path = model_directory / "anomaly_detector.joblib"
    metadata_path = model_directory / "anomaly_detector.metadata.json"
    joblib.dump(artifact, artifact_path)
    artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    selection_report = {
        "data_source": DATA_SOURCE,
        "synthetic_only": True,
        "model_selection_used_test_data": False,
        "training_rows": len(training),
        "validation_rows": len(validation),
        "independent_test_rows_held_until_selection": len(test),
        "validation_metrics": validation_results,
        "selected_model": selected_name,
        "model_version": model_version,
        "selection_reason": (
            "Selected by validation F1 among models at or below a 10% false-positive rate; "
            "ties favor recall, precision, and then lower false-positive rate."
            if eligible else
            "No candidate met the 10% validation false-positive target; selected by validation F1, then recall, precision, and lower false-positive rate."
        ),
        "features": FEATURE_COLUMNS,
        "preprocessing_fit_on": "training split only",
        "unsupervised_training_rows": int(normal_mask.sum()),
        "unsupervised_training_data": "normal training scenarios only",
        "random_seed": RANDOM_SEED,
        "artifact_sha256": artifact_hash,
        "limitations": [
            "All scenarios and labels are synthetic and cannot validate real SWERV performance.",
            "Rule thresholds and scenario frequencies are illustrative assumptions.",
            "The independent test is synthetic and generated separately from training and validation scenarios.",
        ],
    }
    test_report = {
        "data_source": DATA_SOURCE,
        "synthetic_only": True,
        "real_world_accuracy_claim": False,
        "model_name": selected_name,
        "model_version": model_version,
        "test_scenarios": len(test),
        "metrics": test_metrics,
        "test_was_used_for_model_selection": False,
        "artifact_sha256": artifact_hash,
        "limitations": selection_report["limitations"],
    }
    (report_directory / "model_selection_report.json").write_text(
        json.dumps(selection_report, indent=2) + "\n", encoding="utf-8"
    )
    (report_directory / "independent_test_report.json").write_text(
        json.dumps(test_report, indent=2) + "\n", encoding="utf-8"
    )
    metadata_path.write_text(json.dumps({key: value for key, value in selection_report.items() if key != "validation_metrics"}, indent=2) + "\n", encoding="utf-8")

    return {"selection": selection_report, "independent_test": test_report}


def main() -> None:
    parser = argparse.ArgumentParser(description="Train and compare synthetic anomaly detectors.")
    parser.add_argument("--train", type=Path, default=TRAINING_PATH)
    parser.add_argument("--validation", type=Path, default=VALIDATION_PATH)
    parser.add_argument("--test", type=Path, default=TEST_PATH)
    arguments = parser.parse_args()
    splits = load_splits(arguments.train, arguments.validation, arguments.test)
    report = train_and_evaluate(*splits)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

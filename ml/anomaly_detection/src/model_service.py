"""Load the selected anomaly model and score new, validated scenarios."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Mapping

import joblib
import numpy as np
import pandas as pd

from .synthetic_dataset import PACKAGE_CATEGORIES, PRIORITIES, VEHICLE_TYPES


class ModelUnavailableError(RuntimeError):
    """Raised when the saved anomaly artifact is missing or invalid."""


class InvalidScenarioError(ValueError):
    """Raised when a prediction row does not match the model feature schema."""


def load_model_artifact(model_path: Path) -> dict[str, Any]:
    """Load the complete model pipeline artifact once and verify its metadata."""
    try:
        artifact = joblib.load(model_path)
    except FileNotFoundError as error:
        raise ModelUnavailableError("No trained anomaly model artifact is available.") from error
    except Exception as error:
        raise ModelUnavailableError("The saved anomaly model could not be loaded.") from error

    required_fields = {
        "model", "preprocessor", "model_name", "model_version", "detection_mode",
        "threshold", "feature_columns", "numeric_features", "categorical_features",
        "normal_label", "data_source", "synthetic_provenance",
    }
    if not isinstance(artifact, dict) or not required_fields.issubset(artifact):
        raise ModelUnavailableError("The saved anomaly model has invalid metadata.")
    if (
        not isinstance(artifact["model_version"], str)
        or "synthetic" not in artifact["model_version"]
        or artifact["data_source"] != "synthetic"
        or artifact["detection_mode"] not in {"supervised", "unsupervised"}
        or not isinstance(artifact["feature_columns"], list)
        or not all(isinstance(column, str) for column in artifact["feature_columns"])
        or isinstance(artifact["threshold"], bool)
        or not isinstance(artifact["threshold"], (int, float))
        or not math.isfinite(artifact["threshold"])
    ):
        raise ModelUnavailableError("The saved anomaly model metadata is invalid.")
    if not hasattr(artifact["model"], "decision_function") and not hasattr(artifact["model"], "predict_proba"):
        raise ModelUnavailableError("The saved anomaly model cannot score scenarios.")
    if not hasattr(artifact["preprocessor"], "transform"):
        raise ModelUnavailableError("The saved anomaly preprocessing artifact is invalid.")
    return artifact


def validate_scenario_features(
    feature_values: Mapping[str, Any],
    artifact: Mapping[str, Any],
) -> None:
    expected_columns = set(artifact["feature_columns"])
    supplied_columns = set(feature_values)
    if supplied_columns != expected_columns:
        missing = sorted(expected_columns - supplied_columns)
        extra = sorted(supplied_columns - expected_columns)
        raise InvalidScenarioError(f"Scenario feature fields do not match the model schema. Missing: {missing}; unexpected: {extra}.")

    for column in artifact["numeric_features"]:
        value = feature_values[column]
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise InvalidScenarioError(f"Numeric feature {column} must be a finite number or null.")
    for column in artifact["categorical_features"]:
        value = feature_values[column]
        if column == "vehicle_type" and value is None:
            continue
        if not isinstance(value, str) or not value.strip():
            raise InvalidScenarioError(f"Categorical feature {column} must be a non-empty string.")
    allowed_categories = {
        "priority": PRIORITIES,
        "package_category": PACKAGE_CATEGORIES,
        "vehicle_type": VEHICLE_TYPES,
    }
    for column, allowed_values in allowed_categories.items():
        if feature_values[column] is not None and feature_values[column] not in allowed_values:
            raise InvalidScenarioError(f"Feature {column} has an unsupported value.")
    for column in (
        "gps_coordinates_valid", "gps_timestamps_valid", "gps_pair_available",
        "status_transition_valid", "activity_history_complete",
    ):
        value = feature_values[column]
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or value not in (0, 1)
        ):
            raise InvalidScenarioError(f"Feature {column} must be 0, 1, or null.")
    if feature_values["dispatch_creation_hour"] is not None and feature_values["dispatch_creation_hour"] > 23:
        raise InvalidScenarioError("Feature dispatch_creation_hour must be between 0 and 23.")
    for column in artifact["numeric_features"]:
        value = feature_values[column]
        if value is not None and value < 0:
            raise InvalidScenarioError(f"Numeric feature {column} cannot be negative.")


def score_scenario(
    feature_values: Mapping[str, Any],
    artifact: Mapping[str, Any],
) -> dict[str, Any]:
    """Return an ML candidate separately from hard GPS quality restrictions."""
    validate_scenario_features(feature_values, artifact)
    row = pd.DataFrame([{column: feature_values[column] for column in artifact["feature_columns"]}])
    transformed = artifact["preprocessor"].transform(row)
    model = artifact["model"]

    if artifact["model_name"] == "isolation_forest":
        score = float(-model.decision_function(transformed)[0])
        category = None
    elif artifact["model_name"] == "local_outlier_factor":
        score = float(-model.decision_function(transformed)[0])
        category = None
    else:
        probabilities = model.predict_proba(transformed)[0]
        classes = list(model.classes_)
        normal_index = classes.index(artifact["normal_label"])
        score = float(1.0 - probabilities[normal_index])
        anomaly_indices = [index for index, label in enumerate(classes) if label != artifact["normal_label"]]
        category = str(classes[max(anomaly_indices, key=lambda index: probabilities[index])]) if anomaly_indices else None

    if not math.isfinite(score):
        raise InvalidScenarioError("The model returned a non-finite anomaly score.")
    is_anomaly = score >= float(artifact["threshold"])
    quality_notes: list[str] = []
    is_gps_jump_candidate = category == "gps_implausible_jump"
    if is_gps_jump_candidate:
        gps_eligible = (
            feature_values["gps_pair_available"] == 1
            and feature_values["gps_coordinates_valid"] == 1
            and feature_values["gps_timestamps_valid"] == 1
            and feature_values["gps_freshness_minutes"] is not None
            and feature_values["gps_freshness_minutes"] <= 10
            and feature_values["gps_accuracy_meters"] is not None
            and feature_values["gps_accuracy_meters"] <= 100
            and feature_values["gps_interval_minutes"] is not None
            and feature_values["gps_interval_minutes"] <= 15
        )
        if not gps_eligible:
            is_anomaly = False
            category = None
            quality_notes.append("GPS jump prediction was withheld because the GPS pair is missing, stale, inaccurate, or too far apart in time.")

    return {
        "is_anomaly_candidate": bool(is_anomaly),
        "anomaly_score": score,
        "predicted_category": category if is_anomaly else None,
        "model_name": artifact["model_name"],
        "model_version": artifact["model_version"],
        "detection_method": artifact["model_name"],
        "detection_mode": artifact["detection_mode"],
        "data_quality_notes": quality_notes,
        "data_source": artifact["data_source"],
        "synthetic_provenance": artifact["synthetic_provenance"],
    }

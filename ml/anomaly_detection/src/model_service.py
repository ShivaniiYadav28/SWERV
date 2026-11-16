"""Load the selected anomaly model and score new, validated scenarios."""

from __future__ import annotations

import io
import json
import math
import hashlib
from pathlib import Path
from typing import Any, Mapping

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from .synthetic_dataset import (
    CATEGORICAL_FEATURES,
    DATA_SOURCE,
    FEATURE_COLUMNS,
    NORMAL_LABEL,
    NUMERIC_FEATURES,
    PACKAGE_CATEGORIES,
    PRIORITIES,
    VEHICLE_TYPES,
)


EXPECTED_MODEL_VERSION = "isolation_forest-synthetic-b3c24dbf05ff"
EXPECTED_ARTIFACT_SHA256 = "f5b9fc438955ab2cdd3a55330653b3a6ea513dc6ffd13e75bac2b53f4a524f80"


class ModelUnavailableError(RuntimeError):
    """Raised when the saved anomaly artifact is missing or invalid."""

    def __init__(
        self,
        message: str,
        *,
        artifact_integrity_status: str = "unavailable",
        feature_schema_compatible: bool = False,
    ) -> None:
        super().__init__(message)
        self.artifact_integrity_status = artifact_integrity_status
        self.feature_schema_compatible = feature_schema_compatible


class InvalidScenarioError(ValueError):
    """Raised when a prediction row does not match the model feature schema."""


def load_model_artifact(
    model_path: Path,
    metadata_path: Path | None = None,
    *,
    expected_model_version: str | None = EXPECTED_MODEL_VERSION,
    expected_artifact_sha256: str | None = EXPECTED_ARTIFACT_SHA256,
) -> dict[str, Any]:
    """Verify pinned bytes and schema before deserializing the trusted artifact."""
    metadata_path = metadata_path or model_path.with_suffix(".metadata.json")
    try:
        artifact_bytes = model_path.read_bytes()
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ModelUnavailableError("The saved anomaly artifact or metadata is unavailable.") from error

    artifact_digest = hashlib.sha256(artifact_bytes).hexdigest()
    if not isinstance(metadata, dict):
        raise ModelUnavailableError(
            "The anomaly artifact metadata has an invalid structure.",
            artifact_integrity_status="verified",
        )
    if artifact_digest != metadata.get("artifact_sha256") or (
        expected_artifact_sha256 is not None and artifact_digest != expected_artifact_sha256
    ):
        raise ModelUnavailableError(
            "The saved anomaly artifact failed its SHA-256 integrity check.",
            artifact_integrity_status="failed",
        )

    feature_schema_compatible = metadata.get("features") == FEATURE_COLUMNS
    expected_metadata = {
        "data_source": DATA_SOURCE,
        "synthetic_only": True,
        "real_world_accuracy_claim": False,
        "model_name": "isolation_forest",
        "selected_model": "isolation_forest",
        "isolation_forest_fit_labels_used": False,
    }
    metadata_compatible = feature_schema_compatible and all(
        metadata.get(key) == value for key, value in expected_metadata.items()
    )
    contamination = metadata.get("validation_contamination") if isinstance(metadata, dict) else None
    threshold = metadata.get("decision_threshold") if isinstance(metadata, dict) else None
    if (
        not metadata_compatible
        or not isinstance(metadata.get("model_version"), str)
        or (expected_model_version is not None and metadata["model_version"] != expected_model_version)
        or isinstance(contamination, bool)
        or not isinstance(contamination, (int, float))
        or not math.isfinite(contamination)
        or not 0 < contamination <= 0.5
        or isinstance(threshold, bool)
        or not isinstance(threshold, (int, float))
        or not math.isfinite(threshold)
    ):
        raise ModelUnavailableError(
            "The anomaly artifact metadata is incompatible with the expected model schema.",
            artifact_integrity_status="verified",
            feature_schema_compatible=feature_schema_compatible,
        )

    try:
        # Load the exact byte string whose digest was verified above.
        artifact = joblib.load(io.BytesIO(artifact_bytes))
    except Exception as error:
        raise ModelUnavailableError(
            "The verified anomaly artifact could not be loaded.",
            artifact_integrity_status="verified",
            feature_schema_compatible=True,
        ) from error

    required_fields = {
        "model", "preprocessor", "model_name", "model_version", "detection_mode",
        "threshold", "contamination", "feature_columns", "numeric_features",
        "categorical_features", "normal_label", "data_source", "synthetic_provenance",
    }
    schema_compatible = (
        isinstance(artifact, dict)
        and required_fields.issubset(artifact)
        and artifact.get("feature_columns") == FEATURE_COLUMNS
        and artifact.get("numeric_features") == NUMERIC_FEATURES
        and artifact.get("categorical_features") == CATEGORICAL_FEATURES
    )
    if not schema_compatible:
        raise ModelUnavailableError(
            "The loaded anomaly artifact has an incompatible feature schema.",
            artifact_integrity_status="verified",
            feature_schema_compatible=False,
        )
    if (
        not isinstance(artifact["model"], IsolationForest)
        or artifact["model_name"] != metadata["model_name"]
        or artifact["model_version"] != metadata["model_version"]
        or artifact["detection_mode"] != "unsupervised"
        or artifact["normal_label"] != NORMAL_LABEL
        or artifact["data_source"] != DATA_SOURCE
        or not isinstance(artifact["synthetic_provenance"], str)
        or not artifact["synthetic_provenance"].strip()
        or isinstance(artifact["threshold"], bool)
        or not isinstance(artifact["threshold"], (int, float))
        or not math.isfinite(artifact["threshold"])
        or isinstance(artifact["contamination"], bool)
        or not isinstance(artifact["contamination"], (int, float))
        or not math.isfinite(artifact["contamination"])
        or not math.isclose(float(artifact["threshold"]), float(threshold), rel_tol=0, abs_tol=1e-12)
        or not math.isclose(float(artifact["contamination"]), float(contamination), rel_tol=0, abs_tol=1e-12)
        or not hasattr(artifact["preprocessor"], "transform")
    ):
        raise ModelUnavailableError(
            "The loaded anomaly artifact does not match its verified metadata.",
            artifact_integrity_status="verified",
            feature_schema_compatible=True,
        )
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

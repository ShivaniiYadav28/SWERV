"""Load and run a saved synthetic demand forecasting model."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.base import RegressorMixin

from .features import FEATURE_COLUMNS


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_PATH = WORKSPACE / "models" / "synthetic" / "best_demand_model.joblib"
METADATA_PATH = MODEL_PATH.with_suffix(".metadata.json")
FEATURE_COLUMNS_PATH = MODEL_PATH.parent / "feature_columns.json"


def sha256_file(path: Path) -> str:
    """Return the SHA-256 hash of a file without printing its contents."""
    digest = hashlib.sha256()
    with path.open("rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_saved_model(
    model_path: Path = MODEL_PATH,
    metadata_path: Path = METADATA_PATH,
    feature_columns_path: Path = FEATURE_COLUMNS_PATH,
) -> tuple[RegressorMixin, list[str], str]:
    """Load a model only when its synthetic metadata and file hash are valid."""
    if not model_path.is_file() or not metadata_path.is_file() or not feature_columns_path.is_file():
        raise FileNotFoundError("The saved model, metadata, or feature list is missing.")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    feature_columns = json.loads(feature_columns_path.read_text(encoding="utf-8"))
    if metadata.get("training_source") != "synthetic":
        raise ValueError("The model is not labeled as synthetic-trained.")
    if feature_columns != FEATURE_COLUMNS or metadata.get("feature_columns") != feature_columns:
        raise ValueError("Saved feature columns do not match the approved feature list.")
    if metadata.get("artifact_sha256") != sha256_file(model_path):
        raise ValueError("The saved model hash does not match its metadata.")
    model_version = metadata.get("model_version")
    if not isinstance(model_version, str) or not model_version:
        raise ValueError("The model version is missing from metadata.")

    model = joblib.load(model_path)
    if not hasattr(model, "predict"):
        raise ValueError("The saved model does not support prediction.")
    return model, feature_columns, model_version


def predict_request_counts(
    model: RegressorMixin,
    featured_rows: pd.DataFrame,
    feature_columns: list[str] = FEATURE_COLUMNS,
) -> np.ndarray:
    """Make finite, non-negative predictions using the approved features."""
    missing_columns = set(feature_columns) - set(featured_rows.columns)
    if missing_columns:
        raise ValueError(f"Prediction rows are missing features: {', '.join(sorted(missing_columns))}")
    raw_predictions = np.asarray(model.predict(featured_rows[feature_columns]), dtype=float)
    if len(raw_predictions) != len(featured_rows) or not np.isfinite(raw_predictions).all():
        raise ValueError("The model returned incomplete or non-finite predictions.")
    return np.maximum(raw_predictions, 0.0)

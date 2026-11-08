"""Load and use a trained delivery model when a valid artifact is available."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import Pipeline
from sklearn.utils.validation import check_is_fitted

from . import training
from . import v2_features


DEFAULT_MODEL_PATH = training.MODEL_DIR / "linear_regression.joblib"
EXPECTED_INPUT_COLUMNS = training.CATEGORICAL_COLUMNS + training.NUMERICAL_COLUMNS


class DeliveryModelService:
    """Keep one validated model loaded for the lifetime of the API process."""

    def __init__(self, model_path: Path | None = None) -> None:
        configured_path = os.getenv("DELIVERY_MODEL_PATH")
        self.model_path = model_path or (
            Path(configured_path) if configured_path else DEFAULT_MODEL_PATH
        )
        self._model: Pipeline | None = None
        self._model_version: str | None = None
        self._feature_version = "v1"
        self._checked = False

    @property
    def model_version(self) -> str | None:
        self.load_model()
        return self._model_version

    @property
    def available(self) -> bool:
        return self.load_model()

    @property
    def feature_version(self) -> str:
        self.load_model()
        return self._feature_version

    def load_model(self) -> bool:
        """Load once and reject missing, corrupt, or incompatible artifacts."""
        if self._checked:
            return self._model is not None

        if not self.model_path.is_file() or self.model_path.suffix != ".joblib":
            return False
        self._checked = True

        try:
            artifact: Any = joblib.load(self.model_path)
            if not isinstance(artifact, Pipeline):
                return False
            if list(artifact.named_steps) != ["preprocessor", "regressor"]:
                return False
            regressor = artifact.named_steps["regressor"]
            model_names = {
                LinearRegression: "linear_regression",
                RandomForestRegressor: "random_forest",
                GradientBoostingRegressor: "gradient_boosting",
            }
            model_name = next(
                (name for model_type, name in model_names.items() if isinstance(regressor, model_type)),
                None,
            )
            if model_name is None:
                return False
            check_is_fitted(regressor)
            preprocessor = artifact.named_steps["preprocessor"]
            check_is_fitted(preprocessor)
            fitted_inputs = list(preprocessor.feature_names_in_)
            artifact_digest = hashlib.sha256(self.model_path.read_bytes()).hexdigest()
            digest = artifact_digest[:12]
            metadata_path = self.model_path.with_suffix(".metadata.json")
            if metadata_path.is_file():
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                if (
                    metadata.get("training_source") != "synthetic"
                    or metadata.get("model_name") != model_name
                    or metadata.get("artifact_sha256") != artifact_digest
                ):
                    return False
                feature_version = metadata.get("feature_version", "v1")
                if feature_version not in ("v1", "v2"):
                    return False
                version = f"{model_name}-synthetic-{digest}"
            else:
                feature_version = "v1"
                version = f"{model_name}-{digest}"
            expected_inputs = (
                v2_features.FEATURE_COLUMNS
                if feature_version == "v2"
                else EXPECTED_INPUT_COLUMNS
            )
            if fitted_inputs != expected_inputs:
                return False
        except Exception:
            # Do not expose artifact paths or deserialization details to callers.
            return False

        self._model = artifact
        self._model_version = version
        self._feature_version = feature_version
        return True

    def predict(self, features: pd.DataFrame) -> float | None:
        """Return a positive finite prediction, or None if the model is unavailable."""
        if not self.load_model() or self._model is None:
            return None
        try:
            value = float(self._model.predict(features)[0])
        except Exception:
            return None
        if not np.isfinite(value) or value <= 0:
            return None
        return value


model_service = DeliveryModelService()

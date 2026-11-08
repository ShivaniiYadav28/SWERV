"""Load a validated synthetic model and make candidate duration predictions."""

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

from .features import FEATURE_COLUMNS


DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "synthetic" / "gradient_boosting.joblib"
ALLOWED_REGRESSORS = (LinearRegression, RandomForestRegressor, GradientBoostingRegressor)


class AgentRecommendationModel:
    """Load one model artifact and validate its provenance before use."""

    def __init__(self, model_path: Path | None = None) -> None:
        configured_path = os.getenv("SMART_AGENT_MODEL_PATH")
        self.model_path = model_path or (Path(configured_path) if configured_path else DEFAULT_MODEL_PATH)
        self._model: Pipeline | None = None
        self._version: str | None = None
        self._checked = False

    @property
    def available(self) -> bool:
        return self.load()

    @property
    def model_version(self) -> str | None:
        self.load()
        return self._version

    def load(self) -> bool:
        if self._checked:
            return self._model is not None
        if not self.model_path.is_file() or self.model_path.suffix != ".joblib":
            return False
        self._checked = True
        try:
            artifact: Any = joblib.load(self.model_path)
            if not isinstance(artifact, Pipeline) or list(artifact.named_steps) != ["preprocessor", "regressor"]:
                return False
            regressor = artifact.named_steps["regressor"]
            if not isinstance(regressor, ALLOWED_REGRESSORS):
                return False
            check_is_fitted(artifact)
            if list(artifact.named_steps["preprocessor"].feature_names_in_) != FEATURE_COLUMNS:
                return False
            metadata_path = self.model_path.with_suffix(".metadata.json")
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            digest = hashlib.sha256(self.model_path.read_bytes()).hexdigest()
            if (
                metadata.get("training_source") != "synthetic"
                or metadata.get("model_name") != self.model_path.stem
                or metadata.get("artifact_sha256") != digest
                or not isinstance(metadata.get("model_version"), str)
                or not metadata["model_version"].startswith(f"{self.model_path.stem}-synthetic-")
            ):
                return False
        except Exception:
            return False
        self._model = artifact
        self._version = metadata["model_version"]
        return True

    def predict(self, features: pd.DataFrame) -> list[float] | None:
        if not self.load() or self._model is None:
            return None
        try:
            predictions = np.asarray(self._model.predict(features), dtype=float)
        except Exception:
            return None
        if not np.isfinite(predictions).all() or (predictions <= 0).any():
            return None
        return predictions.tolist()


model_service = AgentRecommendationModel()

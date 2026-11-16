"""Load a validated synthetic model and make candidate duration predictions."""

from __future__ import annotations

import hashlib
import json
import logging
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

from .features import CATEGORICAL_COLUMNS, FEATURE_COLUMNS, NUMERICAL_COLUMNS


DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "synthetic" / "gradient_boosting.joblib"
ALLOWED_REGRESSORS = (LinearRegression, RandomForestRegressor, GradientBoostingRegressor)
EXPECTED_FEATURE_SCHEMA = {
    "categorical_columns": CATEGORICAL_COLUMNS,
    "numerical_columns": NUMERICAL_COLUMNS,
}
logger = logging.getLogger(__name__)


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
        self._checked = True
        if not self.model_path.is_file() or self.model_path.suffix != ".joblib":
            logger.error("Smart Agent Assignment model artifact is missing or has an invalid extension.")
            return False
        try:
            metadata_path = self.model_path.with_suffix(".metadata.json")
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            digest = hashlib.sha256(self.model_path.read_bytes()).hexdigest()
            if (
                metadata.get("training_source") != "synthetic"
                or metadata.get("model_name") != self.model_path.stem
                or metadata.get("artifact_sha256") != digest
                or metadata.get("feature_columns") != FEATURE_COLUMNS
                or metadata.get("feature_schema") != EXPECTED_FEATURE_SCHEMA
                or metadata.get("model_version")
                != f"{self.model_path.stem}-synthetic-{digest[:12]}"
            ):
                logger.error("Smart Agent Assignment model metadata failed integrity or schema validation.")
                return False

            artifact: Any = joblib.load(self.model_path)
            if not isinstance(artifact, Pipeline) or list(artifact.named_steps) != ["preprocessor", "regressor"]:
                logger.error("Smart Agent Assignment model artifact has an unsupported pipeline structure.")
                return False
            regressor = artifact.named_steps["regressor"]
            if not isinstance(regressor, ALLOWED_REGRESSORS):
                logger.error("Smart Agent Assignment model artifact has an unsupported regressor.")
                return False
            check_is_fitted(artifact)
            if list(artifact.named_steps["preprocessor"].feature_names_in_) != FEATURE_COLUMNS:
                logger.error("Smart Agent Assignment model artifact has an incompatible feature schema.")
                return False
        except Exception:
            logger.exception("Smart Agent Assignment model could not be loaded or validated.")
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
            logger.exception("Smart Agent Assignment prediction failed.")
            return None
        if not np.isfinite(predictions).all() or (predictions <= 0).any():
            logger.error("Smart Agent Assignment model produced invalid predictions.")
            return None
        return predictions.tolist()


model_service = AgentRecommendationModel()

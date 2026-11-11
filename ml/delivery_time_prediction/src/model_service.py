"""Load and use a trained delivery model when a valid artifact is available."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import Pipeline
from sklearn.utils.validation import check_is_fitted

from . import training
from . import v2_features


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_INPUT_COLUMNS = training.CATEGORICAL_COLUMNS + training.NUMERICAL_COLUMNS


SHA256_HEX_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")


def is_valid_sha256(digest: str) -> bool:
    return bool(SHA256_HEX_PATTERN.fullmatch(digest.strip()))


def is_production_environment() -> bool:
    env = os.getenv(
        "DELIVERY_PREDICTION_ENV",
        os.getenv("SWERV_ENV", os.getenv("ENVIRONMENT", os.getenv("NODE_ENV", ""))),
    ).strip().lower()
    return env == "production" or bool(os.getenv("RENDER"))


class DeliveryModelService:
    """Keep one validated model loaded for the lifetime of the API process."""

    def __init__(self, model_path: Path | None = None) -> None:
        configured_path = os.getenv("DELIVERY_MODEL_PATH", "").strip()
        selected_path: Path | None = None
        if model_path is not None:
            selected_path = model_path
        elif configured_path:
            selected_path = Path(configured_path)
        else:
            # In production or when DELIVERY_MODEL_PATH is unset, never load synthetic model automatically.
            selected_path = None

        if selected_path is not None:
            if not selected_path.is_absolute():
                selected_path = WORKSPACE_ROOT / selected_path
            self.model_path: Path | None = selected_path.resolve()
        else:
            self.model_path = None

        self._model: Pipeline | None = None
        self._model_version: str | None = None
        self._feature_version = "v1"
        self._checked = False

    @property
    def model_version(self) -> str | None:
        self.load_model()
        return self._model_version

    @property
    def artifacts_loaded(self) -> bool:
        return self.available

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

        if self.model_path is None:
            self._checked = True
            return False

        if not self.model_path.is_file() or self.model_path.suffix != ".joblib":
            self._checked = True
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
                DummyRegressor: "median_baseline",
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

            # FIX 2: Server-side artifact approval
            # In production, require APPROVED_MODEL_SHA256 to be present, valid,
            # and exactly match the actual calculated SHA-256 of the .joblib file.
            if is_production_environment():
                configured_approved_hash = os.getenv("APPROVED_MODEL_SHA256", "").strip().lower()
                if not configured_approved_hash or not is_valid_sha256(configured_approved_hash):
                    return False
                if artifact_digest.lower() != configured_approved_hash:
                    return False

            metadata_path = self.model_path.with_suffix(".metadata.json")
            if metadata_path.is_file():
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                training_source = metadata.get("training_source", "unknown")
                if (
                    training_source not in ("synthetic", "lade_d", "operational", "baseline")
                    or metadata.get("model_name") != model_name
                    or metadata.get("artifact_sha256") != artifact_digest
                ):
                    return False

                # FIX 1: Strict production provenance policy
                # In production, accept ONLY training_source == "operational".
                # Reject baseline, lade_d, synthetic, unknown, missing and all other values.
                if is_production_environment() and training_source != "operational":
                    return False

                feature_version = metadata.get("feature_version", "v1")
                if feature_version not in ("v1", "v2"):
                    return False
                version = f"{model_name}-{training_source}-{digest}"
            else:
                # Production strictly rejects artifacts without verified provenance metadata
                if is_production_environment():
                    return False
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

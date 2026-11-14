"""FastAPI service for the synthetic hourly demand forecasting model."""

from __future__ import annotations

import hmac
import logging
import os
from functools import lru_cache
from typing import TypeAlias

from fastapi import Depends, FastAPI, Header, HTTPException
from sklearn.base import RegressorMixin

from .features import FEATURE_COLUMNS
from .forecasting import forecast_request_counts
from .model_service import load_saved_model
from .schemas import (
    DemandForecastRequest,
    DemandForecastResponse,
    DemandHealthResponse,
)
from .synthetic_history import load_synthetic_history


ModelBundle: TypeAlias = tuple[RegressorMixin, list[str], str]
logger = logging.getLogger(__name__)
SYNTHETIC_PROVENANCE = (
    "Trained on generated synthetic hourly demand data; real-world SWERV accuracy is not validated."
)
SYNTHETIC_HISTORY_PROVENANCE = (
    "Forecast history comes only from the bundled generated synthetic hourly dataset."
)

app = FastAPI(
    title="SWERV AI Demand Forecasting",
    version="0.1.0",
    description="Separate synthetic-data prototype for UTC hourly request-count forecasts.",
)


def require_service_auth(authorization: str | None = Header(default=None)) -> None:
    """Require the backend's shared secret without revealing it in responses."""
    api_key = os.getenv("DEMAND_FORECASTING_API_KEY", "").strip()
    if len(api_key) < 32:
        raise HTTPException(status_code=503, detail="Demand forecasting service authentication is not configured.")

    scheme, separator, supplied_key = (authorization or "").partition(" ")
    if (
        scheme.lower() != "bearer"
        or not separator
        or not hmac.compare_digest(supplied_key.strip(), api_key)
    ):
        raise HTTPException(status_code=401, detail="A valid service credential is required.")


@lru_cache(maxsize=1)
def get_model_bundle() -> ModelBundle | None:
    """Load and verify the saved model once, or mark it unavailable."""
    try:
        model, feature_columns, model_version = load_saved_model()
    except Exception as error:
        logger.warning("Demand forecasting model could not be loaded (error_type=%s)", type(error).__name__)
        return None
    if feature_columns != FEATURE_COLUMNS:
        return None
    return model, feature_columns, model_version


@app.get("/health", response_model=DemandHealthResponse)
def health(model_bundle: ModelBundle | None = Depends(get_model_bundle)) -> DemandHealthResponse:
    try:
        load_synthetic_history()
        history_available = True
    except Exception as error:
        logger.warning("Synthetic demand history is unavailable (error_type=%s)", type(error).__name__)
        history_available = False
    return DemandHealthResponse(
        status="ok",
        model_available=model_bundle is not None,
        model_version=model_bundle[2] if model_bundle else None,
        synthetic_history_available=history_available,
        training_source="synthetic" if model_bundle else None,
        synthetic_provenance=SYNTHETIC_PROVENANCE,
    )


@app.post(
    "/predict",
    response_model=DemandForecastResponse,
    dependencies=[Depends(require_service_auth)],
)
def predict(
    request: DemandForecastRequest,
    model_bundle: ModelBundle | None = Depends(get_model_bundle),
) -> DemandForecastResponse:
    if model_bundle is None:
        raise HTTPException(
            status_code=503,
            detail="Demand forecasting model is unavailable; no forecast was generated.",
        )

    model, feature_columns, model_version = model_bundle
    try:
        historical_request_counts, last_history_timestamp = load_synthetic_history()
        if request.forecast_start_timestamp <= last_history_timestamp:
            raise HTTPException(
                status_code=422,
                detail="forecast_start_timestamp must follow the bundled synthetic history.",
            )
        hourly_predictions = forecast_request_counts(
            model,
            request.forecast_start_timestamp,
            list(historical_request_counts),
            request.forecast_periods,
            feature_columns,
        )
    except HTTPException:
        raise
    except Exception as error:
        logger.warning("Demand forecasting inference failed (error_type=%s)", type(error).__name__)
        raise HTTPException(
            status_code=503,
            detail="Demand forecasting model could not produce a valid forecast.",
        ) from error

    return DemandForecastResponse(
        forecast_start_timestamp=request.forecast_start_timestamp,
        forecast_periods=request.forecast_periods,
        predictions=hourly_predictions,
        model_version=model_version,
        history_source="synthetic_hourly_demand.csv",
        history_provenance=SYNTHETIC_HISTORY_PROVENANCE,
        training_source="synthetic",
        synthetic_provenance=SYNTHETIC_PROVENANCE,
    )

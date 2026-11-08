"""FastAPI service for the synthetic hourly demand forecasting model."""

from __future__ import annotations

from functools import lru_cache
from typing import TypeAlias

from fastapi import Depends, FastAPI, HTTPException
from sklearn.base import RegressorMixin

from .features import FEATURE_COLUMNS
from .forecasting import forecast_request_counts
from .model_service import load_saved_model
from .schemas import (
    DemandForecastRequest,
    DemandForecastResponse,
    DemandHealthResponse,
)


ModelBundle: TypeAlias = tuple[RegressorMixin, list[str], str]
SYNTHETIC_PROVENANCE = (
    "Trained on generated synthetic hourly demand data; real-world SWERV accuracy is not validated."
)

app = FastAPI(
    title="SWERV AI Demand Forecasting",
    version="0.1.0",
    description="Separate synthetic-data prototype for UTC hourly request-count forecasts.",
)


@lru_cache(maxsize=1)
def get_model_bundle() -> ModelBundle | None:
    """Load and verify the saved model once, or mark it unavailable."""
    try:
        model, feature_columns, model_version = load_saved_model()
    except Exception:
        return None
    if feature_columns != FEATURE_COLUMNS:
        return None
    return model, feature_columns, model_version


@app.get("/health", response_model=DemandHealthResponse)
def health(model_bundle: ModelBundle | None = Depends(get_model_bundle)) -> DemandHealthResponse:
    return DemandHealthResponse(
        status="ok",
        model_available=model_bundle is not None,
        model_version=model_bundle[2] if model_bundle else None,
        training_source="synthetic" if model_bundle else None,
        synthetic_provenance=SYNTHETIC_PROVENANCE,
    )


@app.post("/predict", response_model=DemandForecastResponse)
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
        hourly_predictions = forecast_request_counts(
            model,
            request.forecast_start_timestamp,
            request.historical_request_counts,
            request.forecast_periods,
            feature_columns,
        )
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail="Demand forecasting model could not produce a valid forecast.",
        ) from error

    return DemandForecastResponse(
        forecast_start_timestamp=request.forecast_start_timestamp,
        forecast_periods=request.forecast_periods,
        predictions=hourly_predictions,
        model_version=model_version,
        training_source="synthetic",
        synthetic_provenance=SYNTHETIC_PROVENANCE,
    )

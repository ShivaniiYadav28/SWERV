"""FastAPI app for local delivery-time predictions."""

from __future__ import annotations

from contextlib import asynccontextmanager
import math
from typing import Any

import numpy as np
import pandas as pd
from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse

from .dataset import straight_line_distance_km
from .model_service import (
    DeliveryModelService,
    demo_model_service,
    is_demo_enabled,
    model_service,
    operational_model_service,
)
from .schemas import (
    DeliveryPredictionRequest,
    DemoPredictionResponse,
    HealthResponse,
    PredictionResponse,
)
from .training import build_features
from .v2_features import build_features as build_v2_features


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model artifacts once during application startup."""
    try:
        operational_model_service.load_model()
    except Exception:
        pass
    try:
        demo_model_service.load_model()
    except Exception:
        pass
    yield


app = FastAPI(
    title="SWERV Delivery Time Prediction",
    version="0.1.0",
    description="Standalone prediction service for SWERV delivery time prediction on Render.",
    lifespan=lifespan,
)


def get_model_service() -> DeliveryModelService:
    return operational_model_service


def get_operational_model_service() -> DeliveryModelService:
    return operational_model_service


def get_demo_model_service() -> DeliveryModelService:
    return demo_model_service


def unavailable_response(message: str) -> JSONResponse:
    response = PredictionResponse(
        predicted_duration_minutes=None,
        model_version=None,
        prediction_status="unavailable",
        message=message,
    )
    return JSONResponse(status_code=503, content=response.model_dump())


def make_model_features(
    request: DeliveryPredictionRequest,
    feature_version: str = "v1",
) -> pd.DataFrame:
    pickup = None
    destination = None
    if request.pickup_latitude is not None:
        pickup = (request.pickup_latitude, request.pickup_longitude)
    if request.destination_latitude is not None:
        destination = (request.destination_latitude, request.destination_longitude)

    distance = (
        straight_line_distance_km(pickup, destination)
        if pickup is not None and destination is not None
        else np.nan
    )
    row: dict[str, Any] = {
        "request_created_at": request.request_created_at,
        "assigned_at": request.assigned_at,
        "priority": request.priority,
        "package_category": request.package_category,
        "weight_kg": request.weight_kg,
        "quantity": request.quantity,
        "pickup_latitude": request.pickup_latitude if pickup is not None else np.nan,
        "pickup_longitude": request.pickup_longitude if pickup is not None else np.nan,
        "destination_latitude": request.destination_latitude if destination is not None else np.nan,
        "destination_longitude": request.destination_longitude if destination is not None else np.nan,
        "straight_line_distance_km": distance,
    }
    raw_features = pd.DataFrame([row])
    if feature_version == "v2":
        return build_v2_features(raw_features)
    return build_features(raw_features)


@app.get("/health", response_model=HealthResponse)
def health(
    service: DeliveryModelService = Depends(get_model_service),
    demo_service: DeliveryModelService = Depends(get_demo_model_service),
) -> JSONResponse:
    op_available = service.available
    demo_available = demo_service.available
    data: dict[str, Any] = {
        "status": "ok",
        "model_available": op_available,
        "model_version": service.model_version if op_available else None,
        "artifacts_loaded": service.artifacts_loaded,
    }
    if is_demo_enabled() or demo_available:
        data["operational_model_available"] = op_available
        data["operational_model_version"] = service.model_version if op_available else None
        data["demo_model_available"] = demo_available
        data["demo_model_version"] = demo_service.model_version if demo_available else None
    return JSONResponse(content=data)


@app.post("/predict", response_model=PredictionResponse)
def predict(
    request: DeliveryPredictionRequest,
    service: DeliveryModelService = Depends(get_model_service),
) -> PredictionResponse | JSONResponse:
    if not service.available:
        return unavailable_response(
            "Prediction is unavailable because no valid trained model artifact is installed."
        )

    try:
        features = make_model_features(request, service.feature_version)
        duration = service.predict(features)
    except Exception:
        # Avoid returning file paths, model internals, or request values in errors.
        return unavailable_response("Prediction is unavailable because model inference failed.")

    if duration is None or not math.isfinite(duration) or duration <= 0:
        return unavailable_response("Prediction is unavailable because the model returned an invalid result.")

    return PredictionResponse(
        predicted_duration_minutes=duration,
        model_version=service.model_version,
        prediction_status="available",
        message=f"Prediction generated by the installed trained model ({duration:.1f} minutes; version: {service.model_version}).",
    )


@app.post("/demo/predict", response_model=DemoPredictionResponse)
def demo_predict(
    request: DeliveryPredictionRequest,
    demo_service: DeliveryModelService = Depends(get_demo_model_service),
) -> DemoPredictionResponse | JSONResponse:
    if not is_demo_enabled():
        response = DemoPredictionResponse(
            predicted_duration_minutes=None,
            prediction_type="simulated_demo",
            model_version=None,
            prediction_status="unavailable",
            message="Demo prediction endpoint is disabled. Set ENABLE_DEMO_ENDPOINT=true to enable.",
        )
        return JSONResponse(status_code=503, content=response.model_dump())

    if not demo_service.available:
        response = DemoPredictionResponse(
            predicted_duration_minutes=None,
            prediction_type="simulated_demo",
            model_version=None,
            prediction_status="unavailable",
            message="Demo prediction is unavailable because no valid approved demo model artifact is installed.",
        )
        return JSONResponse(status_code=503, content=response.model_dump())

    try:
        features = make_model_features(request, demo_service.feature_version)
        duration = demo_service.predict(features)
    except Exception:
        response = DemoPredictionResponse(
            predicted_duration_minutes=None,
            prediction_type="simulated_demo",
            model_version=demo_service.model_version,
            prediction_status="unavailable",
            message="Demo prediction failed during inference.",
        )
        return JSONResponse(status_code=503, content=response.model_dump())

    if duration is None or not math.isfinite(duration) or duration <= 0:
        response = DemoPredictionResponse(
            predicted_duration_minutes=None,
            prediction_type="simulated_demo",
            model_version=demo_service.model_version,
            prediction_status="unavailable",
            message="Demo prediction returned an invalid result.",
        )
        return JSONResponse(status_code=503, content=response.model_dump())

    return DemoPredictionResponse(
        predicted_duration_minutes=duration,
        prediction_type="simulated_demo",
        model_version=demo_service.model_version,
        prediction_status="available",
        message=f"Simulated demo prediction generated by Synthetic v2 model ({duration:.1f} minutes; version: {demo_service.model_version}).",
    )

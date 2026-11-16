"""FastAPI service that ranks eligible agents by predicted duration."""

from __future__ import annotations

import hmac
import math
import os
from contextlib import asynccontextmanager
from typing import Any

import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .features import build_features
from .model_service import AgentRecommendationModel, model_service
from .schemas import RecommendationRequest, RecommendationResponse


API_KEY_ENV = "SMART_AGENT_ASSIGNMENT_API_KEY"
bearer_scheme = HTTPBearer(auto_error=False)


@asynccontextmanager
async def lifespan(_: FastAPI):
    model_service.load()
    yield


app = FastAPI(
    title="SWERV Smart Agent Assignment ML Service",
    version="0.1.0",
    description="Ranks already eligible agent candidates using a synthetic-data prototype model.",
    lifespan=lifespan,
)


def get_model_service() -> AgentRecommendationModel:
    return model_service


def require_api_key(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer_scheme),
) -> None:
    expected_key = os.getenv(API_KEY_ENV)
    if not expected_key or not expected_key.strip():
        raise HTTPException(
            status_code=503,
            detail="Prediction API authentication is not configured.",
        )
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="A valid Bearer token is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not hmac.compare_digest(
        credentials.credentials.encode("utf-8"),
        expected_key.encode("utf-8"),
    ):
        raise HTTPException(
            status_code=401,
            detail="A valid Bearer token is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )


def straight_line_distance_km(
    latitude_one: float | None,
    longitude_one: float | None,
    latitude_two: float | None,
    longitude_two: float | None,
) -> float | None:
    coordinates = (latitude_one, longitude_one, latitude_two, longitude_two)
    if any(value is None for value in coordinates):
        return None
    lat1, lon1, lat2, lon2 = [math.radians(float(value)) for value in coordinates]
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371.0088 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def make_candidate_features(request: RecommendationRequest) -> pd.DataFrame:
    dispatch = request.dispatch
    trip_distance = straight_line_distance_km(
        dispatch.pickup_latitude,
        dispatch.pickup_longitude,
        dispatch.destination_latitude,
        dispatch.destination_longitude,
    )
    rows: list[dict[str, Any]] = []
    for candidate in request.candidates:
        capacity = candidate.max_capacity
        rows.append({
            "recommendation_time": dispatch.recommendation_time,
            "priority": dispatch.priority,
            "package_category": dispatch.package_category,
            "weight_kg": dispatch.weight_kg,
            "quantity": dispatch.quantity,
            "pickup_to_destination_km": trip_distance,
            "agent_to_pickup_km": candidate.agent_to_pickup_km,
            "active_workload": candidate.active_workload,
            "max_capacity": capacity,
            "workload_ratio": candidate.active_workload / capacity,
            "vehicle_type": candidate.vehicle_type,
            "capability_profile": "|".join(sorted(candidate.capabilities)),
            "gps_fresh": int(candidate.gps_fresh),
            "completed_delivery_count": candidate.completed_delivery_count,
            "historical_median_minutes": candidate.historical_median_minutes,
        })
    return build_features(pd.DataFrame(rows))


@app.get("/health")
def health(service: AgentRecommendationModel = Depends(get_model_service)) -> dict[str, Any]:
    available = service.available
    return {
        "status": "ok",
        "model_available": available,
        "model_version": service.model_version if available else None,
        "training_source": "synthetic" if available else None,
        "provenance_note": "Synthetic prototype; real-world accuracy is not validated." if available else None,
    }


@app.post("/predict", response_model=RecommendationResponse)
def predict(
    request: RecommendationRequest,
    service: AgentRecommendationModel = Depends(get_model_service),
    _: None = Depends(require_api_key),
) -> RecommendationResponse:
    if not service.available:
        raise HTTPException(
            status_code=503,
            detail="Smart Agent Assignment model is unavailable; no recommendation prediction was made.",
        )
    predicted_durations = service.predict(make_candidate_features(request))
    if predicted_durations is None or len(predicted_durations) != len(request.candidates):
        raise HTTPException(status_code=503, detail="Smart Agent Assignment model could not produce valid predictions.")

    ranked = sorted(
        zip(request.candidates, predicted_durations, strict=True),
        key=lambda candidate_and_duration: candidate_and_duration[1],
    )
    predictions = [
        {
            "agent_id": candidate.agent_id,
            "agent_code": candidate.agent_code,
            "rank": index,
            "predicted_duration_minutes": round(float(duration), 1),
        }
        for index, (candidate, duration) in enumerate(ranked, start=1)
    ]
    return RecommendationResponse(
        dispatch_request_id=request.dispatch_request_id,
        prediction_status="available",
        model_version=service.model_version or "",
        training_source="synthetic",
        predictions=predictions,
    )

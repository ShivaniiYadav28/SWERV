"""Validated request and response shapes for the recommendation API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


Priority = Literal["standard", "express", "urgent"]
PackageCategory = Literal["documents", "parcel", "food", "fragile", "heavy_goods", "other"]
VehicleType = Literal["car", "van", "motorcycle", "truck", "bicycle"]
Capability = Literal[
    "parcel_delivery", "food_delivery", "document_delivery",
    "heavy_goods", "express_delivery",
]


class DispatchFeatures(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recommendation_time: datetime
    priority: Priority
    package_category: PackageCategory
    weight_kg: float = Field(gt=0, le=10_000, allow_inf_nan=False)
    quantity: int = Field(ge=1, le=1_000)
    pickup_latitude: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    pickup_longitude: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)
    destination_latitude: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    destination_longitude: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_assignment_time_and_coordinates(self) -> "DispatchFeatures":
        if self.recommendation_time.utcoffset() is None:
            raise ValueError("recommendation_time must include a timezone")
        for latitude, longitude, name in (
            (self.pickup_latitude, self.pickup_longitude, "pickup"),
            (self.destination_latitude, self.destination_longitude, "destination"),
        ):
            if (latitude is None) != (longitude is None):
                raise ValueError(f"{name} coordinates must be supplied as a pair")
        return self


class CandidateFeatures(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(min_length=1, max_length=100)
    agent_code: str = Field(min_length=1, max_length=50)
    is_active: bool
    agent_status: Literal["available"]
    vehicle_type: VehicleType
    capabilities: list[Capability]
    active_workload: int = Field(ge=0)
    max_capacity: int = Field(gt=0)
    gps_fresh: bool
    agent_to_pickup_km: float | None = Field(default=None, ge=0, le=25_000, allow_inf_nan=False)
    completed_delivery_count: int = Field(ge=0)
    historical_median_minutes: float | None = Field(default=None, gt=0, allow_inf_nan=False)


class RecommendationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dispatch_request_id: str = Field(min_length=1, max_length=100)
    dispatch: DispatchFeatures
    candidates: list[CandidateFeatures] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def validate_eligible_candidates(self) -> "RecommendationRequest":
        required_by_category = {
            "documents": "document_delivery",
            "parcel": "parcel_delivery",
            "food": "food_delivery",
            "fragile": "parcel_delivery",
            "heavy_goods": "heavy_goods",
            "other": "parcel_delivery",
        }
        required = {required_by_category[self.dispatch.package_category]}
        if self.dispatch.priority in ("express", "urgent"):
            required.add("express_delivery")
        ids = [candidate.agent_id for candidate in self.candidates]
        if len(set(ids)) != len(ids):
            raise ValueError("Candidate agent IDs must be unique")
        for candidate in self.candidates:
            if not candidate.is_active:
                raise ValueError("Only active eligible candidates can be scored")
            if candidate.active_workload >= candidate.max_capacity:
                raise ValueError("Candidates must have available capacity")
            if not required.issubset(set(candidate.capabilities)):
                raise ValueError("Candidate does not have the required package and priority capabilities")
            if not candidate.gps_fresh and candidate.agent_to_pickup_km is not None:
                raise ValueError("Agent-to-pickup distance requires fresh GPS data")
            if candidate.completed_delivery_count < 10 and candidate.historical_median_minutes is not None:
                raise ValueError("Historical median requires at least 10 completed deliveries")
        return self


class CandidatePrediction(BaseModel):
    agent_id: str
    agent_code: str
    rank: int
    predicted_duration_minutes: float


class RecommendationResponse(BaseModel):
    dispatch_request_id: str
    prediction_status: Literal["available"]
    model_version: str
    training_source: Literal["synthetic"]
    predictions: list[CandidatePrediction]

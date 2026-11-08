"""Request and response schemas for the local prediction API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


Priority = Literal["standard", "express", "urgent"]
PackageCategory = Literal["documents", "parcel", "food", "fragile", "heavy_goods", "other"]


class DeliveryPredictionRequest(BaseModel):
    """Features known when a delivery is assigned to an agent."""

    model_config = ConfigDict(extra="forbid")

    request_created_at: datetime
    assigned_at: datetime
    priority: Priority
    package_category: PackageCategory
    weight_kg: float = Field(gt=0, le=10_000, allow_inf_nan=False)
    quantity: int = Field(ge=1, le=1_000)
    pickup_latitude: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    pickup_longitude: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)
    destination_latitude: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    destination_longitude: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_prediction_time_fields(self) -> "DeliveryPredictionRequest":
        for field_name in ("request_created_at", "assigned_at"):
            if getattr(self, field_name).utcoffset() is None:
                raise ValueError(f"{field_name} must include a timezone")
        if self.assigned_at < self.request_created_at:
            raise ValueError("assigned_at cannot be before request_created_at")

        coordinate_pairs = (
            (self.pickup_latitude, self.pickup_longitude, "pickup"),
            (self.destination_latitude, self.destination_longitude, "destination"),
        )
        for latitude, longitude, location_name in coordinate_pairs:
            if (latitude is None) != (longitude is None):
                raise ValueError(f"{location_name} latitude and longitude must be provided together")
        return self


class HealthResponse(BaseModel):
    status: Literal["ok"]
    model_available: bool
    model_version: str | None


class PredictionResponse(BaseModel):
    predicted_duration_minutes: float | None
    model_version: str | None
    prediction_status: Literal["available", "unavailable"]
    message: str

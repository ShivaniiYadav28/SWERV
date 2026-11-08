"""Validated request and response schemas for hourly demand forecasts."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, Field, StrictInt, field_validator


HISTORY_HOURS_REQUIRED = 24 * 7
MAX_FORECAST_PERIODS = 24 * 7


class DemandForecastRequest(BaseModel):
    """Input containing recent observed counts and the forecast horizon."""

    forecast_start_timestamp: datetime
    forecast_periods: int = Field(strict=True, ge=1, le=MAX_FORECAST_PERIODS)
    historical_request_counts: list[StrictInt]

    @field_validator("forecast_start_timestamp")
    @classmethod
    def validate_forecast_start(cls, value: datetime) -> datetime:
        if value.utcoffset() is None or value.utcoffset() != timedelta(0):
            raise ValueError("forecast_start_timestamp must include a UTC timezone.")
        if value.minute or value.second or value.microsecond:
            raise ValueError("forecast_start_timestamp must be aligned to the start of an hour.")
        return value

    @field_validator("historical_request_counts")
    @classmethod
    def validate_history(cls, values: list[int]) -> list[int]:
        if len(values) != HISTORY_HOURS_REQUIRED:
            raise ValueError(
                f"Exactly {HISTORY_HOURS_REQUIRED} prior hourly counts are required."
            )
        if any(value < 0 for value in values):
            raise ValueError("Historical request counts must be non-negative integers.")
        return values


class HourlyDemandPrediction(BaseModel):
    timestamp: datetime
    request_count: int = Field(ge=0)


class DemandForecastResponse(BaseModel):
    forecast_start_timestamp: datetime
    forecast_periods: int
    predictions: list[HourlyDemandPrediction]
    model_version: str
    training_source: Literal["synthetic"]
    synthetic_provenance: str


class DemandHealthResponse(BaseModel):
    status: Literal["ok"]
    model_available: bool
    model_version: str | None
    training_source: Literal["synthetic"] | None
    synthetic_provenance: str

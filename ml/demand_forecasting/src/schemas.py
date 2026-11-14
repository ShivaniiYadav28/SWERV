"""Validated request and response schemas for hourly demand forecasts."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


MAX_FORECAST_PERIODS = 24 * 7


class DemandForecastRequest(BaseModel):
    """Input containing the forecast start and horizon."""

    model_config = ConfigDict(extra="forbid")
    forecast_start_timestamp: datetime
    forecast_periods: int = Field(strict=True, ge=1, le=MAX_FORECAST_PERIODS)

    @field_validator("forecast_start_timestamp")
    @classmethod
    def validate_forecast_start(cls, value: datetime) -> datetime:
        if value.utcoffset() is None or value.utcoffset() != timedelta(0):
            raise ValueError("forecast_start_timestamp must include a UTC timezone.")
        if value.minute or value.second or value.microsecond:
            raise ValueError("forecast_start_timestamp must be aligned to the start of an hour.")
        return value


class HourlyDemandPrediction(BaseModel):
    timestamp: datetime
    request_count: int = Field(ge=0)


class DemandForecastResponse(BaseModel):
    forecast_start_timestamp: datetime
    forecast_periods: int
    predictions: list[HourlyDemandPrediction]
    model_version: str
    history_source: Literal["synthetic_hourly_demand.csv"]
    history_provenance: str
    training_source: Literal["synthetic"]
    synthetic_provenance: str


class DemandHealthResponse(BaseModel):
    status: Literal["ok"]
    model_available: bool
    model_version: str | None
    synthetic_history_available: bool
    training_source: Literal["synthetic"] | None
    synthetic_provenance: str

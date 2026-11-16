"""Strict request and response schemas for anomaly predictions."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt


NumericValue = StrictFloat | StrictInt | None
BinaryValue = Annotated[StrictInt, Field(ge=0, le=1)]


class ScenarioFeatures(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gps_distance_km: Annotated[NumericValue, Field(ge=0, le=1000)]
    gps_interval_minutes: Annotated[NumericValue, Field(ge=0, le=1440)]
    implied_speed_kmh: Annotated[NumericValue, Field(ge=0, le=2000)]
    gps_reported_speed_kmh: Annotated[NumericValue, Field(ge=0, le=2000)]
    gps_accuracy_meters: Annotated[NumericValue, Field(ge=0, le=100_000)]
    gps_freshness_minutes: Annotated[NumericValue, Field(ge=0, le=10_080)]
    gps_coordinates_valid: BinaryValue | None
    gps_timestamps_valid: BinaryValue | None
    gps_pair_available: BinaryValue
    expected_delivery_duration_minutes: Annotated[NumericValue, Field(ge=0, le=100_000)]
    reassignment_count: Annotated[StrictInt, Field(ge=0, le=100)]
    assignment_event_count: Annotated[StrictInt, Field(ge=0, le=101)]
    activity_history_complete: BinaryValue
    delivery_duration_minutes: Annotated[NumericValue, Field(ge=0, le=100_000)]
    delivery_delay_minutes: Annotated[NumericValue, Field(ge=0, le=100_000)]
    expected_delivery_distance_km: Annotated[NumericValue, Field(ge=0, le=10_000)]
    delivery_distance_km: Annotated[NumericValue, Field(ge=0, le=10_000)]
    planned_route_distance_km: Annotated[NumericValue, Field(ge=0, le=10_000)]
    actual_route_distance_km: Annotated[NumericValue, Field(ge=0, le=10_000)]
    route_deviation_ratio: Annotated[NumericValue, Field(ge=0, le=10_000)]
    distance_to_expected_ratio: Annotated[NumericValue, Field(ge=0, le=10_000)]
    failed_delivery_attempts: Annotated[StrictInt, Field(ge=0, le=1000)]
    agent_failed_deliveries_7d: Annotated[StrictInt, Field(ge=0, le=10_000)]
    status_event_count: Annotated[StrictInt, Field(ge=0, le=1000)]
    status_transition_valid: BinaryValue | None
    agent_status_change_count: Annotated[StrictInt, Field(ge=0, le=10_000)]
    agent_activity_ratio: Annotated[NumericValue, Field(ge=0, le=10_000)]
    agent_active_workload: Annotated[StrictInt, Field(ge=0, le=10_000)]
    dispatch_burst_count_10m: Annotated[StrictInt, Field(ge=0, le=10_000)]
    dispatch_repeat_route_count_1h: Annotated[StrictInt, Field(ge=0, le=10_000)]
    dispatch_creation_hour: Annotated[StrictInt, Field(ge=0, le=23)] | None
    data_quality_issue_count: Annotated[StrictInt, Field(ge=0, le=1000)]
    priority: Literal["standard", "express", "urgent"]
    package_category: Literal["documents", "parcel", "food", "fragile", "heavy_goods", "other"]
    vehicle_type: Literal["car", "van", "motorcycle", "truck", "bicycle"] | None


class ScenarioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    features: ScenarioFeatures


class DetectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detection_mode: Literal["synthetic_demo"]
    scenarios: Annotated[list[ScenarioRequest], Field(min_length=1, max_length=100)]

class DemoAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


Severity = Literal["none", "low", "medium", "high", "critical"]
ScenarioCategory = Literal[
    "normal",
    "delivery_delay",
    "gps_coordinate_jump",
    "route_deviation",
    "repeated_delivery_failures",
    "unusual_agent_activity",
    "suspicious_dispatch_pattern",
    "abnormal_delivery_duration",
    "abnormal_delivery_distance",
]


class AnomalyResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario_index: int = Field(ge=0)
    scenario_id: str = Field(min_length=1, max_length=100)
    anomaly_score: float = Field(allow_inf_nan=False)
    is_anomaly: bool
    decision_threshold: float = Field(allow_inf_nan=False)
    severity: Severity
    scenario_category: ScenarioCategory | None
    scenario_category_source: Literal["generated_demo_label"] | None
    scenario_category_is_model_prediction: Literal[False]
    explanation: str = Field(min_length=1, max_length=1000)
    timestamp: datetime


class DetectionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detection_mode: Literal["synthetic_demo"]
    results: list[AnomalyResult]
    scenario_count: int = Field(ge=0)
    candidate_count: int = Field(ge=0)
    model_name: str
    model_version: str
    training_data_source: Literal["synthetic"]
    demonstration_provenance: str
    generated_at: datetime


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["ok"]
    model_available: bool
    model_version: str | None
    artifact_integrity_status: Literal["verified", "failed", "unavailable"]
    feature_schema_compatible: bool
    demo_data_available: bool
    training_data_source: Literal["synthetic"] | None
    training_provenance: str

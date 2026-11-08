"""Strict request and response schemas for anomaly predictions."""

from __future__ import annotations

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
    reassignment_count: Annotated[StrictInt, Field(ge=0, le=100)]
    assignment_event_count: Annotated[StrictInt, Field(ge=0, le=101)]
    activity_history_complete: BinaryValue
    delivery_duration_minutes: Annotated[NumericValue, Field(ge=0, le=100_000)]
    status_event_count: Annotated[StrictInt, Field(ge=0, le=1000)]
    status_transition_valid: BinaryValue | None
    agent_status_change_count: Annotated[StrictInt, Field(ge=0, le=10_000)]
    agent_active_workload: Annotated[StrictInt, Field(ge=0, le=10_000)]
    dispatch_creation_hour: Annotated[StrictInt, Field(ge=0, le=23)] | None
    data_quality_issue_count: Annotated[StrictInt, Field(ge=0, le=1000)]
    priority: Literal["standard", "express", "urgent"]
    package_category: Literal["documents", "parcel", "food", "fragile", "heavy_goods", "other"]
    vehicle_type: Literal["car", "van", "motorcycle", "truck", "bicycle"] | None


class ScenarioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    features: ScenarioFeatures
    duration_baseline_count: Annotated[StrictInt, Field(ge=0, le=1_000_000)] = 0


class DetectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detection_mode: Literal["real", "synthetic_demo"]
    scenarios: Annotated[list[ScenarioRequest], Field(min_length=1, max_length=100)]
    dispatches: Annotated[list["DispatchRecord"], Field(max_length=1000)] = Field(default_factory=list)
    dispatch_activities: Annotated[list["DispatchActivityRecord"], Field(max_length=20_000)] = Field(default_factory=list)
    gps_locations: Annotated[list["GpsLocationRecord"], Field(max_length=20_000)] = Field(default_factory=list)
    complete_activity_history_ids: list[str] = Field(default_factory=list)


class DispatchRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    dispatch_id: str = Field(alias="_id", min_length=1, max_length=100)
    status: Literal["pending", "assigned", "picked_up", "in_transit", "delivered", "cancelled", "failed"]
    assigned_agent: str | None = Field(default=None, alias="assignedAgent", max_length=100)


class ActivityValue(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    status: str | None = None
    agent_id: str | None = Field(default=None, alias="agentId", max_length=100)


class DispatchActivityRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    dispatch_request_id: str = Field(alias="dispatchRequestId", min_length=1, max_length=100)
    event_type: Literal["request_created", "assignment_changed", "status_changed", "locations_changed"] = Field(alias="eventType")
    created_at: str | None = Field(default=None, alias="createdAt")
    previous_value: ActivityValue | None = Field(default=None, alias="previousValue")
    new_value: ActivityValue | None = Field(default=None, alias="newValue")


class GpsLocationRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    agent_id: str | None = Field(default=None, alias="agentId", max_length=100)
    latitude: NumericValue = None
    longitude: NumericValue = None
    accuracy: NumericValue = None
    recorded_at: str | None = Field(default=None, alias="recordedAt")
    received_at: str | None = Field(default=None, alias="receivedAt")


class ScenarioPrediction(BaseModel):
    scenario_index: int
    is_anomaly_candidate: bool
    anomaly_score: float
    predicted_category: str | None
    model_name: str
    model_version: str
    detection_method: str
    detection_mode: Literal["real", "synthetic_demo"]
    model_type: Literal["supervised", "unsupervised"]
    input_data_source: Literal["real", "synthetic_demo"]
    training_data_source: Literal["synthetic"]
    synthetic_provenance: str
    data_quality_notes: list[str]


class RuleFindingResponse(BaseModel):
    anomaly_type: str
    severity: str
    dispatch_id: str | None = None
    agent_id: str | None = None
    evidence_timestamp: str | None
    explanation: str
    measured_value: float | int | str | None
    threshold: float | int | str | list[str] | None
    detection_method: str
    data_quality_notes: list[str]


class DetectionResponse(BaseModel):
    detection_mode: Literal["real", "synthetic_demo"]
    results: list[ScenarioPrediction]
    rule_based_findings: list[RuleFindingResponse]
    rule_based_limitations: list[str]
    model_name: str
    model_version: str
    training_data_source: Literal["synthetic"]
    synthetic_provenance: str


class HealthResponse(BaseModel):
    status: Literal["ok"]
    model_available: bool
    model_name: str | None
    model_version: str | None
    model_type: Literal["supervised", "unsupervised"] | None
    training_data_source: Literal["synthetic"] | None
    synthetic_provenance: str


DetectionRequest.model_rebuild()

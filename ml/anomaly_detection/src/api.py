"""FastAPI service for explicitly requested anomaly scoring."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request

from .detectors import detect_anomalies
from .model_service import ModelUnavailableError, load_model_artifact, score_scenario
from .schemas import (
    DetectionRequest,
    DetectionResponse,
    HealthResponse,
    ScenarioPrediction,
)


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_PATH = WORKSPACE / "models" / "synthetic" / "anomaly_detector.joblib"
SYNTHETIC_PROVENANCE = (
    "Model trained on generated synthetic anomaly scenarios; real-world SWERV accuracy is not validated."
)


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """Load the saved artifact once when the service starts."""
    try:
        application.state.model_artifact = load_model_artifact(MODEL_PATH)
    except ModelUnavailableError:
        application.state.model_artifact = None
    yield
    application.state.model_artifact = None


app = FastAPI(
    title="SWERV AI Anomaly Detection",
    version="0.1.0",
    description="Synthetic-trained anomaly candidate scoring; not real-world validated.",
    lifespan=lifespan,
)


def restrict_unsupported_category(
    result: dict[str, Any],
    feature_values: dict[str, Any],
    duration_baseline_count: int,
) -> None:
    """Keep synthetic model candidates within the rule engine's hard checks."""
    category = result["predicted_category"]
    if not result["is_anomaly_candidate"] or category is None:
        return

    supported = True
    note = ""
    if category == "gps_implausible_jump":
        supported = (
            feature_values["gps_pair_available"] == 1
            and feature_values["gps_coordinates_valid"] == 1
            and feature_values["gps_timestamps_valid"] == 1
            and feature_values["gps_freshness_minutes"] is not None
            and feature_values["gps_freshness_minutes"] <= 10
            and feature_values["gps_accuracy_meters"] is not None
            and feature_values["gps_accuracy_meters"] <= 100
            and feature_values["gps_interval_minutes"] is not None
            and feature_values["gps_interval_minutes"] <= 15
        )
        note = "GPS movement category withheld because the GPS pair is missing, stale, inaccurate, or too widely spaced."
    elif category == "gps_invalid_coordinates":
        supported = feature_values["gps_coordinates_valid"] == 0
        note = "Coordinate anomaly category withheld because the input does not contain invalid coordinates."
    elif category == "gps_stale_update":
        supported = (
            feature_values["gps_freshness_minutes"] is not None
            and feature_values["gps_freshness_minutes"] > 10
        )
        note = "Stale GPS category withheld because the supplied timestamp freshness is within the current limit."
    elif category == "repeated_dispatch_reassignment":
        supported = (
            feature_values["activity_history_complete"] == 1
            and feature_values["reassignment_count"] >= 2
        )
        note = "Reassignment category withheld because complete activity history or the repeat threshold is missing."
    elif category == "unusual_delivery_duration":
        supported = duration_baseline_count >= 30
        note = "Duration category withheld because fewer than 30 valid historical deliveries are available for a baseline."
    elif category == "invalid_status_transition":
        supported = feature_values["status_transition_valid"] == 0
        note = "Status category withheld because no invalid status transition was supplied."

    if not supported:
        result["is_anomaly_candidate"] = False
        result["predicted_category"] = None
        result["data_quality_notes"].append(note)


@app.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    artifact = getattr(request.app.state, "model_artifact", None)
    return HealthResponse(
        status="ok",
        model_available=artifact is not None,
        model_name=artifact["model_name"] if artifact else None,
        model_version=artifact["model_version"] if artifact else None,
        model_type=artifact["detection_mode"] if artifact else None,
        training_data_source="synthetic" if artifact else None,
        synthetic_provenance=SYNTHETIC_PROVENANCE,
    )


@app.post("/predict", response_model=DetectionResponse)
def predict(request_body: DetectionRequest, request: Request) -> DetectionResponse:
    artifact = getattr(request.app.state, "model_artifact", None)
    if artifact is None:
        raise HTTPException(
            status_code=503,
            detail="Anomaly model is unavailable; no predictions were generated.",
        )

    results: list[ScenarioPrediction] = []
    for index, scenario in enumerate(request_body.scenarios):
        feature_values = scenario.features.model_dump()
        try:
            result = score_scenario(feature_values, artifact)
            restrict_unsupported_category(
                result,
                feature_values,
                scenario.duration_baseline_count,
            )
        except Exception as error:
            raise HTTPException(
                status_code=503,
                detail="Anomaly model could not score the supplied scenario.",
            ) from error

        if request_body.detection_mode == "real":
            result["data_quality_notes"].append(
                "Real input was scored by a model trained only on synthetic scenarios; real-world accuracy is unvalidated."
            )
        results.append(ScenarioPrediction(
            scenario_index=index,
            is_anomaly_candidate=result["is_anomaly_candidate"],
            anomaly_score=result["anomaly_score"],
            predicted_category=result["predicted_category"],
            model_name=result["model_name"],
            model_version=result["model_version"],
            detection_method="machine_learning",
            detection_mode=request_body.detection_mode,
            model_type=result["detection_mode"],
            input_data_source=request_body.detection_mode,
            training_data_source="synthetic",
            synthetic_provenance=result["synthetic_provenance"],
            data_quality_notes=result["data_quality_notes"],
        ))

    has_rule_inputs = bool(
        request_body.dispatches
        or request_body.dispatch_activities
        or request_body.gps_locations
    )
    if has_rule_inputs:
        rule_report = detect_anomalies(
            [row.model_dump(by_alias=True) for row in request_body.dispatches],
            [row.model_dump(by_alias=True) for row in request_body.dispatch_activities],
            [row.model_dump(by_alias=True) for row in request_body.gps_locations],
            complete_activity_history_ids=set(request_body.complete_activity_history_ids),
        ).to_dict()
    else:
        rule_report = {
            "findings": [],
            "limitations": ["No raw dispatch activity or GPS history was supplied; rule-based checks were not run."],
        }

    return DetectionResponse(
        detection_mode=request_body.detection_mode,
        results=results,
        rule_based_findings=rule_report["findings"],
        rule_based_limitations=rule_report["limitations"],
        model_name=artifact["model_name"],
        model_version=artifact["model_version"],
        training_data_source="synthetic",
        synthetic_provenance=SYNTHETIC_PROVENANCE,
    )

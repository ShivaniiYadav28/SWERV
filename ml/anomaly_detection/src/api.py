"""Standalone FastAPI service for Isolation Forest anomaly scoring."""

from __future__ import annotations

import hmac
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import pandas as pd
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from .model_service import (
    EXPECTED_MODEL_VERSION,
    InvalidScenarioError,
    ModelUnavailableError,
    load_model_artifact,
    score_scenario,
)
from .schemas import (
    AnomalyResult,
    DetectionRequest,
    DetectionResponse,
    DemoAnalysisRequest,
    HealthResponse,
    ScenarioFeatures,
    ScenarioCategory,
    Severity,
)
from .synthetic_dataset import (
    ANOMALY_WEIGHTS,
    CATEGORICAL_FEATURES,
    DATA_SOURCE,
    FEATURE_COLUMNS,
    NUMERIC_FEATURES,
    PROJECT_ROOT,
)


logger = logging.getLogger(__name__)
MODEL_PATH = PROJECT_ROOT / "models" / "synthetic" / "anomaly_detector.joblib"
MODEL_METADATA_PATH = PROJECT_ROOT / "models" / "synthetic" / "anomaly_detector.metadata.json"
DEMO_DATA_PATH = PROJECT_ROOT / "data" / "processed" / "synthetic" / "synthetic_demo.csv"
DATASET_METADATA_PATH = PROJECT_ROOT / "data" / "processed" / "synthetic" / "synthetic_dataset_metadata.json"
API_KEY_ENVIRONMENT_VARIABLE = "ANOMALY_DETECTION_API_KEY"
MAX_REQUEST_BODY_BYTES = 256_000
MAX_PREDICTION_SCENARIOS = 100
DEMO_SCENARIO_COUNT = 30
TRAINING_PROVENANCE = (
    "Isolation Forest trained on generated anomaly scenarios; evaluation does not establish real-world SWERV accuracy."
)
DEMONSTRATION_PROVENANCE = (
    "Scenarios are generated demonstration data. Their category is a dataset label, "
    "not an Isolation Forest prediction; results are not confirmed operational incidents."
)
SEVERITY_SCORE_MARGINS = (0.01, 0.04, 0.10)
INTEGER_FEATURES = {
    "gps_coordinates_valid", "gps_timestamps_valid", "gps_pair_available",
    "reassignment_count", "assignment_event_count", "activity_history_complete",
    "failed_delivery_attempts", "agent_failed_deliveries_7d", "status_event_count",
    "status_transition_valid", "agent_status_change_count", "agent_active_workload",
    "dispatch_burst_count_10m", "dispatch_repeat_route_count_1h",
    "dispatch_creation_hour", "data_quality_issue_count",
}


class DemoDataUnavailableError(RuntimeError):
    """Raised when the isolated generated demonstration data is invalid or absent."""


def load_demo_scenarios(
    dataset_path: Path = DEMO_DATA_PATH,
    metadata_path: Path = DATASET_METADATA_PATH,
) -> list[dict[str, Any]]:
    """Load a deterministic, category-covered sample from the service-owned demo split."""
    try:
        metadata = pd.read_json(metadata_path, typ="series").to_dict()
        frame = pd.read_csv(dataset_path)
    except Exception as error:
        raise DemoDataUnavailableError("The generated demonstration dataset is unavailable.") from error

    required_columns = {
        *FEATURE_COLUMNS, "scenario_id", "anomaly_type", "data_source", "dataset_split",
    }
    if (
        metadata.get("data_source") != DATA_SOURCE
        or metadata.get("synthetic_only") is not True
        or metadata.get("real_world_accuracy_claim") is not False
        or metadata.get("feature_columns") != FEATURE_COLUMNS
        or not required_columns.issubset(frame.columns)
        or frame.empty
        or not (frame["data_source"] == DATA_SOURCE).all()
        or not (frame["dataset_split"] == "demo").all()
        or frame["scenario_id"].isna().any()
        or frame["scenario_id"].duplicated().any()
        or set(frame["anomaly_type"].unique()) != set(ANOMALY_WEIGHTS)
    ):
        raise DemoDataUnavailableError("The generated demonstration dataset failed validation.")

    category_order = ["normal", *(category for category in ANOMALY_WEIGHTS if category != "normal")]
    selected_indices: list[int] = []
    for category in category_order:
        matching = frame.index[frame["anomaly_type"] == category]
        if len(matching):
            selected_indices.append(int(matching[0]))
    for index in frame.index:
        if len(selected_indices) >= DEMO_SCENARIO_COUNT:
            break
        if int(index) not in selected_indices:
            selected_indices.append(int(index))

    selected: list[dict[str, Any]] = []
    for index in selected_indices:
        row = frame.loc[index]
        features: dict[str, Any] = {}
        for column in FEATURE_COLUMNS:
            value = row[column]
            if pd.isna(value):
                features[column] = None
            elif column in CATEGORICAL_FEATURES:
                features[column] = str(value)
            elif column in INTEGER_FEATURES:
                features[column] = int(value)
            else:
                features[column] = float(value)
        validated_features = ScenarioFeatures.model_validate(features).model_dump()
        selected.append({
            "scenario_id": str(row["scenario_id"]),
            "scenario_category": str(row["anomaly_type"]),
            "features": validated_features,
        })
    return selected


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """Load the pinned model and isolated demo scenarios once at startup."""
    artifact: dict[str, Any] | None = None
    integrity_status = "unavailable"
    schema_compatible = False
    try:
        artifact = load_model_artifact(MODEL_PATH, MODEL_METADATA_PATH)
        integrity_status = "verified"
        schema_compatible = True
    except ModelUnavailableError as error:
        integrity_status = error.artifact_integrity_status
        schema_compatible = error.feature_schema_compatible
        logger.error(
            "Anomaly model unavailable (integrity_status=%s, feature_schema_compatible=%s)",
            integrity_status,
            schema_compatible,
        )

    try:
        demo_scenarios = load_demo_scenarios()
        demo_data_available = True
    except DemoDataUnavailableError as error:
        logger.warning("Anomaly demo data unavailable (error_type=%s)", type(error).__name__)
        demo_scenarios = []
        demo_data_available = False

    application.state.model_artifact = artifact
    application.state.artifact_integrity_status = integrity_status
    application.state.feature_schema_compatible = schema_compatible
    application.state.demo_scenarios = demo_scenarios
    application.state.demo_data_available = demo_data_available
    yield
    application.state.model_artifact = None
    application.state.demo_scenarios = []


app = FastAPI(
    title="SWERV AI Anomaly Detection",
    version="0.2.0",
    description=(
        "An authenticated, feature-only Isolation Forest service with an internal generated-demo workflow. "
        "It does not connect to MongoDB or accept operational record structures."
    ),
    lifespan=lifespan,
)


@app.middleware("http")
async def limit_request_body(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length is not None:
        if not content_length.isdecimal():
            return JSONResponse(status_code=400, content={"detail": "Invalid content length."})
        if int(content_length) > MAX_REQUEST_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Request body exceeds the allowed size."})
    return await call_next(request)


def require_service_auth(authorization: str | None = Header(default=None)) -> None:
    """Require the backend's shared Bearer credential without logging or echoing it."""
    expected_key = os.getenv(API_KEY_ENVIRONMENT_VARIABLE, "").strip()
    if len(expected_key) < 32:
        raise HTTPException(status_code=503, detail="Anomaly service authentication is not configured.")

    scheme, separator, supplied_key = (authorization or "").partition(" ")
    if (
        scheme.lower() != "bearer"
        or not separator
        or not hmac.compare_digest(supplied_key.strip(), expected_key)
    ):
        raise HTTPException(status_code=401, detail="A valid service credential is required.")


def classify_severity(anomaly_score: float, decision_threshold: float) -> Severity:
    """Map non-probabilistic score excess into documented review-priority bands."""
    if anomaly_score < decision_threshold:
        return "none"
    excess = anomaly_score - decision_threshold
    if excess < SEVERITY_SCORE_MARGINS[0]:
        return "low"
    if excess < SEVERITY_SCORE_MARGINS[1]:
        return "medium"
    if excess < SEVERITY_SCORE_MARGINS[2]:
        return "high"
    return "critical"


def score_feature_scenario(
    features: dict[str, Any],
    artifact: dict[str, Any],
    scenario_index: int,
    scenario_id: str,
    scenario_category: ScenarioCategory | None,
    timestamp: datetime,
) -> AnomalyResult:
    try:
        scored = score_scenario(features, artifact)
    except InvalidScenarioError as error:
        raise HTTPException(status_code=422, detail="Scenario features failed model validation.") from error
    except Exception as error:
        logger.error("Anomaly scoring failed (error_type=%s)", type(error).__name__)
        raise HTTPException(status_code=503, detail="The anomaly model could not score this scenario.") from error

    score = float(scored["anomaly_score"])
    threshold = float(artifact["threshold"])
    is_anomaly = bool(scored["is_anomaly_candidate"])
    severity = classify_severity(score, threshold)
    if is_anomaly:
        explanation = (
            f"Isolation Forest score {score:.6f} exceeds the decision threshold {threshold:.6f} "
            f"by {score - threshold:.6f}."
        )
    else:
        explanation = (
            f"Isolation Forest score {score:.6f} is at or below the decision threshold {threshold:.6f}; "
            "no anomaly candidate was produced."
        )
    category_source = None
    if scenario_category is not None:
        category_source = "generated_demo_label"
        explanation += " Scenario category is a generated dataset label, not a model prediction."

    return AnomalyResult(
        scenario_index=scenario_index,
        scenario_id=scenario_id,
        anomaly_score=score,
        is_anomaly=is_anomaly,
        decision_threshold=threshold,
        severity=severity,
        scenario_category=scenario_category,
        scenario_category_source=category_source,
        scenario_category_is_model_prediction=False,
        explanation=explanation,
        timestamp=timestamp,
    )


def require_model(request: Request) -> dict[str, Any]:
    artifact = getattr(request.app.state, "model_artifact", None)
    if artifact is None:
        raise HTTPException(status_code=503, detail="Anomaly model is unavailable; no predictions were generated.")
    return artifact


def make_response(results: list[AnomalyResult], artifact: dict[str, Any], generated_at: datetime) -> DetectionResponse:
    return DetectionResponse(
        detection_mode="synthetic_demo",
        results=results,
        scenario_count=len(results),
        candidate_count=sum(result.is_anomaly for result in results),
        model_name=artifact["model_name"],
        model_version=artifact["model_version"],
        training_data_source=DATA_SOURCE,
        demonstration_provenance=DEMONSTRATION_PROVENANCE,
        generated_at=generated_at,
    )


@app.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    artifact = getattr(request.app.state, "model_artifact", None)
    return HealthResponse(
        status="ok",
        model_available=artifact is not None,
        model_version=artifact["model_version"] if artifact else None,
        artifact_integrity_status=request.app.state.artifact_integrity_status,
        feature_schema_compatible=request.app.state.feature_schema_compatible,
        demo_data_available=request.app.state.demo_data_available,
        training_data_source=DATA_SOURCE if artifact else None,
        training_provenance=artifact["synthetic_provenance"] if artifact else TRAINING_PROVENANCE,
    )


@app.post(
    "/predict",
    response_model=DetectionResponse,
    dependencies=[Depends(require_service_auth)],
)
def predict(request_body: DetectionRequest, request: Request) -> DetectionResponse:
    artifact = require_model(request)
    generated_at = datetime.now(timezone.utc)
    results = [
        score_feature_scenario(
            scenario.features.model_dump(),
            artifact,
            index,
            f"prediction-{index + 1:04d}",
            None,
            generated_at,
        )
        for index, scenario in enumerate(request_body.scenarios)
    ]
    return make_response(results, artifact, generated_at)


@app.post(
    "/analyze-demo",
    response_model=DetectionResponse,
    dependencies=[Depends(require_service_auth)],
)
def analyze_demo(
    request: Request,
    request_body: DemoAnalysisRequest = Body(default={}),
) -> DetectionResponse:
    del request_body
    artifact = require_model(request)
    if not request.app.state.demo_data_available:
        raise HTTPException(status_code=503, detail="Generated anomaly demo data is unavailable.")
    generated_at = datetime.now(timezone.utc)
    results = [
        score_feature_scenario(
            scenario["features"],
            artifact,
            index,
            scenario["scenario_id"],
            scenario["scenario_category"],
            generated_at,
        )
        for index, scenario in enumerate(request.app.state.demo_scenarios)
    ]
    return make_response(results, artifact, generated_at)
"""Build a privacy-conscious delivery-time dataset from SWERV MongoDB."""

from __future__ import annotations

import argparse
import json
import math
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from numbers import Real
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from pymongo import MongoClient


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = WORKSPACE_ROOT.parents[1]
DEFAULT_OUTPUT_DIR = WORKSPACE_ROOT / "data" / "processed"
TARGET_COLUMN = "delivery_duration_minutes"
EARTH_RADIUS_KM = 6371.0088
MINIMUM_TRAINING_RECORDS = 200
MINIMUM_CHRONOLOGICAL_TEST_RECORDS = 40
CHRONOLOGICAL_TEST_FRACTION = 0.20

# Explicit projections keep contact details, addresses, instructions, and other
# unrelated or sensitive values out of the pipeline's in-memory documents.
REQUEST_PROJECTION = {
    "_id": 1,
    "status": 1,
    "createdAt": 1,
    "assignedAgent": 1,
    "priority": 1,
    "pickup.latitude": 1,
    "pickup.longitude": 1,
    "delivery.latitude": 1,
    "delivery.longitude": 1,
    "package.category": 1,
    "package.weightKg": 1,
    "package.quantity": 1,
}
ACTIVITY_PROJECTION = {
    "_id": 0,
    "dispatchRequestId": 1,
    "eventType": 1,
    "createdAt": 1,
    "newValue.status": 1,
    "newValue.agentId": 1,
    "newValue.coordinates": 1,
    "previousValue.agentId": 1,
}

FEATURE_COLUMNS = [
    "request_created_at",
    "assigned_at",
    "priority",
    "package_category",
    "weight_kg",
    "quantity",
    "pickup_latitude",
    "pickup_longitude",
    "destination_latitude",
    "destination_longitude",
    "straight_line_distance_km",
]


class InvalidDelivery(ValueError):
    """A completed request that cannot produce a trustworthy label."""


def parse_timestamp(value: Any, field_name: str) -> datetime:
    """Return a timezone-aware UTC timestamp or raise for invalid input."""
    if not isinstance(value, datetime):
        raise InvalidDelivery(f"missing_or_invalid_{field_name}")
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def activity_timestamp(activity: dict[str, Any]) -> datetime:
    return parse_timestamp(activity.get("createdAt"), "activity_timestamp")


def read_activity_value(value: Any, field_name: str) -> Any:
    """Read a value from the activity's flexible Mixed event payload safely."""
    if not isinstance(value, dict):
        return None
    return value.get(field_name)


def find_delivery_events(
    request: dict[str, Any], activities: list[dict[str, Any]]
) -> tuple[datetime, datetime, datetime, datetime, dict[str, Any]]:
    """Find the assignment, pickup, and delivery events for this delivery.

    Reassignments are resolved by choosing the latest assignment before pickup.
    The chosen event must identify the request's final assigned agent.
    """
    request_id = request.get("_id")
    matching = [
        activity
        for activity in activities
        if activity.get("dispatchRequestId") == request_id
    ]

    allowed_statuses = {"assigned", "picked_up", "in_transit", "delivered"}
    status_events = [
        activity
        for activity in matching
        if activity.get("eventType") == "status_changed"
    ]
    for activity in status_events:
        status = read_activity_value(activity.get("newValue"), "status")
        if status not in allowed_statuses:
            raise InvalidDelivery("unexpected_lifecycle_status_event")

    status_times: dict[str, datetime] = {}
    for status in ("assigned", "picked_up", "in_transit", "delivered"):
        events = [
            activity
            for activity in status_events
            if read_activity_value(activity.get("newValue"), "status") == status
        ]
        if not events:
            if status == "assigned":
                raise InvalidDelivery("missing_assigned_status_event")
            raise InvalidDelivery(f"missing_{status}_event")
        if len(events) > 1:
            raise InvalidDelivery(f"duplicate_{status}_event")
        try:
            status_times[status] = activity_timestamp(events[0])
        except InvalidDelivery as error:
            raise InvalidDelivery(f"invalid_{status}_event_timestamp") from error

    assignment_events = []
    for activity in matching:
        if activity.get("eventType") != "assignment_changed":
            continue
        try:
            assigned_at = activity_timestamp(activity)
        except InvalidDelivery as error:
            raise InvalidDelivery("invalid_assignment_event_timestamp") from error
        assignment_events.append((assigned_at, activity))

    if not assignment_events:
        raise InvalidDelivery("missing_assignment_event")

    created_at = parse_timestamp(request.get("createdAt"), "request_creation_time")
    assignment_events.sort(key=lambda item: item[0])
    if assignment_events[0][0] < created_at:
        raise InvalidDelivery("assignment_precedes_request_creation")
    if any(
        assignment_events[index][0] >= assignment_events[index + 1][0]
        for index in range(len(assignment_events) - 1)
    ):
        raise InvalidDelivery("ambiguous_assignment_event_order")

    previous_agent_id: str | None = None
    for index, (_, activity) in enumerate(assignment_events):
        new_agent_id = read_activity_value(activity.get("newValue"), "agentId")
        if new_agent_id is None or str(new_agent_id).strip() == "":
            raise InvalidDelivery("missing_assigned_agent_reference")
        previous_value = activity.get("previousValue")
        if isinstance(previous_value, dict) and "agentId" in previous_value:
            recorded_previous_agent = previous_value.get("agentId")
            if index == 0 and recorded_previous_agent is not None:
                raise InvalidDelivery("inconsistent_reassignment_history")
            if index > 0 and str(recorded_previous_agent or "") != str(previous_agent_id):
                raise InvalidDelivery("inconsistent_reassignment_history")
        if index > 0 and str(new_agent_id) == str(previous_agent_id):
            raise InvalidDelivery("inconsistent_reassignment_history")
        previous_agent_id = str(new_agent_id)

    picked_up_at = status_times["picked_up"]
    assigned_at, assignment_activity = assignment_events[-1]
    request_agent_id = request.get("assignedAgent")
    if not request_agent_id:
        raise InvalidDelivery("missing_assigned_agent_reference")
    if str(previous_agent_id) != str(request_agent_id):
        raise InvalidDelivery("last_assignment_does_not_match_completed_agent")

    in_transit_at = status_times["in_transit"]
    delivered_at = status_times["delivered"]
    if not status_times["assigned"] < picked_up_at < in_transit_at < delivered_at:
        raise InvalidDelivery("incorrect_lifecycle_event_order")

    return assigned_at, picked_up_at, in_transit_at, delivered_at, assignment_activity


def valid_coordinate_pair(
    location: dict[str, Any] | None, field_name: str
) -> tuple[float, float] | None:
    """Return a valid pair, allow a fully missing pair, and reject invalid data."""
    if location is None:
        return None
    if not isinstance(location, dict):
        raise InvalidDelivery(f"invalid_{field_name}_coordinates")
    latitude = location.get("latitude")
    longitude = location.get("longitude")
    if latitude is None and longitude is None:
        return None
    if (
        isinstance(latitude, bool)
        or not isinstance(latitude, Real)
        or isinstance(longitude, bool)
        or not isinstance(longitude, Real)
    ):
        raise InvalidDelivery(f"invalid_{field_name}_coordinates")
    latitude = float(latitude)
    longitude = float(longitude)
    if not math.isfinite(latitude) or not math.isfinite(longitude):
        raise InvalidDelivery(f"invalid_{field_name}_coordinates")
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise InvalidDelivery(f"invalid_{field_name}_coordinates")
    return latitude, longitude


def assignment_coordinate_pairs(
    request: dict[str, Any],
    assignment_activity: dict[str, Any],
    activities: list[dict[str, Any]],
    assigned_at: datetime,
) -> tuple[tuple[float, float] | None, tuple[float, float] | None, bool, bool]:
    """Use assignment snapshots, or safe legacy coordinates when unchanged."""
    new_value = assignment_activity.get("newValue")
    if not isinstance(new_value, dict):
        raise InvalidDelivery("invalid_assignment_event")

    if "coordinates" in new_value:
        snapshot = new_value["coordinates"]
        if not isinstance(snapshot, dict):
            raise InvalidDelivery("invalid_assignment_coordinate_snapshot")
        pickup = valid_coordinate_pair(snapshot.get("pickup"), "pickup")
        destination = valid_coordinate_pair(snapshot.get("destination"), "destination")
        return pickup, destination, True, False

    for activity in activities:
        if activity.get("eventType") != "locations_changed":
            continue
        try:
            changed_at = activity_timestamp(activity)
        except InvalidDelivery:
            # Unknown ordering means current request coordinates are not trustworthy.
            return None, None, False, True
        if changed_at >= assigned_at:
            return None, None, False, True

    pickup = valid_coordinate_pair(request.get("pickup"), "pickup")
    destination = valid_coordinate_pair(request.get("delivery"), "destination")
    return pickup, destination, False, False


def straight_line_distance_km(
    pickup: tuple[float, float], destination: tuple[float, float]
) -> float:
    """Calculate the great-circle distance between two valid coordinate pairs."""
    lat1, lon1 = np.radians(pickup)
    lat2, lon2 = np.radians(destination)
    delta_latitude = lat2 - lat1
    delta_longitude = lon2 - lon1
    haversine = (
        np.sin(delta_latitude / 2) ** 2
        + np.cos(lat1) * np.cos(lat2) * np.sin(delta_longitude / 2) ** 2
    )
    angle = 2 * np.arctan2(np.sqrt(haversine), np.sqrt(1 - haversine))
    return float(EARTH_RADIUS_KM * angle)


def build_feature_row(
    request: dict[str, Any],
    assigned_at: datetime,
    delivered_at: datetime,
    pickup: tuple[float, float] | None,
    destination: tuple[float, float] | None,
) -> dict[str, Any]:
    created_at = parse_timestamp(request.get("createdAt"), "request_creation_time")
    if not created_at <= assigned_at:
        raise InvalidDelivery("assignment_precedes_request_creation")
    if not delivered_at > assigned_at:
        raise InvalidDelivery("non_positive_assignment_to_delivery_duration")

    distance = (
        straight_line_distance_km(pickup, destination)
        if pickup is not None and destination is not None
        else np.nan
    )
    package = request.get("package") or {}

    return {
        "request_created_at": created_at.isoformat(),
        "assigned_at": assigned_at.isoformat(),
        "priority": request.get("priority"),
        "package_category": package.get("category"),
        "weight_kg": package.get("weightKg"),
        "quantity": package.get("quantity"),
        "pickup_latitude": pickup[0] if pickup else np.nan,
        "pickup_longitude": pickup[1] if pickup else np.nan,
        "destination_latitude": destination[0] if destination else np.nan,
        "destination_longitude": destination[1] if destination else np.nan,
        "straight_line_distance_km": distance,
        TARGET_COLUMN: (delivered_at - assigned_at).total_seconds() / 60,
    }


def get_connection_settings() -> tuple[str, str | None]:
    """Load credentials from the process environment or SWERV backend .env."""
    backend_env = PROJECT_ROOT / "backend" / ".env"
    if backend_env.exists():
        load_dotenv(backend_env, override=False)
    else:
        load_dotenv(WORKSPACE_ROOT / ".env", override=False)

    mongo_uri = os.getenv("MONGO_URI", "").strip()
    if not mongo_uri or mongo_uri == "your_mongodb_connection_string":
        raise RuntimeError(
            "MONGO_URI is not configured. Set it in the environment or backend/.env."
        )
    return mongo_uri, os.getenv("MONGO_DATABASE") or None


def fetch_completed_requests(
    mongo_uri: str, database_name: str | None
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read completed requests and their status/assignment event history only."""
    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=8000)
    try:
        if database_name:
            database = client[database_name]
        else:
            # Mongoose/MongoDB use "test" when a URI omits its database name.
            database = client.get_default_database(default="test")

        requests = list(
            database["dispatchrequests"].find(
                {"status": "delivered"}, projection=REQUEST_PROJECTION
            )
        )
        request_ids = [request["_id"] for request in requests]
        if not request_ids:
            return requests, []

        activities = list(
            database["dispatchrequestactivities"].find(
                {
                    "dispatchRequestId": {"$in": request_ids},
                    "eventType": {
                        "$in": ["assignment_changed", "status_changed", "locations_changed"]
                    },
                },
                projection=ACTIVITY_PROJECTION,
            )
        )
        return requests, activities
    finally:
        client.close()


def count_missing_values(dataframe: pd.DataFrame, columns: list[str]) -> dict[str, int]:
    if dataframe.empty:
        return {column: 0 for column in columns}
    return {
        column: int(dataframe[column].isna().sum())
        for column in columns
    }


def prepare_dataset(
    requests: list[dict[str, Any]], activities: list[dict[str, Any]]
) -> tuple[pd.DataFrame, dict[str, Any]]:
    activities_by_request: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for activity in activities:
        activities_by_request[activity.get("dispatchRequestId")].append(activity)

    rows = []
    invalid_reasons: Counter[str] = Counter()
    coordinate_snapshot_rows = 0
    coordinates_omitted_due_to_location_history = 0
    for request in requests:
        try:
            assigned_at, picked_up_at, _, delivered_at, assignment_activity = find_delivery_events(
                request, activities_by_request.get(request.get("_id"), [])
            )
            if delivered_at <= assigned_at:
                raise InvalidDelivery("non_positive_assignment_to_delivery_duration")
            if assigned_at > picked_up_at:
                raise InvalidDelivery("assignment_after_pickup")

            request_activities = activities_by_request.get(request.get("_id"), [])
            pickup, destination, used_snapshot, omitted_for_history = assignment_coordinate_pairs(
                request, assignment_activity, request_activities, assigned_at
            )
            feature_row = build_feature_row(
                request, assigned_at, delivered_at, pickup, destination
            )
            rows.append(feature_row)
            coordinate_snapshot_rows += int(used_snapshot)
            coordinates_omitted_due_to_location_history += int(omitted_for_history)
        except InvalidDelivery as error:
            invalid_reasons[str(error)] += 1

    columns = FEATURE_COLUMNS + [TARGET_COLUMN]
    dataframe = pd.DataFrame(rows, columns=columns)
    for column in [
        "weight_kg",
        "quantity",
        "pickup_latitude",
        "pickup_longitude",
        "destination_latitude",
        "destination_longitude",
        "straight_line_distance_km",
        TARGET_COLUMN,
    ]:
        dataframe[column] = pd.to_numeric(dataframe[column], errors="coerce")

    missing_columns = [
        "priority",
        "package_category",
        "weight_kg",
        "quantity",
    ]
    missing_feature_values = count_missing_values(dataframe, missing_columns)
    missing_feature_values.update(
        count_missing_values(
            dataframe,
            [
                "pickup_latitude",
                "pickup_longitude",
                "destination_latitude",
                "destination_longitude",
                "straight_line_distance_km",
            ],
        )
    )
    complete_feature_records = int(
        dataframe[FEATURE_COLUMNS].notna().all(axis=1).sum()
    )
    usable_record_count = len(dataframe)
    planned_test_set_size = (
        max(
            MINIMUM_CHRONOLOGICAL_TEST_RECORDS,
            math.ceil(usable_record_count * CHRONOLOGICAL_TEST_FRACTION),
        )
        if usable_record_count >= MINIMUM_TRAINING_RECORDS
        else None
    )

    report = {
        "completed_requests_read": len(requests),
        "total_delivered_requests": len(requests),
        "invalid_rows_excluded": int(sum(invalid_reasons.values())),
        "invalid_row_reasons": dict(sorted(invalid_reasons.items())),
        "usable_completed_deliveries": usable_record_count,
        "valid_training_records": usable_record_count,
        "minimum_training_records": MINIMUM_TRAINING_RECORDS,
        "additional_valid_records_needed": max(
            0, MINIMUM_TRAINING_RECORDS - usable_record_count
        ),
        "records_with_complete_assignment_time_features": complete_feature_records,
        "minimum_chronological_test_set_size": MINIMUM_CHRONOLOGICAL_TEST_RECORDS,
        "planned_chronological_test_set_size": planned_test_set_size,
        "target_column": TARGET_COLUMN,
        "target_definition": "delivered_at minus the final assignment_at before pickup, in minutes",
        "feature_columns": FEATURE_COLUMNS,
        "excluded_agent_vehicle_type_reason": (
            "Agent vehicle attributes are not recorded in assignment activity history, "
            "so current values cannot reliably establish historical values."
        ),
        "missing_feature_values_in_usable_rows": missing_feature_values,
        "missing_feature_value_total": int(sum(missing_feature_values.values())),
        "assignment_coordinate_snapshot_rows": coordinate_snapshot_rows,
        "legacy_coordinates_omitted_due_to_location_history": (
            coordinates_omitted_due_to_location_history
        ),
        "prediction_time_columns_only": True,
    }
    return dataframe, report


def write_outputs(
    dataframe: pd.DataFrame, report: dict[str, Any], output_dir: Path
) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    csv_path = output_dir / "delivery_time_dataset.csv"
    report_path = output_dir / "data_quality_report.json"
    dataframe.to_csv(csv_path, index=False, na_rep="")
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return csv_path, report_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare or assess SWERV delivery data.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Read MongoDB and print current progress without writing dataset files.",
    )
    arguments = parser.parse_args()

    mongo_uri, database_name = get_connection_settings()
    try:
        requests, activities = fetch_completed_requests(mongo_uri, database_name)
    except Exception as error:
        # Driver exceptions can include connection details; keep output sanitized.
        raise RuntimeError(
            "Could not read the SWERV MongoDB collections. Check the URI, "
            "database name, network access, and read permissions."
        ) from error

    dataframe, report = prepare_dataset(requests, activities)
    if arguments.check:
        output = {**report, "dataset_files_written": False}
    else:
        csv_path, report_path = write_outputs(dataframe, report, DEFAULT_OUTPUT_DIR)
        output = {
            **report,
            "dataset_files_written": True,
            "csv_path": str(csv_path),
            "report_path": str(report_path),
        }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()

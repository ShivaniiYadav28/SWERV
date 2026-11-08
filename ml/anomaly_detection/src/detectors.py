"""Small, explainable anomaly checks for dispatch and GPS history."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from math import asin, cos, isfinite, radians, sin, sqrt
from numbers import Real
from statistics import quantiles
from typing import Any, Mapping, Sequence


STATUS_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"assigned", "cancelled"},
    "assigned": {"picked_up", "cancelled"},
    "picked_up": {"in_transit", "failed"},
    "in_transit": {"delivered", "failed"},
    "delivered": set(),
    "cancelled": set(),
    "failed": set(),
}

EARTH_RADIUS_KM = 6371.0088


@dataclass(frozen=True)
class DetectionConfig:
    """Tunable rules with conservative defaults for an early prototype."""

    stale_submission_minutes: float = 10.0
    maximum_movement_gap_minutes: float = 15.0
    maximum_gps_accuracy_meters: float = 100.0
    maximum_plausible_speed_kmh: float = 160.0
    repeated_reassignment_threshold: int = 2
    minimum_duration_samples: int = 30
    duration_iqr_multiplier: float = 3.0

    def __post_init__(self) -> None:
        numeric_limits = (
            self.stale_submission_minutes,
            self.maximum_movement_gap_minutes,
            self.maximum_gps_accuracy_meters,
            self.maximum_plausible_speed_kmh,
            self.duration_iqr_multiplier,
        )
        if any(
            isinstance(value, bool)
            or not isinstance(value, Real)
            or not isfinite(float(value))
            or value <= 0
            for value in numeric_limits
        ):
            raise ValueError("Detection thresholds must be finite positive numbers.")
        if (
            isinstance(self.repeated_reassignment_threshold, bool)
            or not isinstance(self.repeated_reassignment_threshold, int)
            or self.repeated_reassignment_threshold < 1
        ):
            raise ValueError("The reassignment threshold must be at least one.")
        if (
            isinstance(self.minimum_duration_samples, bool)
            or not isinstance(self.minimum_duration_samples, int)
            or self.minimum_duration_samples < 4
        ):
            raise ValueError("The duration baseline minimum must be at least four records.")


@dataclass
class AnomalyFinding:
    anomaly_type: str
    severity: str
    explanation: str
    measured_value: float | int | str | None
    threshold: float | int | str | list[str] | None
    detection_method: str
    evidence_timestamp: str | None
    dispatch_id: str | None = None
    agent_id: str | None = None
    data_quality_notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DetectionReport:
    findings: list[AnomalyFinding]
    limitations: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "findings": [finding.to_dict() for finding in self.findings],
            "limitations": self.limitations,
            "finding_count": len(self.findings),
            "data_source_note": "Findings are calculated from supplied records; unit-test fixtures are synthetic and are not SWERV observations.",
        }


def parse_timestamp(value: object) -> datetime | None:
    """Parse an ISO string or datetime and normalize it to UTC."""
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def timestamp_text(value: datetime | None) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


def identifier(record: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = record.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return None


def nested_value(record: Mapping[str, Any], parent: str, key: str) -> Any:
    value = record.get(parent)
    return value.get(key) if isinstance(value, Mapping) else None


def valid_coordinate_pair(latitude: object, longitude: object) -> bool:
    if (
        isinstance(latitude, bool)
        or isinstance(longitude, bool)
        or not isinstance(latitude, Real)
        or not isinstance(longitude, Real)
    ):
        return False
    return (
        isfinite(float(latitude))
        and isfinite(float(longitude))
        and -90 <= float(latitude) <= 90
        and -180 <= float(longitude) <= 180
    )


def distance_km(first: Mapping[str, Any], second: Mapping[str, Any]) -> float:
    """Calculate straight-line distance between two valid GPS points."""
    latitude_one = radians(float(first["latitude"]))
    latitude_two = radians(float(second["latitude"]))
    latitude_delta = latitude_two - latitude_one
    longitude_delta = radians(float(second["longitude"]) - float(first["longitude"]))
    haversine = (
        sin(latitude_delta / 2) ** 2
        + cos(latitude_one) * cos(latitude_two) * sin(longitude_delta / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * asin(sqrt(min(1.0, haversine)))


def detect_gps_anomalies(
    locations: Sequence[Mapping[str, Any]],
    config: DetectionConfig,
) -> tuple[list[AnomalyFinding], list[str]]:
    findings: list[AnomalyFinding] = []
    limitations: list[str] = []
    valid_points: dict[str, list[tuple[Mapping[str, Any], datetime, float]]] = {}

    for location in locations:
        agent_id = identifier(location, "agentId", "agent_id")
        recorded_at = parse_timestamp(location.get("recordedAt", location.get("recorded_at")))
        received_at = parse_timestamp(location.get("receivedAt", location.get("received_at")))
        evidence_time = received_at or recorded_at
        coordinate_valid = valid_coordinate_pair(
            location.get("latitude"), location.get("longitude")
        )

        if not coordinate_valid:
            missing = location.get("latitude") is None or location.get("longitude") is None
            findings.append(AnomalyFinding(
                anomaly_type="gps_missing_coordinates" if missing else "gps_invalid_coordinates",
                severity="medium",
                agent_id=agent_id,
                evidence_timestamp=timestamp_text(evidence_time),
                explanation="GPS location is missing a coordinate or falls outside valid latitude/longitude ranges.",
                measured_value=None,
                threshold="latitude [-90, 90], longitude [-180, 180]",
                detection_method="coordinate_validation",
                data_quality_notes=["This location was excluded from movement analysis."],
            ))

        if recorded_at is None or received_at is None:
            findings.append(AnomalyFinding(
                anomaly_type="gps_invalid_timestamp",
                severity="medium",
                agent_id=agent_id,
                evidence_timestamp=timestamp_text(evidence_time),
                explanation="GPS recordedAt or receivedAt is missing or cannot be parsed as a timestamp.",
                measured_value="invalid_or_missing_timestamp",
                threshold="both timestamps must be valid",
                detection_method="timestamp_validation",
                data_quality_notes=["This location was excluded from movement analysis."],
            ))
            continue

        submission_delay_minutes = (received_at - recorded_at).total_seconds() / 60
        if submission_delay_minutes < 0:
            findings.append(AnomalyFinding(
                anomaly_type="gps_invalid_timestamp_order",
                severity="medium",
                agent_id=agent_id,
                evidence_timestamp=timestamp_text(received_at),
                explanation="The server received the GPS record before its recordedAt time.",
                measured_value=round(submission_delay_minutes, 2),
                threshold="receivedAt must be at or after recordedAt",
                detection_method="timestamp_order_validation",
                data_quality_notes=["This location was excluded from movement analysis."],
            ))
            continue

        if submission_delay_minutes > config.stale_submission_minutes:
            findings.append(AnomalyFinding(
                anomaly_type="gps_stale_submission",
                severity="medium",
                agent_id=agent_id,
                evidence_timestamp=timestamp_text(received_at),
                explanation=(
                    f"The GPS point arrived {submission_delay_minutes:.1f} minutes after it was recorded; "
                    f"the configured stale limit is {config.stale_submission_minutes:.1f} minutes."
                ),
                measured_value=round(submission_delay_minutes, 2),
                threshold=config.stale_submission_minutes,
                detection_method="recordedAt_receivedAt_delay",
                data_quality_notes=["Stale points are excluded from movement analysis."],
            ))
            continue

        if not coordinate_valid:
            continue

        accuracy = location.get("accuracy")
        if (
            isinstance(accuracy, bool)
            or not isinstance(accuracy, Real)
            or not isfinite(float(accuracy))
            or float(accuracy) < 0
            or float(accuracy) > config.maximum_gps_accuracy_meters
        ):
            limitations.append("Some fresh GPS points were skipped because accuracy was missing or above the configured limit.")
            continue

        if agent_id is None:
            limitations.append("Some GPS records have no agent identifier and were excluded from movement pairing.")
            continue
        valid_points.setdefault(agent_id, []).append((location, recorded_at, float(accuracy)))

    for agent_id, points in valid_points.items():
        points.sort(key=lambda point: point[1])
        for first, second in zip(points, points[1:]):
            first_record, first_time, first_accuracy = first
            second_record, second_time, second_accuracy = second
            interval_minutes = (second_time - first_time).total_seconds() / 60
            if interval_minutes <= 0:
                limitations.append(f"GPS movement for agent {agent_id} was skipped for duplicate or unordered timestamps.")
                continue
            if interval_minutes > config.maximum_movement_gap_minutes:
                limitations.append("GPS movement pairs with gaps above the configured maximum were skipped.")
                continue

            measured_distance = distance_km(first_record, second_record)
            accuracy_allowance_km = (first_accuracy + second_accuracy) / 1000
            conservative_distance = max(0.0, measured_distance - accuracy_allowance_km)
            speed_kmh = conservative_distance / (interval_minutes / 60)
            if speed_kmh > config.maximum_plausible_speed_kmh:
                findings.append(AnomalyFinding(
                    anomaly_type="gps_implausible_jump",
                    severity="high",
                    agent_id=agent_id,
                    evidence_timestamp=timestamp_text(second_time),
                    explanation=(
                        f"Two fresh GPS points {interval_minutes:.1f} minutes apart are {measured_distance:.2f} km apart. "
                        f"After subtracting the combined {first_accuracy + second_accuracy:.0f} m accuracy allowance, "
                        f"implied speed is {speed_kmh:.1f} km/h, above the configured plausible limit."
                    ),
                    measured_value=round(speed_kmh, 2),
                    threshold=config.maximum_plausible_speed_kmh,
                    detection_method="haversine_distance_with_accuracy_adjustment",
                    data_quality_notes=[
                        "Both points passed coordinate, timestamp, freshness, and accuracy checks.",
                        f"Movement interval was {interval_minutes:.1f} minutes.",
                    ],
                ))

    return findings, sorted(set(limitations))


def detect_dispatch_anomalies(
    dispatches: Sequence[Mapping[str, Any]],
    activities: Sequence[Mapping[str, Any]],
    config: DetectionConfig,
    complete_activity_history_ids: set[str],
) -> tuple[list[AnomalyFinding], list[str]]:
    findings: list[AnomalyFinding] = []
    limitations: list[str] = []
    activities_by_dispatch: dict[str, list[Mapping[str, Any]]] = {}
    for activity in activities:
        dispatch_id = identifier(activity, "dispatchRequestId", "dispatch_request_id")
        if dispatch_id:
            activities_by_dispatch.setdefault(dispatch_id, []).append(activity)

    for dispatch in dispatches:
        dispatch_id = identifier(dispatch, "_id", "id", "dispatchRequestId")
        if dispatch_id is None:
            limitations.append("A dispatch without an ID was skipped.")
            continue
        request_activities = activities_by_dispatch.get(dispatch_id, [])
        assignment_events = [
            activity for activity in request_activities
            if activity.get("eventType") == "assignment_changed"
        ]
        if len(assignment_events) > 1:
            if dispatch_id not in complete_activity_history_ids:
                limitations.append(
                    f"Dispatch {dispatch_id} has multiple visible assignments, but its activity history is not confirmed complete; reassignment alert suppressed."
                )
            else:
                timed_assignments = [parse_timestamp(event.get("createdAt")) for event in assignment_events]
                if any(timestamp is None for timestamp in timed_assignments):
                    limitations.append(f"Dispatch {dispatch_id} has an assignment with an invalid timestamp; reassignment alert suppressed.")
                elif len(set(timed_assignments)) != len(timed_assignments):
                    limitations.append(f"Dispatch {dispatch_id} has ambiguous assignment timestamps; reassignment alert suppressed.")
                else:
                    ordered_events = sorted(
                        zip(timed_assignments, assignment_events),
                        key=lambda item: item[0],
                    )
                    last_agent: str | None = None
                    consistent = True
                    for index, (_, assignment_event) in enumerate(ordered_events):
                        new_agent = nested_value(assignment_event, "newValue", "agentId")
                        previous_agent = nested_value(assignment_event, "previousValue", "agentId")
                        if new_agent is None or (index > 0 and str(previous_agent or "") != last_agent):
                            consistent = False
                            break
                        if index > 0 and str(new_agent) == last_agent:
                            consistent = False
                            break
                        last_agent = str(new_agent)
                    current_agent = dispatch.get("assignedAgent")
                    if current_agent is not None and last_agent != str(current_agent):
                        consistent = False
                    if not consistent:
                        limitations.append(f"Dispatch {dispatch_id} assignment events are inconsistent; reassignment alert suppressed.")
                    else:
                        last_time = max(timestamp for timestamp in timed_assignments if timestamp is not None)
                        reassignments = len(assignment_events) - 1
                    if consistent and reassignments >= config.repeated_reassignment_threshold:
                        findings.append(AnomalyFinding(
                            anomaly_type="repeated_dispatch_reassignment",
                            severity="medium",
                            dispatch_id=dispatch_id,
                            evidence_timestamp=timestamp_text(last_time),
                            explanation=(
                                f"The dispatch had {reassignments} reassignments after its initial assignment; "
                                f"the configured threshold is {config.repeated_reassignment_threshold}."
                            ),
                            measured_value=reassignments,
                            threshold=config.repeated_reassignment_threshold,
                            detection_method="complete_assignment_event_count",
                            data_quality_notes=["Activity history completeness was explicitly confirmed for this dispatch."],
                        ))

        status_events = [
            activity for activity in request_activities
            if activity.get("eventType") == "status_changed"
        ]
        timed_events = []
        for event in status_events:
            event_time = parse_timestamp(event.get("createdAt"))
            if event_time is None:
                limitations.append(f"Dispatch {dispatch_id} has a status event with an invalid timestamp; that event was skipped.")
            else:
                timed_events.append((event_time, event))
        timed_events.sort(key=lambda item: item[0])
        previous_event_status: str | None = None
        seen_status_events: set[tuple[datetime | None, str, str]] = set()
        for _, event in timed_events:
            previous_status = nested_value(event, "previousValue", "status")
            new_status = nested_value(event, "newValue", "status")
            event_time = parse_timestamp(event.get("createdAt"))
            signature = (event_time, repr(previous_status), repr(new_status))
            if signature in seen_status_events:
                limitations.append(f"Dispatch {dispatch_id} contains a duplicate status event; the duplicate was ignored.")
                continue
            seen_status_events.add(signature)
            # Do not infer a transition from the prior event if previousValue is missing:
            # an unrecorded intermediate event could make that inference incorrect.
            from_status = previous_status if isinstance(previous_status, str) else None
            if not isinstance(new_status, str) or new_status not in STATUS_TRANSITIONS:
                limitations.append(f"Dispatch {dispatch_id} has a status event with an unknown new status; it was skipped.")
                previous_event_status = new_status if isinstance(new_status, str) else previous_event_status
                continue
            if from_status is None:
                limitations.append(f"Dispatch {dispatch_id} lacks a known prior status for one event; its transition could not be checked.")
            elif from_status not in STATUS_TRANSITIONS or new_status not in STATUS_TRANSITIONS[from_status]:
                findings.append(AnomalyFinding(
                    anomaly_type="invalid_status_transition",
                    severity="high",
                    dispatch_id=dispatch_id,
                    evidence_timestamp=timestamp_text(event_time),
                    explanation=f"Recorded status transition {from_status} -> {new_status} is not allowed by the SWERV lifecycle.",
                    measured_value=f"{from_status} -> {new_status}",
                    threshold=sorted(STATUS_TRANSITIONS.get(from_status, set())),
                    detection_method="documented_status_transition_table",
                    data_quality_notes=["A single recorded invalid transition is sufficient evidence; missing events may still hide earlier context."],
                ))
            if previous_event_status is not None and isinstance(previous_status, str) and previous_status != previous_event_status:
                limitations.append(f"Dispatch {dispatch_id} has a gap or inconsistency between adjacent status events; the chain was not inferred.")
            previous_event_status = new_status

    return findings, sorted(set(limitations))


def valid_delivery_durations(
    dispatches: Sequence[Mapping[str, Any]],
    activities: Sequence[Mapping[str, Any]],
) -> tuple[list[tuple[str, datetime, float]], list[str]]:
    activities_by_dispatch: dict[str, list[Mapping[str, Any]]] = {}
    for activity in activities:
        dispatch_id = identifier(activity, "dispatchRequestId", "dispatch_request_id")
        if dispatch_id:
            activities_by_dispatch.setdefault(dispatch_id, []).append(activity)

    durations: list[tuple[str, datetime, float]] = []
    limitations: list[str] = []
    for dispatch in dispatches:
        dispatch_id = identifier(dispatch, "_id", "id", "dispatchRequestId")
        if dispatch_id is None or dispatch.get("status") != "delivered":
            continue
        request_activities = activities_by_dispatch.get(dispatch_id, [])
        delivered_events = [
            event for event in request_activities
            if event.get("eventType") == "status_changed"
            and nested_value(event, "newValue", "status") == "delivered"
        ]
        pickup_events = [
            event for event in request_activities
            if event.get("eventType") == "status_changed"
            and nested_value(event, "newValue", "status") == "picked_up"
        ]
        if len(delivered_events) != 1 or len(pickup_events) != 1:
            limitations.append(f"Delivered dispatch {dispatch_id} has missing or ambiguous delivery status events; duration skipped.")
            continue
        delivered_at = parse_timestamp(delivered_events[0].get("createdAt"))
        picked_up_at = parse_timestamp(pickup_events[0].get("createdAt"))
        assignment_events = [
            event for event in request_activities
            if event.get("eventType") == "assignment_changed"
        ]
        timed_assignments = [
            (parse_timestamp(event.get("createdAt")), event)
            for event in assignment_events
        ]
        if delivered_at is None or picked_up_at is None or not timed_assignments:
            limitations.append(f"Delivered dispatch {dispatch_id} lacks a valid delivery timestamp or assignment event; duration skipped.")
            continue
        if any(timestamp is None for timestamp, _ in timed_assignments):
            limitations.append(f"Delivered dispatch {dispatch_id} has an assignment with an invalid timestamp; duration skipped.")
            continue
        assigned_at, assignment_event = max(
            (item for item in timed_assignments if item[0] is not None and item[0] < picked_up_at),
            default=(None, None),
            key=lambda item: item[0] or datetime.min.replace(tzinfo=timezone.utc),
        )
        if assigned_at is None or assignment_event is None or not assigned_at < picked_up_at < delivered_at:
            limitations.append(f"Delivered dispatch {dispatch_id} has no assignment before delivery; duration skipped.")
            continue

        final_agent = nested_value(assignment_event, "newValue", "agentId")
        dispatch_agent = dispatch.get("assignedAgent")
        if final_agent is None or dispatch_agent is None:
            limitations.append(f"Delivered dispatch {dispatch_id} is missing the agent reference needed to verify its final assignment; duration skipped.")
            continue
        if str(final_agent) != str(dispatch_agent):
            limitations.append(f"Delivered dispatch {dispatch_id} final assignment does not match the request's agent; duration skipped.")
            continue
        duration_minutes = (delivered_at - assigned_at).total_seconds() / 60
        if not isfinite(duration_minutes) or duration_minutes <= 0:
            limitations.append(f"Delivered dispatch {dispatch_id} has a non-positive assignment-to-delivery duration; duration skipped.")
            continue
        durations.append((dispatch_id, delivered_at, duration_minutes))
    return durations, sorted(set(limitations))


def detect_duration_anomalies(
    dispatches: Sequence[Mapping[str, Any]],
    activities: Sequence[Mapping[str, Any]],
    config: DetectionConfig,
) -> tuple[list[AnomalyFinding], list[str]]:
    durations, limitations = valid_delivery_durations(dispatches, activities)
    if len(durations) < config.minimum_duration_samples:
        return [], limitations + [
            f"Delivery-duration baseline is insufficient: {len(durations)} valid completed deliveries; "
            f"at least {config.minimum_duration_samples} are required. No duration anomalies were reported."
        ]

    values = [duration for _, _, duration in durations]
    quartile_values = quantiles(values, n=4, method="inclusive")
    upper_threshold = quartile_values[2] + config.duration_iqr_multiplier * (
        quartile_values[2] - quartile_values[0]
    )
    findings: list[AnomalyFinding] = []
    for dispatch_id, delivered_at, duration in durations:
        if duration > upper_threshold:
            severity = "high" if duration > upper_threshold * 2 else "medium"
            finding = AnomalyFinding(
                anomaly_type="unusual_delivery_duration",
                severity=severity,
                dispatch_id=dispatch_id,
                evidence_timestamp=timestamp_text(delivered_at),
                explanation=(
                    f"Assignment-to-delivery duration was {duration:.1f} minutes, above the conservative "
                    f"Q3 + {config.duration_iqr_multiplier:g}*IQR baseline threshold of {upper_threshold:.1f} minutes."
                ),
                measured_value=round(duration, 2),
                threshold=round(upper_threshold, 2),
                detection_method="upper_quartile_plus_configured_iqr_multiple",
                data_quality_notes=[
                    f"Baseline used {len(durations)} valid completed deliveries.",
                    "Completion time came from the delivered status activity, not DispatchRequest.updatedAt.",
                ],
            )
            # Keep the finding local to this event so one outlier does not affect others.
            findings.append(finding)
    return findings, limitations


def detect_anomalies(
    dispatches: Sequence[Mapping[str, Any]],
    dispatch_activities: Sequence[Mapping[str, Any]],
    gps_locations: Sequence[Mapping[str, Any]],
    *,
    complete_activity_history_ids: set[str] | None = None,
    config: DetectionConfig | None = None,
) -> DetectionReport:
    """Run the current read-only detectors over already-extracted records."""
    input_groups = (
        ("dispatches", dispatches),
        ("dispatch activities", dispatch_activities),
        ("GPS locations", gps_locations),
    )
    for group_name, records in input_groups:
        if isinstance(records, (str, bytes)) or not isinstance(records, Sequence):
            raise ValueError(f"{group_name} must be a sequence of mapping records.")
        if any(not isinstance(record, Mapping) for record in records):
            raise ValueError(f"Every record in {group_name} must be a mapping.")
    if complete_activity_history_ids is not None and any(
        not isinstance(dispatch_id, str) for dispatch_id in complete_activity_history_ids
    ):
        raise ValueError("Complete-history IDs must be strings.")
    settings = config or DetectionConfig()
    complete_ids = complete_activity_history_ids or set()
    gps_findings, gps_limitations = detect_gps_anomalies(gps_locations, settings)
    dispatch_findings, dispatch_limitations = detect_dispatch_anomalies(
        dispatches, dispatch_activities, settings, complete_ids
    )
    duration_findings, duration_limitations = detect_duration_anomalies(
        dispatches, dispatch_activities, settings
    )
    findings = gps_findings + dispatch_findings + duration_findings
    limitations = sorted(set(gps_limitations + dispatch_limitations + duration_limitations))
    return DetectionReport(findings=findings, limitations=limitations)

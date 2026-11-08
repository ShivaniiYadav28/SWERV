"""Synthetic unit fixtures only; these records are not SWERV database rows."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from src.detectors import DetectionConfig, detect_anomalies, detect_gps_anomalies


BASE_TIME = datetime(2026, 1, 1, tzinfo=timezone.utc)


def time_at(minutes: int) -> str:
    return (BASE_TIME + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


def gps_point(
    agent_id: str,
    minutes: int,
    latitude: float,
    longitude: float,
    *,
    accuracy: float = 5,
    delay_minutes: int = 0,
) -> dict[str, object]:
    recorded_at = BASE_TIME + timedelta(minutes=minutes)
    received_at = recorded_at + timedelta(minutes=delay_minutes)
    return {
        "agentId": agent_id,
        "latitude": latitude,
        "longitude": longitude,
        "accuracy": accuracy,
        "recordedAt": recorded_at,
        "receivedAt": received_at,
    }


def dispatch(identifier: str, status: str = "delivered", agent_id: str = "agent-1") -> dict[str, object]:
    return {"_id": identifier, "status": status, "assignedAgent": agent_id}


def activity(
    dispatch_id: str,
    event_type: str,
    minute: int,
    previous: str | None = None,
    new: str | None = None,
    agent_id: str | None = None,
) -> dict[str, object]:
    record: dict[str, object] = {
        "dispatchRequestId": dispatch_id,
        "eventType": event_type,
        "createdAt": time_at(minute),
        "previousValue": {"status": previous} if previous else None,
        "newValue": {"status": new} if new else {},
    }
    if agent_id:
        record["newValue"] = {**record["newValue"], "agentId": agent_id}  # type: ignore[dict-item]
    return record


def completed_dispatch(dispatch_id: str, duration_minutes: int) -> tuple[dict[str, object], list[dict[str, object]]]:
    start = 0
    picked_up = 5
    delivered = picked_up + duration_minutes - 5
    events = [
        activity(dispatch_id, "assignment_changed", start, agent_id="agent-1"),
        activity(dispatch_id, "status_changed", 1, "pending", "assigned"),
        activity(dispatch_id, "status_changed", picked_up, "assigned", "picked_up"),
        activity(dispatch_id, "status_changed", picked_up + 1, "picked_up", "in_transit"),
        activity(dispatch_id, "status_changed", delivered, "in_transit", "delivered"),
    ]
    return {**dispatch(dispatch_id), "updatedAt": time_at(10_000)}, events


class GpsDetectorTests(unittest.TestCase):
    def test_flags_missing_invalid_coordinates_and_timestamps(self) -> None:
        points = [
            {**gps_point("agent-a", 0, 12.0, 77.0), "latitude": None},
            {**gps_point("agent-a", 1, 12.0, 77.0), "latitude": 91.0},
            {**gps_point("agent-a", 2, 12.0, 77.0), "recordedAt": "not-a-date"},
        ]

        findings, _ = detect_gps_anomalies(points, DetectionConfig())

        self.assertEqual(
            [finding.anomaly_type for finding in findings],
            ["gps_missing_coordinates", "gps_invalid_coordinates", "gps_invalid_timestamp"],
        )
        self.assert_has_required_fields(findings)

    def test_flags_stale_submission_and_excludes_it_from_movement(self) -> None:
        points = [
            gps_point("agent-a", 0, 12.0, 77.0, delay_minutes=20),
            gps_point("agent-a", 1, 12.1, 77.0),
        ]

        findings, limitations = detect_gps_anomalies(points, DetectionConfig())

        self.assertEqual([finding.anomaly_type for finding in findings], ["gps_stale_submission"])
        self.assertTrue(any("excluded from movement" in note for note in findings[0].data_quality_notes))
        self.assertFalse(any(finding.anomaly_type == "gps_implausible_jump" for finding in findings))
        self.assertEqual(limitations, [])

    def test_flags_only_a_fresh_accurate_implausible_gps_jump(self) -> None:
        points = [
            gps_point("agent-a", 0, 0.0, 0.0),
            gps_point("agent-a", 1, 0.05, 0.0),
        ]

        findings, _ = detect_gps_anomalies(points, DetectionConfig())

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].anomaly_type, "gps_implausible_jump")
        self.assertGreater(findings[0].measured_value, findings[0].threshold)
        self.assertIn("accuracy allowance", findings[0].explanation)
        self.assertEqual(findings[0].detection_method, "haversine_distance_with_accuracy_adjustment")

    def test_skips_movement_with_large_gap_or_low_accuracy(self) -> None:
        points = [
            gps_point("agent-gap", 0, 0.0, 0.0),
            gps_point("agent-gap", 30, 0.05, 0.0),
            gps_point("agent-accuracy", 0, 0.0, 0.0, accuracy=500),
            gps_point("agent-accuracy", 1, 0.05, 0.0),
        ]

        findings, limitations = detect_gps_anomalies(points, DetectionConfig())

        self.assertEqual(findings, [])
        self.assertTrue(any("gaps above" in note for note in limitations))
        self.assertTrue(any("accuracy" in note for note in limitations))

    @staticmethod
    def assert_has_required_fields(findings) -> None:
        for finding in findings:
            for field in (
                "anomaly_type", "severity", "evidence_timestamp", "explanation",
                "measured_value", "threshold", "detection_method", "data_quality_notes",
            ):
                assert hasattr(finding, field)
            assert finding.anomaly_type
            assert finding.severity
            assert finding.explanation


class DispatchDetectorTests(unittest.TestCase):
    def test_requires_verified_complete_history_for_reassignment_alert(self) -> None:
        request = dispatch("dispatch-r")
        events = [
            activity("dispatch-r", "assignment_changed", 1, agent_id="agent-1"),
            activity("dispatch-r", "assignment_changed", 2, agent_id="agent-2"),
            activity("dispatch-r", "assignment_changed", 3, agent_id="agent-1"),
        ]
        events[1]["previousValue"] = {"agentId": "agent-1"}
        events[2]["previousValue"] = {"agentId": "agent-2"}

        incomplete_report = detect_anomalies([request], events, [])
        complete_report = detect_anomalies(
            [request], events, [], complete_activity_history_ids={"dispatch-r"}
        )

        self.assertFalse(any(item.anomaly_type == "repeated_dispatch_reassignment" for item in incomplete_report.findings))
        self.assertTrue(any("alert suppressed" in note for note in incomplete_report.limitations))
        reassignment = next(item for item in complete_report.findings if item.anomaly_type == "repeated_dispatch_reassignment")
        self.assertEqual(reassignment.measured_value, 2)
        self.assertEqual(reassignment.threshold, 2)

    def test_suppresses_reassignment_alert_when_assignment_chain_is_inconsistent(self) -> None:
        request = dispatch("dispatch-chain")
        events = [
            activity("dispatch-chain", "assignment_changed", 1, agent_id="agent-1"),
            activity("dispatch-chain", "assignment_changed", 2, agent_id="agent-2"),
            activity("dispatch-chain", "assignment_changed", 3, agent_id="agent-3"),
        ]
        events[1]["previousValue"] = {"agentId": "unexpected-agent"}
        events[2]["previousValue"] = {"agentId": "agent-2"}

        report = detect_anomalies(
            [request], events, [], complete_activity_history_ids={"dispatch-chain"}
        )

        self.assertFalse(any(item.anomaly_type == "repeated_dispatch_reassignment" for item in report.findings))
        self.assertTrue(any("assignment events are inconsistent" in note for note in report.limitations))

    def test_flags_status_transitions_that_violate_swerve_lifecycle(self) -> None:
        events = [
            activity("dispatch-s", "status_changed", 1, "pending", "delivered"),
            activity("dispatch-s", "status_changed", 2, "in_transit", "picked_up"),
        ]

        report = detect_anomalies([dispatch("dispatch-s")], events, [])
        invalid = [item for item in report.findings if item.anomaly_type == "invalid_status_transition"]

        self.assertEqual(len(invalid), 2)
        self.assertTrue(all("not allowed" in item.explanation for item in invalid))
        self.assertTrue(all(item.evidence_timestamp and item.data_quality_notes for item in invalid))

    def test_missing_prior_status_is_reported_as_a_limitation(self) -> None:
        events = [activity("dispatch-m", "status_changed", 1, new="delivered")]

        report = detect_anomalies([dispatch("dispatch-m")], events, [])

        self.assertFalse(any(item.anomaly_type == "invalid_status_transition" for item in report.findings))
        self.assertTrue(any("lacks a known prior status" in note for note in report.limitations))

    def test_duplicate_status_event_is_ignored_and_reported_as_a_limitation(self) -> None:
        delivered_event = activity("dispatch-duplicate", "status_changed", 4, "in_transit", "delivered")

        report = detect_anomalies(
            [dispatch("dispatch-duplicate")], [delivered_event, delivered_event.copy()], []
        )

        self.assertFalse(any(item.anomaly_type == "invalid_status_transition" for item in report.findings))
        self.assertTrue(any("duplicate status event" in note for note in report.limitations))

    def test_five_deliveries_report_insufficient_duration_baseline(self) -> None:
        records = [completed_dispatch(f"dispatch-{index}", 10 + index * 2) for index in range(5)]
        requests = [record for record, _ in records]
        events = [event for _, event_list in records for event in event_list]

        report = detect_anomalies(requests, events, [])

        self.assertFalse(any(item.anomaly_type == "unusual_delivery_duration" for item in report.findings))
        self.assertTrue(any("5 valid completed deliveries" in note for note in report.limitations))

    def test_duration_uses_final_assignment_before_pickup_and_delivered_event_time(self) -> None:
        requests = []
        events = []
        for index in range(31):
            request, lifecycle = completed_dispatch(f"dispatch-{index}", 100 if index == 30 else 10)
            request["assignedAgent"] = "agent-final"
            request["updatedAt"] = time_at(10_000)
            lifecycle[0]["newValue"] = {"agentId": "agent-old"}
            reassignment = activity(request["_id"], "assignment_changed", 2, agent_id="agent-final")
            reassignment["previousValue"] = {"agentId": "agent-old"}
            lifecycle.append(reassignment)
            events.extend(lifecycle)
            requests.append(request)

        report = detect_anomalies(requests, events, [])
        unusual = [item for item in report.findings if item.anomaly_type == "unusual_delivery_duration"]

        self.assertEqual([item.dispatch_id for item in unusual], ["dispatch-30"])
        self.assertEqual(unusual[0].evidence_timestamp, time_at(100))
        self.assertEqual(unusual[0].measured_value, 98)
        self.assertIn("Completion time came from the delivered status activity", unusual[0].data_quality_notes[1])

    def test_rejects_malformed_top_level_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "record in dispatches must be a mapping"):
            detect_anomalies([None], [], [])  # type: ignore[list-item]


if __name__ == "__main__":
    unittest.main()

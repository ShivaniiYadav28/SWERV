"""Checks for safe lifecycle extraction and assignment-time coordinates."""

from __future__ import annotations

import unittest
import json
import sys
from datetime import datetime, timedelta, timezone
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

import numpy as np

from src import dataset, training


START = datetime(2026, 1, 1, tzinfo=timezone.utc)
PICKUP_COORDINATES = {"latitude": 45.5, "longitude": -122.6}
DESTINATION_COORDINATES = {"latitude": 45.6, "longitude": -122.7}


def timestamp(minutes_after_start: int) -> datetime:
    return START + timedelta(minutes=minutes_after_start)


def assignment_event(
    agent_id: str = "agent-a",
    assigned_after: int = 1,
    previous_agent_id: str | None = None,
    coordinates: dict | None = None,
    include_snapshot: bool = True,
) -> dict:
    new_value = {"agentId": agent_id}
    if include_snapshot:
        new_value["coordinates"] = coordinates if coordinates is not None else {
            "pickup": PICKUP_COORDINATES,
            "destination": DESTINATION_COORDINATES,
        }
    return {
        "dispatchRequestId": "delivery-1",
        "eventType": "assignment_changed",
        "createdAt": timestamp(assigned_after),
        "previousValue": {"agentId": previous_agent_id},
        "newValue": new_value,
    }


def status_event(status: str, created_after: int) -> dict:
    return {
        "dispatchRequestId": "delivery-1",
        "eventType": "status_changed",
        "createdAt": timestamp(created_after),
        "newValue": {"status": status},
    }


def completed_delivery(
    *,
    assigned_agent: str = "agent-a",
    include_snapshot: bool = True,
    current_pickup: dict | None = None,
    current_destination: dict | None = None,
) -> tuple[dict, list[dict]]:
    request = {
        "_id": "delivery-1",
        "status": "delivered",
        "createdAt": START,
        "assignedAgent": assigned_agent,
        "priority": "standard",
        "pickup": current_pickup or PICKUP_COORDINATES,
        "delivery": current_destination or DESTINATION_COORDINATES,
        "package": {"category": "parcel", "weightKg": 2, "quantity": 1},
    }
    events = [
        assignment_event(include_snapshot=include_snapshot),
        status_event("assigned", 2),
        status_event("picked_up", 5),
        status_event("in_transit", 10),
        status_event("delivered", 30),
    ]
    return request, events


class DatasetExtractionTests(unittest.TestCase):
    def extract(self, request: dict, events: list[dict]):
        return dataset.prepare_dataset([request], events)

    def test_uses_assignment_coordinate_snapshot_instead_of_current_values(self) -> None:
        snapshot_pickup = {"latitude": 40.0, "longitude": -70.0}
        snapshot_destination = {"latitude": 40.2, "longitude": -70.2}
        request, events = completed_delivery(
            current_pickup={"latitude": 10.0, "longitude": 10.0},
            current_destination={"latitude": 11.0, "longitude": 11.0},
        )
        events[0]["newValue"]["coordinates"] = {
            "pickup": snapshot_pickup,
            "destination": snapshot_destination,
        }
        events.append({
            "dispatchRequestId": request["_id"],
            "eventType": "locations_changed",
            "createdAt": timestamp(4),
        })

        dataframe, report = self.extract(request, events)

        self.assertEqual(len(dataframe), 1)
        self.assertEqual(dataframe.loc[0, "pickup_latitude"], 40.0)
        self.assertEqual(dataframe.loc[0, "pickup_longitude"], -70.0)
        self.assertEqual(dataframe.loc[0, "destination_latitude"], 40.2)
        self.assertEqual(report["assignment_coordinate_snapshot_rows"], 1)
        self.assertEqual(report["legacy_coordinates_omitted_due_to_location_history"], 0)

    def test_omits_legacy_coordinates_after_a_location_change(self) -> None:
        request, events = completed_delivery(include_snapshot=False)
        events.append({
            "dispatchRequestId": request["_id"],
            "eventType": "locations_changed",
            "createdAt": timestamp(3),
        })

        dataframe, report = self.extract(request, events)

        self.assertEqual(len(dataframe), 1)
        self.assertTrue(np.isnan(dataframe.loc[0, "pickup_latitude"]))
        self.assertTrue(np.isnan(dataframe.loc[0, "straight_line_distance_km"]))
        self.assertEqual(report["legacy_coordinates_omitted_due_to_location_history"], 1)

    def test_uses_legacy_coordinates_when_no_later_location_change_exists(self) -> None:
        request, events = completed_delivery(include_snapshot=False)

        dataframe, _ = self.extract(request, events)

        self.assertEqual(dataframe.loc[0, "pickup_latitude"], PICKUP_COORDINATES["latitude"])
        self.assertTrue(np.isfinite(dataframe.loc[0, "straight_line_distance_km"]))

    def test_uses_latest_reassignment_and_its_snapshot(self) -> None:
        request, events = completed_delivery(assigned_agent="agent-b")
        final_snapshot = {
            "pickup": {"latitude": 41.0, "longitude": -71.0},
            "destination": {"latitude": 41.1, "longitude": -71.1},
        }
        events[0]["newValue"]["coordinates"] = {
            "pickup": PICKUP_COORDINATES,
            "destination": DESTINATION_COORDINATES,
        }
        events.insert(1, assignment_event(
            agent_id="agent-b",
            assigned_after=3,
            previous_agent_id="agent-a",
            coordinates=final_snapshot,
        ))

        dataframe, report = self.extract(request, events)

        self.assertEqual(len(dataframe), 1)
        self.assertEqual(dataframe.loc[0, "pickup_latitude"], 41.0)
        self.assertEqual(dataframe.loc[0, dataset.TARGET_COLUMN], 27.0)
        self.assertEqual(report["invalid_rows_excluded"], 0)

    def test_rejects_a_reassignment_chain_that_does_not_match(self) -> None:
        request, events = completed_delivery(assigned_agent="agent-b")
        events.insert(1, assignment_event(
            agent_id="agent-b",
            assigned_after=3,
            previous_agent_id="unexpected-agent",
        ))

        dataframe, report = self.extract(request, events)

        self.assertTrue(dataframe.empty)
        self.assertEqual(report["invalid_row_reasons"], {"inconsistent_reassignment_history": 1})

    def test_rejects_a_final_assignment_that_does_not_match_the_request(self) -> None:
        request, events = completed_delivery(assigned_agent="another-agent")

        dataframe, report = self.extract(request, events)

        self.assertTrue(dataframe.empty)
        self.assertEqual(
            report["invalid_row_reasons"],
            {"last_assignment_does_not_match_completed_agent": 1},
        )

    def test_reports_missing_assignment_pickup_and_delivery_events(self) -> None:
        missing_assignment_request, missing_assignment = completed_delivery()
        missing_assignment = [
            event for event in missing_assignment if event["eventType"] != "assignment_changed"
        ]
        missing_pickup_request, missing_pickup = completed_delivery()
        missing_pickup = [
            event for event in missing_pickup
            if event.get("newValue", {}).get("status") != "picked_up"
        ]
        missing_delivery_request, missing_delivery = completed_delivery()
        missing_delivery = [
            event for event in missing_delivery
            if event.get("newValue", {}).get("status") != "delivered"
        ]

        for request, events, expected_reason in [
            (missing_assignment_request, missing_assignment, "missing_assignment_event"),
            (missing_pickup_request, missing_pickup, "missing_picked_up_event"),
            (missing_delivery_request, missing_delivery, "missing_delivered_event"),
        ]:
            with self.subTest(reason=expected_reason):
                dataframe, report = self.extract(request, events)
                self.assertTrue(dataframe.empty)
                self.assertEqual(report["invalid_row_reasons"], {expected_reason: 1})

    def test_rejects_duplicate_pickup_and_delivery_events(self) -> None:
        for duplicated_status, reason in [
            ("picked_up", "duplicate_picked_up_event"),
            ("delivered", "duplicate_delivered_event"),
        ]:
            request, events = completed_delivery()
            events.append(status_event(duplicated_status, 6 if duplicated_status == "picked_up" else 31))
            with self.subTest(status=duplicated_status):
                dataframe, report = self.extract(request, events)
                self.assertTrue(dataframe.empty)
                self.assertEqual(report["invalid_row_reasons"], {reason: 1})

    def test_rejects_incorrect_lifecycle_order(self) -> None:
        request, events = completed_delivery()
        events = [
            event for event in events
            if event.get("newValue", {}).get("status") != "in_transit"
        ]
        events.append(status_event("in_transit", 4))

        dataframe, report = self.extract(request, events)

        self.assertTrue(dataframe.empty)
        self.assertEqual(report["invalid_row_reasons"], {"incorrect_lifecycle_event_order": 1})

    def test_rejects_non_positive_assignment_to_delivery_duration(self) -> None:
        request, events = completed_delivery()
        events[0]["createdAt"] = timestamp(30)
        events[0]["newValue"]["agentId"] = "agent-a"

        dataframe, report = self.extract(request, events)

        self.assertTrue(dataframe.empty)
        self.assertEqual(
            report["invalid_row_reasons"],
            {"non_positive_assignment_to_delivery_duration": 1},
        )

    def test_rejects_invalid_coordinates_in_an_assignment_snapshot(self) -> None:
        request, events = completed_delivery()
        events[0]["newValue"]["coordinates"]["pickup"] = {
            "latitude": 91,
            "longitude": -122.6,
        }

        dataframe, report = self.extract(request, events)

        self.assertTrue(dataframe.empty)
        self.assertEqual(report["invalid_row_reasons"], {"invalid_pickup_coordinates": 1})

    def test_model_features_exclude_target_and_post_assignment_values(self) -> None:
        request, events = completed_delivery()
        dataframe, _ = self.extract(request, events)

        features = training.build_features(dataframe)

        self.assertNotIn(dataset.TARGET_COLUMN, features.columns)
        self.assertFalse({"picked_up_at", "in_transit_at", "delivered_at", "final_status"} & set(features.columns))

    def test_quality_report_includes_training_progress(self) -> None:
        request, events = completed_delivery()

        _, report = self.extract(request, events)

        self.assertEqual(report["total_delivered_requests"], 1)
        self.assertEqual(report["valid_training_records"], 1)
        self.assertEqual(report["records_with_complete_assignment_time_features"], 1)
        self.assertEqual(report["minimum_training_records"], training.MINIMUM_RECORDS_FOR_TRAINING)
        self.assertEqual(report["additional_valid_records_needed"], 199)
        self.assertEqual(
            report["minimum_chronological_test_set_size"],
            training.MINIMUM_TEST_RECORDS,
        )
        self.assertIsNone(report["planned_chronological_test_set_size"])

    def test_training_threshold_and_chronological_rules_are_unchanged(self) -> None:
        self.assertEqual(dataset.MINIMUM_TRAINING_RECORDS, 200)
        self.assertEqual(training.MINIMUM_RECORDS_FOR_TRAINING, 200)
        self.assertEqual(dataset.MINIMUM_CHRONOLOGICAL_TEST_RECORDS, 40)
        self.assertEqual(training.MINIMUM_TEST_RECORDS, 40)
        self.assertEqual(training.TEST_FRACTION, 0.20)

    def test_check_mode_prints_progress_without_writing_dataset_files(self) -> None:
        request, events = completed_delivery()
        output = StringIO()
        with (
            patch.object(dataset, "get_connection_settings", return_value=("hidden", None)),
            patch.object(dataset, "fetch_completed_requests", return_value=([request], events)) as fetch,
            patch.object(dataset, "write_outputs") as write,
            patch.object(sys, "argv", ["dataset.py", "--check"]),
            redirect_stdout(output),
        ):
            dataset.main()

        report = json.loads(output.getvalue())
        fetch.assert_called_once_with("hidden", None)
        write.assert_not_called()
        self.assertFalse(report["dataset_files_written"])
        self.assertEqual(report["valid_training_records"], 1)

    def test_database_extraction_uses_only_find_queries(self) -> None:
        delivered_request = {"_id": "delivery-1", "status": "delivered"}

        class ReadOnlyCollection:
            def __init__(self, rows: list[dict]):
                self.rows = rows
                self.find_calls = []

            def find(self, query: dict, projection: dict | None = None):
                self.find_calls.append((query, projection))
                return iter(self.rows)

        class ReadOnlyDatabase:
            def __init__(self):
                self.collections = {
                    "dispatchrequests": ReadOnlyCollection([delivered_request]),
                    "dispatchrequestactivities": ReadOnlyCollection([]),
                }

            def __getitem__(self, collection_name: str):
                return self.collections[collection_name]

        class ReadOnlyClient:
            def __init__(self):
                self.database = ReadOnlyDatabase()
                self.was_closed = False

            def __getitem__(self, _database_name: str):
                return self.database

            def close(self):
                self.was_closed = True

        client = ReadOnlyClient()
        with patch.object(dataset, "MongoClient", return_value=client):
            requests, activities = dataset.fetch_completed_requests("hidden", "swerv")

        self.assertEqual(requests, [delivered_request])
        self.assertEqual(activities, [])
        self.assertEqual(len(client.database.collections["dispatchrequests"].find_calls), 1)
        self.assertEqual(len(client.database.collections["dispatchrequestactivities"].find_calls), 1)
        self.assertTrue(client.was_closed)


if __name__ == "__main__":
    unittest.main()

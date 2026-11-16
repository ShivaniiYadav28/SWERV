"""Generate reproducible synthetic rows for anomaly-model experiments."""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from collections import Counter
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "data" / "processed" / "synthetic"
DATA_SOURCE = "synthetic"
NORMAL_LABEL = "normal"

NUMERIC_FEATURES = [
    "gps_distance_km",
    "gps_interval_minutes",
    "implied_speed_kmh",
    "gps_reported_speed_kmh",
    "gps_accuracy_meters",
    "gps_freshness_minutes",
    "gps_coordinates_valid",
    "gps_timestamps_valid",
    "gps_pair_available",
    "expected_delivery_duration_minutes",
    "reassignment_count",
    "assignment_event_count",
    "activity_history_complete",
    "delivery_duration_minutes",
    "delivery_delay_minutes",
    "expected_delivery_distance_km",
    "delivery_distance_km",
    "planned_route_distance_km",
    "actual_route_distance_km",
    "route_deviation_ratio",
    "distance_to_expected_ratio",
    "failed_delivery_attempts",
    "agent_failed_deliveries_7d",
    "status_event_count",
    "status_transition_valid",
    "agent_status_change_count",
    "agent_activity_ratio",
    "agent_active_workload",
    "dispatch_burst_count_10m",
    "dispatch_repeat_route_count_1h",
    "dispatch_creation_hour",
    "data_quality_issue_count",
]
CATEGORICAL_FEATURES = ["priority", "package_category", "vehicle_type"]
FEATURE_COLUMNS = NUMERIC_FEATURES + CATEGORICAL_FEATURES
OUTPUT_COLUMNS = [
    "scenario_id",
    *FEATURE_COLUMNS,
    "is_anomaly",
    "anomaly_type",
    "data_source",
    "dataset_split",
]

ANOMALY_WEIGHTS = {
    "normal": 0.88,
    "delivery_delay": 0.015,
    "gps_coordinate_jump": 0.015,
    "route_deviation": 0.015,
    "repeated_delivery_failures": 0.015,
    "unusual_agent_activity": 0.015,
    "suspicious_dispatch_pattern": 0.015,
    "abnormal_delivery_duration": 0.015,
    "abnormal_delivery_distance": 0.015,
}

PRIORITIES = ("standard", "express", "urgent")
PACKAGE_CATEGORIES = ("documents", "parcel", "food", "fragile", "heavy_goods", "other")
VEHICLE_TYPES = ("car", "van", "motorcycle", "truck", "bicycle")


def rounded(value: float, digits: int = 3) -> float:
    return round(value, digits)


def make_base_scenario(rng: random.Random) -> dict[str, Any]:
    """Create an ordinary dispatch with related duration and distance values."""
    priority = rng.choice(PRIORITIES)
    package_category = rng.choice(PACKAGE_CATEGORIES)
    vehicle_type = rng.choice(VEHICLE_TYPES)
    expected_distance = rounded(rng.uniform(2.0, 35.0), 2)
    package_time_allowance = 18.0 if package_category in {"heavy_goods", "fragile"} else 0.0
    priority_time_adjustment = -8.0 if priority == "urgent" else 0.0
    expected_duration = rounded(max(
        15.0,
        18.0 + expected_distance * 2.1 + package_time_allowance + priority_time_adjustment
        + rng.uniform(-8.0, 12.0),
    ), 2)
    actual_duration = rounded(expected_duration * rng.triangular(0.65, 1.55, 0.98), 2)
    planned_route_distance = rounded(expected_distance * rng.uniform(1.05, 1.4), 3)
    actual_route_distance = rounded(planned_route_distance * rng.triangular(0.9, 1.35, 1.08), 3)
    failed_attempts = rng.choices((0, 1, 2), weights=(0.86, 0.12, 0.02), k=1)[0]
    agent_failed_deliveries = rng.choices((0, 1, 2, 3), weights=(0.68, 0.2, 0.09, 0.03), k=1)[0]
    agent_status_changes = rng.randint(0, 6)
    agent_activity_ratio = rounded(rng.triangular(0.45, 1.9, 1.0), 2)
    scenario: dict[str, Any] = {
        "priority": priority,
        "package_category": package_category,
        "vehicle_type": vehicle_type,
        "gps_distance_km": None,
        "gps_interval_minutes": None,
        "implied_speed_kmh": None,
        "gps_reported_speed_kmh": None,
        "gps_accuracy_meters": None,
        "gps_freshness_minutes": None,
        "gps_coordinates_valid": None,
        "gps_timestamps_valid": None,
        "gps_pair_available": 0,
        "expected_delivery_duration_minutes": expected_duration,
        "reassignment_count": 0,
        "assignment_event_count": 1,
        "activity_history_complete": rng.choice((0, 1)),
        "delivery_duration_minutes": actual_duration,
        "delivery_delay_minutes": rounded(max(0.0, actual_duration - expected_duration), 2),
        "expected_delivery_distance_km": expected_distance,
        "delivery_distance_km": actual_route_distance,
        "planned_route_distance_km": planned_route_distance,
        "actual_route_distance_km": actual_route_distance,
        "route_deviation_ratio": rounded(actual_route_distance / planned_route_distance, 3),
        "distance_to_expected_ratio": rounded(actual_route_distance / expected_distance, 3),
        "failed_delivery_attempts": failed_attempts,
        "agent_failed_deliveries_7d": agent_failed_deliveries,
        "status_event_count": rng.randint(2, 5),
        "status_transition_valid": 1,
        "agent_status_change_count": agent_status_changes,
        "agent_activity_ratio": agent_activity_ratio,
        "agent_active_workload": rng.randint(0, 5),
        "dispatch_burst_count_10m": rng.randint(1, 4),
        "dispatch_repeat_route_count_1h": rng.randint(1, 3),
        "dispatch_creation_hour": rng.randrange(24),
        "data_quality_issue_count": 0,
    }

    if rng.random() < 0.88:
        interval_minutes = rounded(rng.uniform(1.0, 15.0), 2)
        # Typical movement is urban-speed travel, with borderline cases retained.
        speed_kmh = rng.triangular(6.0, 138.0, 28.0)
        distance = speed_kmh * interval_minutes / 60
        accuracy = rng.choice([
            rounded(rng.uniform(4.0, 90.0), 1),
            rounded(rng.uniform(100.1, 350.0), 1),
        ])
        freshness = rounded(rng.uniform(0.0, 10.0), 2)
        scenario.update({
            "gps_distance_km": rounded(distance, 3),
            "gps_interval_minutes": interval_minutes,
            "implied_speed_kmh": rounded(speed_kmh, 2),
            "gps_reported_speed_kmh": rounded(max(0.0, rng.gauss(speed_kmh, 12.0)), 2)
            if rng.random() < 0.7 else None,
            "gps_accuracy_meters": accuracy,
            "gps_freshness_minutes": freshness,
            "gps_coordinates_valid": 1,
            "gps_timestamps_valid": 1,
            "gps_pair_available": 1,
        })
        if accuracy > 100:
            scenario["data_quality_issue_count"] += 1
    else:
        # Missing GPS pairs prevent movement analysis; they are not anomalies by themselves.
        scenario["data_quality_issue_count"] += 1

    return scenario


def add_anomaly(scenario: dict[str, Any], anomaly_type: str, rng: random.Random) -> None:
    """Adjust a base scenario using related operational feature values."""
    if anomaly_type == "delivery_delay":
        expected = rounded(rng.uniform(25.0, 75.0), 2)
        delay = rounded(rng.uniform(45.0, 180.0), 2)
        scenario["expected_delivery_duration_minutes"] = expected
        scenario["delivery_delay_minutes"] = delay
        scenario["delivery_duration_minutes"] = rounded(expected + delay, 2)
    elif anomaly_type == "gps_coordinate_jump":
        interval = rounded(rng.uniform(1.0, 6.0), 2)
        speed = rng.uniform(163.0, 245.0)
        scenario.update({
            "gps_pair_available": 1,
            "gps_coordinates_valid": 1,
            "gps_timestamps_valid": 1,
            "gps_interval_minutes": interval,
            "gps_distance_km": rounded(speed * interval / 60, 3),
            "implied_speed_kmh": rounded(speed, 2),
            "gps_accuracy_meters": rounded(rng.uniform(5.0, 95.0), 1),
            "gps_freshness_minutes": rounded(rng.uniform(0.0, 8.0), 2),
            "gps_reported_speed_kmh": rounded(rng.uniform(5.0, 70.0), 2),
        })
    elif anomaly_type == "route_deviation":
        planned = rounded(rng.uniform(2.0, 15.0), 2)
        actual = rounded(planned * rng.uniform(2.2, 3.8), 3)
        expected_distance = rounded(planned / 1.2, 2)
        scenario.update({
            "planned_route_distance_km": planned,
            "actual_route_distance_km": actual,
            "delivery_distance_km": actual,
            "route_deviation_ratio": rounded(actual / planned, 3),
            "expected_delivery_distance_km": expected_distance,
            "distance_to_expected_ratio": rounded(actual / expected_distance, 3),
        })
    elif anomaly_type == "repeated_delivery_failures":
        scenario["failed_delivery_attempts"] = rng.randint(3, 6)
        scenario["agent_failed_deliveries_7d"] = rng.randint(4, 12)
    elif anomaly_type == "unusual_agent_activity":
        scenario["agent_status_change_count"] = rng.randint(18, 40)
        scenario["agent_activity_ratio"] = rounded(rng.uniform(3.0, 9.0), 2)
        scenario["agent_active_workload"] = rng.randint(8, 18)
    elif anomaly_type == "suspicious_dispatch_pattern":
        scenario["dispatch_burst_count_10m"] = rng.randint(9, 24)
        scenario["dispatch_repeat_route_count_1h"] = rng.randint(5, 14)
        scenario["priority"] = "urgent"
    elif anomaly_type == "abnormal_delivery_duration":
        expected = rounded(rng.uniform(180.0, 360.0), 2)
        duration = rounded(expected * rng.uniform(1.8, 3.0), 2)
        scenario["expected_delivery_duration_minutes"] = expected
        scenario["delivery_duration_minutes"] = duration
        scenario["delivery_delay_minutes"] = rounded(duration - expected, 2)
    elif anomaly_type == "abnormal_delivery_distance":
        expected = rounded(rng.uniform(4.0, 35.0), 2)
        distance = rounded(rng.uniform(150.0, 420.0), 2)
        planned = rounded(expected * 1.2, 3)
        scenario.update({
            "expected_delivery_distance_km": expected,
            "planned_route_distance_km": planned,
            "actual_route_distance_km": distance,
            "delivery_distance_km": distance,
            "route_deviation_ratio": rounded(distance / planned, 3),
            "distance_to_expected_ratio": rounded(distance / expected, 3),
        })
    else:
        raise ValueError(f"Unsupported synthetic anomaly type: {anomaly_type}")


def generate_dataset(size: int, seed: int, split_name: str) -> list[dict[str, Any]]:
    """Create one independent set of scenarios using the supplied random seed."""
    if not isinstance(size, int) or isinstance(size, bool) or size < 1:
        raise ValueError("Dataset size must be a positive integer.")
    if not split_name or not split_name.replace("_", "").isalnum():
        raise ValueError("Split name must contain only letters, numbers, or underscores.")

    rng = random.Random(seed)
    anomaly_types = tuple(ANOMALY_WEIGHTS)
    weights = tuple(ANOMALY_WEIGHTS.values())
    rows: list[dict[str, Any]] = []
    for index in range(size):
        anomaly_type = rng.choices(anomaly_types, weights=weights, k=1)[0]
        row = make_base_scenario(rng)
        if anomaly_type != NORMAL_LABEL:
            add_anomaly(row, anomaly_type, rng)
        row.update({
            "scenario_id": f"{split_name}-{index:07d}",
            "is_anomaly": int(anomaly_type != NORMAL_LABEL),
            "anomaly_type": anomaly_type,
            "data_source": DATA_SOURCE,
            "dataset_split": split_name,
        })
        rows.append(row)
    validate_dataset(rows, split_name)
    return rows


def validate_dataset(rows: list[dict[str, Any]], split_name: str) -> None:
    """Check schema, provenance, labels, and feature relationships before saving."""
    if not rows:
        raise ValueError(f"The {split_name} dataset cannot be empty.")
    ids = [row.get("scenario_id") for row in rows]
    if len(set(ids)) != len(ids):
        raise ValueError(f"The {split_name} dataset contains duplicate scenario IDs.")
    for row in rows:
        if set(row) != set(OUTPUT_COLUMNS):
            raise ValueError("A synthetic row does not match the documented output columns.")
        if row["data_source"] != DATA_SOURCE or row["dataset_split"] != split_name:
            raise ValueError("Synthetic provenance or split label is invalid.")
        if row["anomaly_type"] not in ANOMALY_WEIGHTS:
            raise ValueError("A scenario has an unsupported anomaly category.")
        if row["is_anomaly"] not in (0, 1):
            raise ValueError("Anomaly labels must be zero or one.")
        if row["is_anomaly"] != int(row["anomaly_type"] != NORMAL_LABEL):
            raise ValueError("Anomaly label does not match its anomaly category.")
        for column in NUMERIC_FEATURES:
            value = row[column]
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or value < 0
            ):
                raise ValueError(f"Numeric feature {column} must be finite and non-negative or null.")
        if row["priority"] not in PRIORITIES:
            raise ValueError("A scenario has an unsupported priority.")
        if row["package_category"] not in PACKAGE_CATEGORIES:
            raise ValueError("A scenario has an unsupported package category.")
        if row["vehicle_type"] not in VEHICLE_TYPES:
            raise ValueError("A scenario has an unsupported vehicle type.")
        if row["gps_pair_available"] not in (0, 1):
            raise ValueError("GPS pair availability must be binary.")
        if row["gps_pair_available"] == 0 and row["gps_distance_km"] is not None:
            raise ValueError("A missing GPS pair cannot have a movement distance.")
        expected_delay = max(0.0, row["delivery_duration_minutes"] - row["expected_delivery_duration_minutes"])
        if abs(row["delivery_delay_minutes"] - expected_delay) > 0.02:
            raise ValueError("Delivery delay must match actual duration minus expected duration.")
        if row["planned_route_distance_km"] <= 0 or row["expected_delivery_distance_km"] <= 0:
            raise ValueError("Expected and planned route distances must be positive.")
        if abs(row["route_deviation_ratio"] - row["actual_route_distance_km"] / row["planned_route_distance_km"]) > 0.002:
            raise ValueError("Route deviation ratio does not match planned and actual route distances.")
        if abs(row["distance_to_expected_ratio"] - row["delivery_distance_km"] / row["expected_delivery_distance_km"]) > 0.002:
            raise ValueError("Distance ratio does not match delivered and expected distances.")


def generate_splits(
    train_size: int = 7000,
    validation_size: int = 1500,
    test_size: int = 1500,
    demo_size: int = 700,
    train_seed: int = 41005,
    validation_seed: int = 41006,
    test_seed: int = 41007,
    demo_seed: int = 41008,
) -> dict[str, list[dict[str, Any]]]:
    """Generate independent scenario IDs and independently seeded splits."""
    seeds = (train_seed, validation_seed, test_seed, demo_seed)
    if len(set(seeds)) != len(seeds):
        raise ValueError("Training, validation, test, and demo seeds must be different.")
    splits = {
        "train": generate_dataset(train_size, train_seed, "train"),
        "validation": generate_dataset(validation_size, validation_seed, "validation"),
        "test": generate_dataset(test_size, test_seed, "test"),
        "demo": generate_dataset(demo_size, demo_seed, "demo"),
    }
    identifiers = [row["scenario_id"] for rows in splits.values() for row in rows]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Scenario IDs must be unique across every split.")
    return splits


def write_splits(
    splits: dict[str, list[dict[str, Any]]], output_directory: Path
) -> dict[str, Any]:
    output_directory.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    summary: dict[str, Any] = {}
    for split_name, rows in splits.items():
        validate_dataset(rows, split_name)
        path = output_directory / f"synthetic_{split_name}.csv"
        with path.open("w", newline="", encoding="utf-8") as csv_file:
            writer = csv.DictWriter(csv_file, fieldnames=OUTPUT_COLUMNS)
            writer.writeheader()
            writer.writerows(rows)
        files[split_name] = path.name
        labels = Counter(row["anomaly_type"] for row in rows)
        summary[split_name] = {
            "rows": len(rows),
            "normal_rows": labels[NORMAL_LABEL],
            "anomaly_rows": len(rows) - labels[NORMAL_LABEL],
            "anomaly_type_counts": dict(sorted(labels.items())),
        }

    metadata = {
        "data_source": DATA_SOURCE,
        "synthetic_only": True,
        "real_world_accuracy_claim": False,
        "seed_note": "Each split is generated independently with a separate random seed.",
        "split_files": files,
        "feature_columns": FEATURE_COLUMNS,
        "label_columns": ["is_anomaly", "anomaly_type"],
        "scenario_id_is_a_model_feature": False,
        "scenario_splitting": "Each scenario ID appears in exactly one split.",
        "anomaly_weights": ANOMALY_WEIGHTS,
        "summary": summary,
        "generation_notes": [
            "Operational ranges and relationships are illustrative assumptions, not learned from SWERV records.",
            "Duration and delay derive from expected delivery time; distance ratios derive from expected and planned routes.",
            "Normal rows include borderline values and missing GPS pairs; generated labels are not confirmed SWERV incidents.",
        ],
    }
    metadata_path = output_directory / "synthetic_dataset_metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return {"metadata_path": str(metadata_path), "files": files, "summary": summary}


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic SWERV anomaly scenarios.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--train-size", type=int, default=7000)
    parser.add_argument("--validation-size", type=int, default=1500)
    parser.add_argument("--test-size", type=int, default=1500)
    parser.add_argument("--demo-size", type=int, default=700)
    parser.add_argument("--train-seed", type=int, default=41001)
    parser.add_argument("--validation-seed", type=int, default=41002)
    parser.add_argument("--test-seed", type=int, default=41003)
    parser.add_argument("--demo-seed", type=int, default=41004)
    arguments = parser.parse_args()

    splits = generate_splits(
        train_size=arguments.train_size,
        validation_size=arguments.validation_size,
        test_size=arguments.test_size,
        demo_size=arguments.demo_size,
        train_seed=arguments.train_seed,
        validation_seed=arguments.validation_seed,
        test_seed=arguments.test_seed,
        demo_seed=arguments.demo_seed,
    )
    report = write_splits(splits, arguments.output_dir)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
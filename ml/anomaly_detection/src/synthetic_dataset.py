"""Generate reproducible synthetic rows for anomaly-model experiments."""

from __future__ import annotations

import argparse
import csv
import json
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
    "reassignment_count",
    "assignment_event_count",
    "activity_history_complete",
    "delivery_duration_minutes",
    "status_event_count",
    "status_transition_valid",
    "agent_status_change_count",
    "agent_active_workload",
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
    "normal": 0.72,
    "gps_implausible_jump": 0.06,
    "gps_invalid_coordinates": 0.04,
    "gps_stale_update": 0.05,
    "repeated_dispatch_reassignment": 0.05,
    "unusual_delivery_duration": 0.05,
    "invalid_status_transition": 0.03,
}

PRIORITIES = ("standard", "express", "urgent")
PACKAGE_CATEGORIES = ("documents", "parcel", "food", "fragile", "heavy_goods", "other")
VEHICLE_TYPES = ("car", "van", "motorcycle", "truck", "bicycle")


def rounded(value: float, digits: int = 3) -> float:
    return round(value, digits)


def make_base_scenario(rng: random.Random) -> dict[str, Any]:
    """Create an ordinary dispatch with a mix of operational conditions."""
    scenario: dict[str, Any] = {
        "priority": rng.choice(PRIORITIES),
        "package_category": rng.choice(PACKAGE_CATEGORIES),
        "vehicle_type": rng.choice(VEHICLE_TYPES),
        "gps_distance_km": None,
        "gps_interval_minutes": None,
        "implied_speed_kmh": None,
        "gps_reported_speed_kmh": None,
        "gps_accuracy_meters": None,
        "gps_freshness_minutes": None,
        "gps_coordinates_valid": None,
        "gps_timestamps_valid": None,
        "gps_pair_available": 0,
        "reassignment_count": 0,
        "assignment_event_count": 1,
        "activity_history_complete": rng.choice((0, 1)),
        "delivery_duration_minutes": None,
        "status_event_count": rng.randint(1, 5),
        "status_transition_valid": 1,
        "agent_status_change_count": rng.randint(0, 4),
        "agent_active_workload": rng.randint(0, 8),
        "dispatch_creation_hour": rng.randrange(24),
        "data_quality_issue_count": 0,
    }

    if rng.random() < 0.88:
        interval_minutes = rounded(rng.uniform(1.0, 15.0), 2)
        # Most movement is slow urban travel; the upper end includes borderline cases.
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
        # No pair means movement cannot be assessed; it is not automatically an anomaly.
        scenario["data_quality_issue_count"] += 1

    scenario["delivery_duration_minutes"] = rounded(rng.gammavariate(3.0, 17.0), 2)
    if rng.random() < 0.08:
        # Borderline examples overlap with some long anomaly durations.
        scenario["delivery_duration_minutes"] = rounded(rng.uniform(115.0, 185.0), 2)

    return scenario


def add_anomaly(scenario: dict[str, Any], anomaly_type: str, rng: random.Random) -> None:
    """Adjust a scenario to represent one documented synthetic anomaly."""
    if anomaly_type == "gps_implausible_jump":
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
        })
        if rng.random() < 0.5:
            scenario["gps_reported_speed_kmh"] = rounded(speed + rng.uniform(-25.0, 25.0), 2)
        else:
            scenario["gps_reported_speed_kmh"] = rounded(rng.uniform(5.0, 70.0), 2)
    elif anomaly_type == "gps_invalid_coordinates":
        scenario["gps_pair_available"] = 1
        scenario["gps_coordinates_valid"] = 0
        scenario["gps_timestamps_valid"] = 1
        scenario["data_quality_issue_count"] += 1
    elif anomaly_type == "gps_stale_update":
        scenario["gps_pair_available"] = 1
        scenario["gps_coordinates_valid"] = 1
        scenario["gps_timestamps_valid"] = 1
        scenario["gps_freshness_minutes"] = rounded(rng.uniform(10.1, 90.0), 2)
        scenario["data_quality_issue_count"] += 1
    elif anomaly_type == "repeated_dispatch_reassignment":
        scenario["reassignment_count"] = rng.randint(2, 5)
        scenario["assignment_event_count"] = scenario["reassignment_count"] + 1
        scenario["activity_history_complete"] = 1
    elif anomaly_type == "unusual_delivery_duration":
        scenario["delivery_duration_minutes"] = rounded(rng.uniform(150.0, 420.0), 2)
    elif anomaly_type == "invalid_status_transition":
        scenario["status_transition_valid"] = 0
        scenario["status_event_count"] = rng.randint(1, 5)
        scenario["activity_history_complete"] = rng.choice((0, 1))
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
    """Check labels, values, and scenario identifiers before saving."""
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
        if row["is_anomaly"] not in (0, 1):
            raise ValueError("Anomaly labels must be zero or one.")
        expected_label = int(row["anomaly_type"] != NORMAL_LABEL)
        if row["is_anomaly"] != expected_label:
            raise ValueError("Anomaly label does not match its anomaly category.")
        if row["reassignment_count"] < 0 or row["delivery_duration_minutes"] < 0:
            raise ValueError("Counts and duration features cannot be negative.")
        if row["gps_pair_available"] and row["gps_distance_km"] is not None and row["gps_distance_km"] < 0:
            raise ValueError("GPS distance cannot be negative.")


def generate_splits(
    train_size: int = 7000,
    validation_size: int = 1500,
    test_size: int = 1500,
    demo_size: int = 700,
    train_seed: int = 41001,
    validation_seed: int = 41002,
    test_seed: int = 41003,
    demo_seed: int = 41004,
) -> dict[str, list[dict[str, Any]]]:
    """Generate independent scenario IDs and independently seeded splits."""
    seeds = (train_seed, validation_seed, test_seed, demo_seed)
    if len(set(seeds)) != len(seeds):
        raise ValueError("Training, validation, and test seeds must be different.")
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
            "Synthetic operational ranges are illustrative, not learned from SWERV history.",
            "Normal rows include borderline durations, GPS accuracy, workloads, priorities, and missing GPS pairs.",
            "Anomaly categories are labels for synthetic scenarios, not confirmed SWERV incidents.",
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

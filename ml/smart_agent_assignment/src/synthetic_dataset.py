"""Generate grouped, clearly labeled synthetic agent-candidate examples."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .features import DATA_SOURCE_COLUMN, GROUP_COLUMN, TARGET_COLUMN, TIME_COLUMN, RAW_FEATURE_COLUMNS


WORKSPACE = Path(__file__).resolve().parents[1]
DATASET_PATH = WORKSPACE / "data" / "processed" / "synthetic_agent_candidates.csv"
DEFAULT_SCENARIOS = 1_000
CANDIDATES_PER_SCENARIO = 10
SEED = 121
PRIORITIES = ["standard", "express", "urgent"]
CATEGORIES = ["documents", "parcel", "food", "fragile", "heavy_goods", "other"]
VEHICLES = ["car", "van", "motorcycle", "truck", "bicycle"]
REQUIRED_CAPABILITY = {
    "documents": "document_delivery", "parcel": "parcel_delivery",
    "food": "food_delivery", "fragile": "parcel_delivery",
    "heavy_goods": "heavy_goods", "other": "parcel_delivery",
}


def random_distance(randomizer: np.random.Generator, maximum: float) -> float:
    return round(float(randomizer.uniform(0.2, maximum)), 2)


def delivery_duration(
    trip_km: float,
    agent_to_pickup_km: float | None,
    priority: str,
    category: str,
    weight_kg: float,
    quantity: int,
    vehicle_type: str,
    workload_ratio: float,
    history_minutes: float | None,
    assigned_at: datetime,
    randomizer: np.random.Generator,
) -> float:
    vehicle_speed = {"car": 1.0, "van": 1.12, "motorcycle": 0.88, "truck": 1.3, "bicycle": 1.5}
    category_handling = {
        "documents": 0.94, "parcel": 1.0, "food": 1.04,
        "fragile": 1.1, "heavy_goods": 1.28, "other": 1.03,
    }
    priority_factor = {"standard": 1.0, "express": 0.9, "urgent": 0.82}
    rush_hour = 1.22 if assigned_at.hour in (7, 8, 9, 17, 18, 19) else 1.0
    pickup_approach = 0.0 if agent_to_pickup_km is None else agent_to_pickup_km * 2.5
    workload_effect = 1.0 + workload_ratio * 0.18
    history_effect = 1.0 if history_minutes is None else max(0.85, min(1.2, history_minutes / 50))
    handling = 2 + math.sqrt(weight_kg) * 0.55 + (quantity - 1) * 0.8
    base = (9 + trip_km * 3.0 + pickup_approach) * vehicle_speed[vehicle_type]
    expected = base * rush_hour * category_handling[category] * priority_factor[priority]
    expected *= workload_effect * history_effect
    noise = randomizer.normal(0, max(2.5, expected * 0.10))
    return round(max(5.0, expected + handling + noise), 2)


def generate_dataset(
    scenario_count: int = DEFAULT_SCENARIOS,
    seed: int = SEED,
    first_assignment: datetime | None = None,
    scenario_prefix: str = "dispatch-",
    randomize_assignment_times: bool = False,
) -> pd.DataFrame:
    """Build candidate rows grouped by dispatch and sorted in time."""
    if not isinstance(scenario_count, int) or scenario_count < 1:
        raise ValueError("scenario_count must be a positive integer.")
    if not scenario_prefix.strip():
        raise ValueError("scenario_prefix must not be empty.")

    randomizer = np.random.default_rng(seed)
    rows: list[dict[str, object]] = []
    first_time = first_assignment or datetime(2025, 1, 1, tzinfo=timezone.utc)
    if first_time.utcoffset() is None:
        raise ValueError("first_assignment must include a timezone.")
    for scenario_index in range(scenario_count):
        if randomize_assignment_times:
            assigned_at = first_time + timedelta(
                days=scenario_index // 6,
                hours=int(randomizer.integers(0, 24)),
                minutes=int(randomizer.integers(0, 60)),
            )
        else:
            assigned_at = first_time + timedelta(hours=scenario_index * 4)
        priority = str(randomizer.choice(PRIORITIES, p=[0.68, 0.24, 0.08]))
        category = str(randomizer.choice(CATEGORIES, p=[0.12, 0.5, 0.17, 0.08, 0.07, 0.06]))
        weight = round(float(randomizer.uniform(0.2, 40)), 2)
        quantity = int(randomizer.integers(1, 5))
        trip_distance = random_distance(randomizer, 22)
        for candidate_index in range(CANDIDATES_PER_SCENARIO):
            capacity = int(randomizer.integers(2, 9))
            workload = int(randomizer.integers(0, capacity))
            fresh = bool(randomizer.random() < 0.78)
            pickup_distance = random_distance(randomizer, 18) if fresh else None
            completed_count = int(randomizer.integers(0, 70))
            historical_median = (
                round(max(1.0, float(randomizer.normal(48, 13))), 2)
                if completed_count >= 10 else None
            )
            vehicle = str(randomizer.choice(VEHICLES))
            required = REQUIRED_CAPABILITY[category]
            if priority in ("express", "urgent"):
                required = f"{required}|express_delivery"
            capabilities = required
            weight_factor = weight
            duration = delivery_duration(
                trip_distance, pickup_distance, priority, category, weight_factor,
                quantity, vehicle, workload / capacity, historical_median,
                assigned_at.astimezone(timezone(timedelta(hours=5, minutes=30))), randomizer,
            )
            rows.append({
                GROUP_COLUMN: f"{scenario_prefix}{scenario_index + 1:05d}",
                "candidate_index": candidate_index,
                TIME_COLUMN: assigned_at.isoformat().replace("+00:00", "Z"),
                "priority": priority,
                "package_category": category,
                "weight_kg": weight,
                "quantity": quantity,
                "pickup_to_destination_km": trip_distance,
                "agent_to_pickup_km": pickup_distance,
                "active_workload": workload,
                "max_capacity": capacity,
                "workload_ratio": round(workload / capacity, 4),
                "vehicle_type": vehicle,
                "capability_profile": capabilities,
                "gps_fresh": int(fresh),
                "completed_delivery_count": completed_count,
                "historical_median_minutes": historical_median,
                TARGET_COLUMN: duration,
                DATA_SOURCE_COLUMN: "synthetic",
            })

    dataset = pd.DataFrame(rows)
    validate_dataset(dataset)
    return dataset


def validate_dataset(dataset: pd.DataFrame) -> None:
    required = set(RAW_FEATURE_COLUMNS) | {
        GROUP_COLUMN, "candidate_index", TARGET_COLUMN, DATA_SOURCE_COLUMN,
    }
    missing = sorted(required - set(dataset.columns))
    if missing:
        raise ValueError(f"Dataset is missing columns: {', '.join(missing)}")
    if dataset.empty or not dataset[DATA_SOURCE_COLUMN].eq("synthetic").all():
        raise ValueError("Dataset must contain rows labeled synthetic.")
    if dataset.duplicated([GROUP_COLUMN, "candidate_index"]).any():
        raise ValueError("Duplicate candidate rows were found within a dispatch scenario.")
    times = pd.to_datetime(dataset[TIME_COLUMN], utc=True, errors="coerce")
    if times.isna().any():
        raise ValueError("Recommendation timestamps must be valid.")
    duration = pd.to_numeric(dataset[TARGET_COLUMN], errors="coerce")
    if duration.isna().any() or not np.isfinite(duration).all() or not duration.gt(0).all():
        raise ValueError("Synthetic durations must be positive.")
    for column in (
        "weight_kg", "quantity", "pickup_to_destination_km", "active_workload",
        "max_capacity", "workload_ratio", "completed_delivery_count",
    ):
        numbers = pd.to_numeric(dataset[column], errors="coerce")
        if numbers.isna().any() or not np.isfinite(numbers).all() or (numbers < 0).any():
            raise ValueError(f"{column} must contain finite non-negative values.")
    gps_distance = pd.to_numeric(dataset["agent_to_pickup_km"], errors="coerce")
    if (gps_distance.dropna() < 0).any() or not np.isfinite(gps_distance.dropna()).all():
        raise ValueError("Agent-to-pickup distances must be finite and non-negative.")
    historical = pd.to_numeric(dataset["historical_median_minutes"], errors="coerce")
    if (historical.dropna() <= 0).any() or not np.isfinite(historical.dropna()).all():
        raise ValueError("Historical durations must be finite and positive when present.")
    if (dataset["max_capacity"] <= 0).any() or (dataset["active_workload"] >= dataset["max_capacity"]).any():
        raise ValueError("Synthetic candidates must have remaining capacity.")
    if not dataset["priority"].isin(PRIORITIES).all() or not dataset["package_category"].isin(CATEGORIES).all():
        raise ValueError("Priority or package category is not supported.")


def main() -> None:
    dataset = generate_dataset()
    DATASET_PATH.parent.mkdir(parents=True, exist_ok=True)
    dataset.to_csv(DATASET_PATH, index=False)
    print(json.dumps({
        "candidate_records": len(dataset),
        "dispatch_scenarios": dataset[GROUP_COLUMN].nunique(),
        "data_source": "synthetic",
        "dataset_path": str(DATASET_PATH),
    }, indent=2))


if __name__ == "__main__":
    main()

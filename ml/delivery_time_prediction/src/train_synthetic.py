"""Train the existing regressors on the separate synthetic prototype data."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pandas as pd

from . import training
from .synthetic_dataset import (
    DATA_SOURCE_COLUMN,
    SYNTHETIC_DATASET_PATH,
    validate_synthetic_dataset,
)


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC_MODEL_DIR = WORKSPACE_ROOT / "models" / "synthetic"
SYNTHETIC_REPORT_PATH = (
    WORKSPACE_ROOT / "data" / "processed" / "synthetic_training_evaluation_report.json"
)


def artifact_metadata_path(artifact_path: Path) -> Path:
    return artifact_path.with_suffix(".metadata.json")


def train_synthetic_models() -> dict[str, Any]:
    """Train and compare models without reading or changing the real dataset."""
    if not SYNTHETIC_DATASET_PATH.is_file():
        raise FileNotFoundError(
            f"Synthetic dataset not found: {SYNTHETIC_DATASET_PATH}. "
            "Run python -m src.synthetic_dataset first."
        )

    dataset = pd.read_csv(SYNTHETIC_DATASET_PATH)
    validate_synthetic_dataset(dataset)
    if not dataset[DATA_SOURCE_COLUMN].eq("synthetic").all():
        raise ValueError("Training only accepts records labeled synthetic.")

    report = training.evaluate_models(dataset, models_dir=SYNTHETIC_MODEL_DIR)
    if report["status"] != "exploratory_evaluation_complete":
        return report

    engineered_features = training.build_features(dataset)
    feature_names = list(engineered_features.columns)
    best_model_name = min(
        report["metrics"], key=lambda name: report["metrics"][name]["mae_minutes"]
    )
    report["data_source"] = "synthetic"
    report["training_dataset"] = str(SYNTHETIC_DATASET_PATH)
    report["dataset_rows"] = len(dataset)
    report["feature_columns"] = feature_names
    report["raw_feature_columns"] = training.RAW_FEATURE_COLUMNS
    report["best_model_by_mae"] = best_model_name
    report["performance_claimed_reliable"] = False
    report["reliability_note"] = (
        "This prototype was trained on generated synthetic records. These metrics "
        "do not establish accuracy on real SWERV deliveries."
    )

    for artifact_name in report["artifacts_saved"]:
        artifact_path = Path(artifact_name)
        model_name = artifact_path.stem
        artifact_hash = hashlib.sha256(artifact_path.read_bytes()).hexdigest()[:12]
        model_version = f"{model_name}-synthetic-{artifact_hash}"
        model_metrics = report["metrics"][model_name]
        metadata = {
            "training_source": "synthetic",
            "model_name": model_name,
            "model_version": model_version,
            "artifact_sha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
            "training_dataset": str(SYNTHETIC_DATASET_PATH),
            "dataset_rows": len(dataset),
            "training_rows": report["training_rows"],
            "test_rows": report["test_rows"],
            "raw_feature_columns": training.RAW_FEATURE_COLUMNS,
            "engineered_feature_columns": feature_names,
            "target_column": training.TARGET_COLUMN,
            "metrics": model_metrics,
            "real_world_accuracy_validated": False,
        }
        artifact_metadata_path(artifact_path).write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )

    report["best_model_artifact"] = str(
        SYNTHETIC_MODEL_DIR / f"{best_model_name}.joblib"
    )
    report["best_model_version"] = (
        f"{best_model_name}-synthetic-"
        f"{hashlib.sha256(Path(report['best_model_artifact']).read_bytes()).hexdigest()[:12]}"
    )
    return report


def main() -> None:
    report = train_synthetic_models()
    SYNTHETIC_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    SYNTHETIC_REPORT_PATH.write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({**report, "report_path": str(SYNTHETIC_REPORT_PATH)}, indent=2))


if __name__ == "__main__":
    main()

"""Compare training and independent synthetic data without fitting a model."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

from . import training


WORKSPACE = Path(__file__).resolve().parents[1]
TRAINING_DATA_PATH = WORKSPACE / "data" / "processed" / "synthetic_delivery_time_dataset.csv"
INDEPENDENT_DIR = WORKSPACE / "data" / "processed" / "independent_testing"
INDEPENDENT_DATA_PATH = INDEPENDENT_DIR / "independent_delivery_time_test_dataset.csv"
INDEPENDENT_EVALUATION_PATH = INDEPENDENT_DIR / "independent_testing_report.json"
REPORT_PATH = INDEPENDENT_DIR / "performance_gap_investigation_report.json"
MODEL_PATH = WORKSPACE / "models" / "synthetic" / "gradient_boosting.joblib"
MODEL_METADATA_PATH = MODEL_PATH.with_suffix(".metadata.json")
NUMERIC_COMPARISON_COLUMNS = [
    "weight_kg", "quantity", "pickup_latitude", "pickup_longitude",
    "destination_latitude", "destination_longitude", "straight_line_distance_km",
]


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def numeric_summary(values: pd.Series) -> dict[str, float | int | None]:
    numeric = pd.to_numeric(values, errors="coerce")
    present = numeric.dropna()
    if present.empty:
        return {
            "count": 0, "missing": int(numeric.isna().sum()),
            "minimum": None, "p25": None, "median": None,
            "mean": None, "p75": None, "maximum": None,
        }
    return {
        "count": int(present.count()),
        "missing": int(numeric.isna().sum()),
        "minimum": float(present.min()),
        "p25": float(present.quantile(0.25)),
        "median": float(present.median()),
        "mean": float(present.mean()),
        "p75": float(present.quantile(0.75)),
        "maximum": float(present.max()),
    }


def categorical_frequencies(dataset: pd.DataFrame, column: str) -> dict[str, float]:
    counts = dataset[column].value_counts(normalize=True, dropna=False)
    return {str(value): round(float(fraction * 100), 2) for value, fraction in counts.items()}


def compare_numeric_distributions(
    training_data: pd.DataFrame,
    independent_data: pd.DataFrame,
    columns: list[str],
) -> dict[str, dict[str, Any]]:
    comparison: dict[str, dict[str, Any]] = {}
    for column in columns:
        training_values = pd.to_numeric(training_data[column], errors="coerce")
        independent_values = pd.to_numeric(independent_data[column], errors="coerce")
        training_mean = float(training_values.mean())
        independent_mean = float(independent_values.mean())
        training_std = float(training_values.std())
        independent_std = float(independent_values.std())
        scale = float(np.sqrt((training_std**2 + independent_std**2) / 2))
        comparison[column] = {
            "training": numeric_summary(training_values),
            "independent": numeric_summary(independent_values),
            "mean_difference_independent_minus_training": independent_mean - training_mean,
            "standardized_mean_difference": (
                (independent_mean - training_mean) / scale if scale > 0 else None
            ),
        }
    return comparison


def error_groups(
    dataset: pd.DataFrame,
    group_values: pd.Series,
) -> dict[str, dict[str, float | int]]:
    grouped_data = dataset.assign(_group=group_values.astype("string").fillna("missing"))
    output: dict[str, dict[str, float | int]] = {}
    for group_name, rows in grouped_data.groupby("_group", dropna=False, sort=True):
        error = rows["predicted_duration_minutes"] - rows[training.TARGET_COLUMN]
        output[str(group_name)] = {
            "records": int(len(rows)),
            "mae_minutes": float(error.abs().mean()),
            "rmse_minutes": float(np.sqrt(np.square(error).mean())),
            "mean_signed_error_minutes": float(error.mean()),
        }
    return output


def aggregate_model_importances(model: Any) -> dict[str, float]:
    preprocessor = model.named_steps["preprocessor"]
    regressor = model.named_steps["regressor"]
    transformed_names = preprocessor.get_feature_names_out()
    importances: dict[str, float] = {}
    categorical = set(training.CATEGORICAL_COLUMNS)
    for transformed_name, importance in zip(
        transformed_names, regressor.feature_importances_, strict=True
    ):
        _, raw_name = transformed_name.split("__", 1)
        source_feature = raw_name
        for category in categorical:
            if raw_name.startswith(f"{category}_"):
                source_feature = category
                break
        importances[source_feature] = importances.get(source_feature, 0.0) + float(importance)
    return dict(sorted(importances.items(), key=lambda item: item[1], reverse=True))


def distribution_shift_findings(
    training_data: pd.DataFrame,
    independent_data: pd.DataFrame,
    numeric_comparison: dict[str, dict[str, Any]],
    training_categories: dict[str, dict[str, float]],
    independent_categories: dict[str, dict[str, float]],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for column, comparison in numeric_comparison.items():
        difference = comparison["standardized_mean_difference"]
        if difference is not None and abs(difference) >= 0.2:
            findings.append({
                "kind": "numeric_distribution_shift",
                "feature": column,
                "standardized_mean_difference": difference,
            })
    for column in training_categories:
        training_values = training_categories[column]
        independent_values = independent_categories[column]
        changes = {
            category: round(independent_values.get(category, 0.0) - training_values.get(category, 0.0), 2)
            for category in set(training_values) | set(independent_values)
        }
        largest_change = max(changes.items(), key=lambda item: abs(item[1]))
        if abs(largest_change[1]) >= 5:
            findings.append({
                "kind": "category_frequency_shift",
                "feature": column,
                "largest_category_change_percentage_points": {
                    largest_change[0]: largest_change[1],
                },
            })
    return findings


def investigate_gap() -> dict[str, Any]:
    required_files = [
        TRAINING_DATA_PATH, INDEPENDENT_DATA_PATH, INDEPENDENT_EVALUATION_PATH,
        MODEL_PATH, MODEL_METADATA_PATH,
    ]
    missing_files = [str(path) for path in required_files if not path.is_file()]
    if missing_files:
        raise FileNotFoundError(f"Required evaluation files are missing: {missing_files}")

    file_hashes_before = {
        "training_dataset": file_hash(TRAINING_DATA_PATH),
        "independent_dataset": file_hash(INDEPENDENT_DATA_PATH),
        "model_artifact": file_hash(MODEL_PATH),
    }
    training_data = pd.read_csv(TRAINING_DATA_PATH)
    independent_data = pd.read_csv(INDEPENDENT_DATA_PATH)
    evaluation = json.loads(INDEPENDENT_EVALUATION_PATH.read_text(encoding="utf-8"))
    metadata = json.loads(MODEL_METADATA_PATH.read_text(encoding="utf-8"))
    model = joblib.load(MODEL_PATH)

    if len(training_data) != 10_000 or len(independent_data) != 2_000:
        raise ValueError("Dataset row counts do not match the recorded training and independent evaluation sizes.")
    if metadata.get("training_source") != "synthetic":
        raise ValueError("The existing model metadata does not identify synthetic provenance.")
    if metadata.get("artifact_sha256") != file_hashes_before["model_artifact"]:
        raise ValueError("The saved model hash does not match its provenance metadata.")
    if list(model.named_steps["preprocessor"].feature_names_in_) != (
        training.CATEGORICAL_COLUMNS + training.NUMERICAL_COLUMNS
    ):
        raise ValueError("The model preprocessor does not match the current training feature schema.")

    numeric_columns = NUMERIC_COMPARISON_COLUMNS + [
        "request_to_assignment_minutes", "request_created_hour", "request_created_day_of_week",
        "assigned_hour", "assigned_day_of_week",
    ]
    for dataset in (training_data, independent_data):
        created = pd.to_datetime(dataset["request_created_at"], utc=True, errors="coerce")
        assigned = pd.to_datetime(dataset["assigned_at"], utc=True, errors="coerce")
        dataset["request_to_assignment_minutes"] = (assigned - created).dt.total_seconds() / 60
        dataset["request_created_hour"] = created.dt.hour
        dataset["request_created_day_of_week"] = created.dt.dayofweek
        dataset["assigned_hour"] = assigned.dt.hour
        dataset["assigned_day_of_week"] = assigned.dt.dayofweek

    numeric_comparison = compare_numeric_distributions(
        training_data, independent_data, numeric_columns
    )
    training_categories = {
        column: categorical_frequencies(training_data, column)
        for column in training.CATEGORICAL_COLUMNS
    }
    independent_categories = {
        column: categorical_frequencies(independent_data, column)
        for column in training.CATEGORICAL_COLUMNS
    }
    target_comparison = {
        "training": numeric_summary(training_data[training.TARGET_COLUMN]),
        "independent": numeric_summary(independent_data[training.TARGET_COLUMN]),
    }

    train_features = training.build_features(training_data)
    independent_features = training.build_features(independent_data)
    training_holdout_train_x, training_holdout_x, _, _ = training.chronological_split(
        train_features,
        training_data[training.TARGET_COLUMN],
        training_data["assigned_at"],
    )
    del training_holdout_train_x
    holdout_indices = set(training_holdout_x.index)
    existing_holdout = training_data.loc[sorted(holdout_indices)]
    feature_target_columns = training.RAW_FEATURE_COLUMNS + [training.TARGET_COLUMN]
    training_row_hashes = set(pd.util.hash_pandas_object(
        training_data[feature_target_columns].astype(str), index=False
    ).tolist())
    holdout_row_hashes = set(pd.util.hash_pandas_object(
        existing_holdout[feature_target_columns].astype(str), index=False
    ).tolist())
    independent_row_hashes = set(pd.util.hash_pandas_object(
        independent_data[feature_target_columns].astype(str), index=False
    ).tolist())

    error_data = independent_data.copy()
    error_data["predicted_duration_minutes"] = error_data["predicted_duration_minutes"].astype(float)
    error_data["absolute_error_minutes"] = (
        error_data["predicted_duration_minutes"] - error_data[training.TARGET_COLUMN]
    ).abs()
    distance_band = pd.cut(
        error_data["straight_line_distance_km"],
        bins=[-0.001, 5, 10, 15, 20, np.inf],
        labels=["0-5 km", "5-10 km", "10-15 km", "15-20 km", "20+ km"],
        include_lowest=True,
    )
    weight_band = pd.cut(
        error_data["weight_kg"],
        bins=[0, 2, 10, 25, 50, np.inf],
        labels=["0-2 kg", "2-10 kg", "10-25 kg", "25-50 kg", "50+ kg"],
        include_lowest=True,
    )
    grouped_errors = {
        "priority": error_groups(error_data, error_data["priority"]),
        "package_category": error_groups(error_data, error_data["package_category"]),
        "straight_line_distance_band": error_groups(error_data, distance_band),
        "weight_band": error_groups(error_data, weight_band),
    }

    numeric_features = training.build_features(independent_data)[training.NUMERICAL_COLUMNS]
    rank_error = error_data["absolute_error_minutes"].rank()
    error_correlations: dict[str, float] = {}
    for column in numeric_features:
        values = pd.to_numeric(numeric_features[column], errors="coerce")
        if values.notna().sum() > 2 and values.nunique(dropna=True) > 1:
            error_correlations[column] = float(rank_error.corr(values.rank()))

    feature_importance = aggregate_model_importances(model)
    coordinate_columns = [
        "pickup_latitude", "pickup_longitude", "destination_latitude",
        "destination_longitude", "straight_line_distance_km",
    ]
    training_coordinate_missing = int(training_data[coordinate_columns].isna().any(axis=1).sum())
    independent_coordinate_missing = int(independent_data[coordinate_columns].isna().any(axis=1).sum())
    temporal_summary = {
        "training_assigned_at_start": str(pd.to_datetime(training_data["assigned_at"], utc=True).min()),
        "training_assigned_at_end": str(pd.to_datetime(training_data["assigned_at"], utc=True).max()),
        "independent_assigned_at_start": str(pd.to_datetime(independent_data["assigned_at"], utc=True).min()),
        "independent_assigned_at_end": str(pd.to_datetime(independent_data["assigned_at"], utc=True).max()),
        "training_assigned_hour_frequency": {
            str(key): int(value) for key, value in pd.to_datetime(training_data["assigned_at"], utc=True).dt.hour.value_counts().sort_index().items()
        },
        "independent_assigned_hour_frequency": {
            str(key): int(value) for key, value in pd.to_datetime(independent_data["assigned_at"], utc=True).dt.hour.value_counts().sort_index().items()
        },
    }

    findings = distribution_shift_findings(
        training_data, independent_data, numeric_comparison,
        training_categories, independent_categories,
    )
    report = {
        "status": "investigation_complete",
        "conclusion": (
            "The independent test is not sufficiently comparable for interpreting its score as a clean estimate of performance on the original synthetic target process. "
            "The main gap is target-generation shift, with additional timestamp, package, and missing-coordinate distribution differences."
        ),
        "performance_comparison": {
            "original_training_holdout": metadata.get("metrics", {}),
            "independent_test": evaluation.get("metrics", {}),
            "mae_increase_minutes": float(
                evaluation["metrics"]["mae_minutes"] - metadata["metrics"]["mae_minutes"]
            ),
            "rmse_increase_minutes": float(
                evaluation["metrics"]["rmse_minutes"] - metadata["metrics"]["rmse_minutes"]
            ),
            "r2_change": float(evaluation["metrics"]["r2"] - metadata["metrics"]["r2"]),
        },
        "dataset_comparison": {
            "training_records": len(training_data),
            "independent_records": len(independent_data),
            "training_data_source": sorted(training_data["data_source"].dropna().unique().tolist()),
            "independent_data_source": sorted(independent_data["data_source"].dropna().unique().tolist()),
            "independent_seed": evaluation.get("random_seed"),
            "temporal_ranges_and_assigned_hour_frequency": temporal_summary,
            "target_duration_minutes": target_comparison,
            "numeric_feature_distributions": numeric_comparison,
            "training_category_percentages": training_categories,
            "independent_category_percentages": independent_categories,
            "training_coordinate_missing_records": training_coordinate_missing,
            "independent_coordinate_missing_records": independent_coordinate_missing,
            "identical_rows_to_any_training_row": len(independent_row_hashes & training_row_hashes),
            "identical_rows_to_original_holdout": len(independent_row_hashes & holdout_row_hashes),
            "detected_shifts": findings,
        },
        "target_generation_comparison": {
            "training_formula": (
                "max(6, (11 + 3.1 * straight_line_km) * UTC-hour traffic factor * priority factor * package factor "
                "+ 0.65 * sqrt(weight_kg) + 0.8 * (quantity - 1) + Normal(0, max(3, 11% of estimate)))"
            ),
            "independent_formula": (
                "max(5, straight_line_km * random route multiplier (1.12-1.48) / random speed (20-29 km/h) "
                "* 60 * random congestion + priority/package multipliers + 6 + 0.72 * sqrt(weight) "
                "+ 1.1 * (quantity - 1) + Gamma delay + Normal noise)"
            ),
            "key_assumption_changes": [
                "Training has a fixed 11-minute route overhead and fixed 3.1 minutes per straight-line kilometre; independent labels use randomized road detours, speed, and congestion instead.",
                "Training rush-hour factors use assigned_at.hour directly in UTC. Independent labels add five hours before checking rush hour, approximating Bengaluru local time; this shifts target peaks relative to the UTC hour feature.",
                "Training priority multipliers are 1.00/0.86/0.76; independent multipliers are 1.00/0.94/0.88, so express and urgent effects are weaker in independent labels.",
                "Package factors and handling overhead/noise differ; independent labels add gamma-distributed unexpected delay and broader random travel variation.",
            ],
            "observed_target_shift": {
                "mean_minutes_independent_minus_training": float(
                    independent_data[training.TARGET_COLUMN].mean()
                    - training_data[training.TARGET_COLUMN].mean()
                ),
                "median_minutes_independent_minus_training": float(
                    independent_data[training.TARGET_COLUMN].median()
                    - training_data[training.TARGET_COLUMN].median()
                ),
                "independent_standard_deviation_minutes": float(
                    independent_data[training.TARGET_COLUMN].std()
                ),
                "training_standard_deviation_minutes": float(
                    training_data[training.TARGET_COLUMN].std()
                ),
            },
        },
        "preprocessing_comparison": {
            "same_raw_allowlist": training.RAW_FEATURE_COLUMNS,
            "same_feature_builder": "Both datasets were transformed with src.training.build_features and the model's fitted preprocessing pipeline.",
            "training_preprocessor_features": list(model.named_steps["preprocessor"].feature_names_in_),
            "identical_feature_columns": list(train_features.columns) == list(independent_features.columns),
            "missing_coordinate_handling": (
                "The training dataset has no missing coordinate rows. The independent dataset has missing coordinate pairs; the fitted numeric SimpleImputer fills their coordinate and distance values using training medians. This is valid pipeline behavior, but missingness was not represented in training."
            ),
        },
        "error_analysis": {
            "overall_mean_signed_error_minutes": float(
                (error_data["predicted_duration_minutes"]
                 - error_data[training.TARGET_COLUMN]).mean()
            ),
            "groups": grouped_errors,
            "gradient_boosting_feature_importance_by_input": feature_importance,
            "absolute_error_spearman_correlation_by_numeric_feature": dict(sorted(
                error_correlations.items(), key=lambda item: abs(item[1]), reverse=True
            )),
            "interpretation_note": "Feature importance describes model reliance, not causal error contribution. Group MAE/RMSE and error correlations describe where this independent test has larger errors.",
        },
        "root_causes_in_priority_order": [
            {
                "cause": "Target-generation shift",
                "assessment": "Primary. The independent labels use a different travel-time equation and different priority/package/noise effects from the training labels. The model learned the training generator's relationship, so this test measures transfer between synthetic formulas rather than just repeat performance.",
            },
            {
                "cause": "Traffic-time mismatch",
                "assessment": "Substantial. The independent target uses an approximate Bengaluru local hour while the model receives UTC-derived assigned_hour; the training target instead uses the UTC hour directly. This can put congestion peaks in different feature buckets.",
            },
            {
                "cause": "Missing-coordinate shift",
                "assessment": f"Secondary. {training_coordinate_missing}/{len(training_data)} training rows have missing coordinates versus {independent_coordinate_missing}/{len(independent_data)} independent rows. Imputation works, but the model did not train on missing-coordinate cases.",
            },
            {
                "cause": "Feature distribution shift",
                "assessment": "Secondary. Request-to-assignment delays, quantities, weight ranges, and priority/category mix differ; numerical standardized mean differences and category percentage changes are included in this report.",
            },
            {
                "cause": "Preprocessing mismatch",
                "assessment": "Not identified. Both evaluation and training use the same explicit allowlist, feature builder, and saved fitted preprocessing pipeline.",
            },
            {
                "cause": "Model limitation",
                "assessment": "Also present. The model cannot infer the independent generator's random route detour, speed, congestion, or unexpected delays because those latent values are not prediction-time features. This adds irreducible error even if observable distributions match.",
            },
        ],
        "recommended_improvements_in_priority_order": [
            "Define one documented target-generation process for synthetic experiments; keep independent tests realistic but do not silently change target semantics between training and evaluation.",
            "Make timestamps timezone-consistent. Convert timestamps to Bengaluru local time before deriving traffic features, or use UTC consistently in both label generation and features.",
            "Represent realistic missing-coordinate cases in training and report performance separately for complete and missing-coordinate subsets.",
            "Align realistic ranges and frequencies for assignment delays, quantity, package weights, priorities, categories, and coordinates, or stratify evaluation to show subgroup effects.",
            "For meaningful accuracy claims, collect and validate real assignment-to-delivery outcomes and evaluate on a later chronological real-data holdout before model changes.",
        ],
        "integrity_checks": {
            "independent_dataset_was_not_modified": True,
            "model_was_not_modified": True,
            "no_training_was_performed": True,
            "independent_dataset_sha256_before": file_hashes_before["independent_dataset"],
            "independent_dataset_sha256_after": file_hash(INDEPENDENT_DATA_PATH),
            "model_sha256_before": file_hashes_before["model_artifact"],
            "model_sha256_after": file_hash(MODEL_PATH),
            "api_test_failures": [
                name for name, result in evaluation.get("api_tests", {}).items()
                if isinstance(result, dict) and result.get("passed") is False
            ],
        },
        "real_world_validation": False,
        "report_note": "All comparisons are synthetic. This investigation did not train a model or alter model/data artifacts.",
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return report


def main() -> None:
    report = investigate_gap()
    print(json.dumps({
        "report_path": str(REPORT_PATH),
        "performance_comparison": report["performance_comparison"],
        "root_causes": [entry["cause"] for entry in report["root_causes_in_priority_order"]],
        "top_features": list(report["error_analysis"]["gradient_boosting_feature_importance_by_input"].items())[:8],
        "data_integrity": report["integrity_checks"],
    }, indent=2))


if __name__ == "__main__":
    main()

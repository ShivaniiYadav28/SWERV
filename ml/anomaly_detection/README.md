# SWERV Anomaly Detection Prototype

This workspace contains reproducible generated scenarios, an Isolation Forest
model, explainable GPS and dispatch rules, and a standalone FastAPI service. The
model and generated evaluation data are demonstrations only; they do not
establish real-world SWERV detection accuracy.

## Current data limits

The read-only SWERV assessment found 18 dispatch requests, 51 dispatch activity
events, 5 completed deliveries, no failed deliveries, and 12 GPS points across
2 agents. The GPS points include gaps up to about 89 hours. Only 1 of 18
requests has both pickup and destination coordinate pairs. There are no planned
routes, delivery SLA deadlines, or failure reasons. Some requests also lack a
`request_created` activity event, so event history must not be assumed complete.

The current five completed deliveries are below the default duration baseline
minimum of 30. The detector reports insufficient baseline and does not label a
delivery as a duration anomaly. The six GPS point pairs are not a continuous
route history and cannot support reliable movement conclusions.

## Rules and defaults

`src/detectors.py` exposes `detect_anomalies(dispatches, dispatch_activities,
gps_locations, ...)`. It accepts already-extracted mappings and returns
findings plus limitations. It does not read customer details; callers should
project only the fields needed below.

- **GPS quality:** flags missing/out-of-range coordinates, invalid timestamps,
  recorded-to-received time ordering problems, and submissions over 10 minutes
  old. Stale or invalid points are excluded from movement analysis.
- **GPS jumps:** groups points by agent and uses Haversine distance. It subtracts
  both reported accuracy radii before calculating speed and only compares fresh
  points with accuracy at most 100 m and a gap at most 15 minutes. It flags a
  conservative speed above 160 km/h. Larger gaps or poor accuracy are skipped
  and reported as limitations.
- **Repeated reassignment:** counts assignment changes after the first
  assignment. The default threshold is 2 reassignments (3 assignment events).
  It only flags a dispatch when its ID is explicitly included in
  `complete_activity_history_ids`; otherwise it reports that the visible event
  history is unverified and suppresses the alert.
- **Unusual duration:** uses the latest assignment before pickup and the
  `status_changed` event whose new status is `delivered`. It never uses
  `DispatchRequest.updatedAt`. With at least 30 valid deliveries, it flags a
  long duration above Q3 + 3 x IQR. Smaller samples produce an insufficient
  baseline limitation, not an anomaly.
- **Invalid status transition:** checks each `status_changed` event's explicit
  `previousValue.status` and `newValue.status` against SWERV's lifecycle:
  `pending -> assigned/cancelled`, `assigned -> picked_up/cancelled`,
  `picked_up -> in_transit/failed`, `in_transit -> delivered/failed`; terminal
  states have no outgoing transitions. When the prior status is absent, the
  detector does not guess from potentially incomplete history. Exact duplicate
  status events are ignored and recorded as a data-quality limitation.

All thresholds are configurable through `DetectionConfig`. Findings include
type, severity, relevant dispatch or agent ID, evidence timestamp, explanation,
measured value, threshold, method, and data-quality notes. A finding is an
evidence-based review prompt, not a conclusion about intent or wrongdoing.

## Input fields

Pass only operational fields that are needed by the detectors:

- Dispatch: `_id`, `status`, and `assignedAgent`.
- Dispatch activity: `dispatchRequestId`, `eventType`, `createdAt`,
  `previousValue.status`, and `newValue.status` / `newValue.agentId`.
- GPS: `agentId`, `latitude`, `longitude`, `accuracy`, `recordedAt`, and
  `receivedAt`.

Do not pass customer names, emails, phone numbers, full addresses, instructions,
passwords, device credentials, or tracking tokens. In a future extractor,
explicitly establish activity-history completeness before marking a dispatch
complete. Current database observations are not marked complete by this
prototype.

## Tests

Tests use hand-built synthetic fixtures only. They are not copied from MongoDB
and are not evidence of real-world detection accuracy.

From this directory, run:

```powershell
python -m unittest discover -s tests -v
```

The rule functions use only the Python standard library. `requirements.txt`
lists NumPy, Pandas, scikit-learn, Joblib, FastAPI, and Uvicorn for model
training and the standalone API service.

## Synthetic scenario dataset

Generate separate, independently seeded scenario files with:

```powershell
python -m src.synthetic_dataset
```

The defaults create 7,000 training, 1,500 validation, and 1,500 independent
test scenarios, plus a separate 700-row `demo` split under
`data/processed/synthetic/`. The demo split uses its own seed and is excluded
from training, validation, threshold selection, and final testing. It is read
only when an Admin selects Synthetic Demo Mode. The generator writes a
metadata JSON file with provenance, seeds, row counts, and class counts. Each
row has a unique split-prefixed `scenario_id`; scenario identifiers and
`anomaly_type` are labels, not model features. No rows are copied from MongoDB.
The illustrative class prior is 88% normal and 1.5% for each of the eight
anomaly categories; it is a generator assumption, not an observed SWERV rate.

The labels are normal operations plus delivery delay, GPS coordinate jump,
route deviation, repeated delivery failures, unusual agent activity, suspicious
dispatch pattern, abnormal delivery duration, and abnormal delivery distance.
Features connect observed values to expected duration, planned distance, agent
activity, failure counts, and dispatch burst context. Normal rows retain
borderline values and missing GPS pairs, which are not anomalies on their own.

The generated ranges are illustrative and have not been calibrated against the
small SWERV sample. Synthetic labels describe generated scenarios only; model
scores on these files cannot establish real-world SWERV anomaly accuracy.

## Model training and evaluation

Train the primary Isolation Forest after dataset generation:

```powershell
python -m src.training
```

The preprocessor is fitted on training features only. Isolation Forest learns
from training feature values without receiving anomaly labels. The
contamination estimate is the anomaly prevalence in the validation split; the
score threshold is selected on that same validation split to maximize F1 while
keeping false-positive rate at or below 10% where possible. The independent
test is scored only after both values are fixed. Category recall is binary
anomaly recall within each generated label, not a category classifier score.

Current seeded generated-data results:

| Split | Precision | Recall | F1 | Accuracy | FPR | FNR | ROC-AUC | PR-AUC | Confusion matrix (TN, FP, FN, TP) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Validation | 0.797 | 0.648 | 0.715 | 0.939 | 0.022 | 0.352 | 0.930 | 0.780 | 1,295, 29, 62, 114 |
| Independent test | 0.759 | 0.658 | 0.705 | 0.928 | 0.031 | 0.342 | 0.930 | 0.780 | 1,263, 41, 67, 129 |

The selected model version is `isolation_forest-synthetic-b3c24dbf05ff`.
Independent-test binary detection recall by generated category was: abnormal
delivery distance 1.000, abnormal delivery duration 1.000, delivery delay
0.147, GPS coordinate jump 0.190, repeated delivery failures 1.000, route
deviation 0.333, suspicious dispatch pattern 0.913, and unusual agent activity
0.947. The low recall for delays and GPS jumps is a material limitation of this
model and generated feature design; the binary detector does not return a
predicted category for those candidates.

All scores measure agreement with generated labels only. The generated
category frequencies and feature relationships are illustrative assumptions;
these metrics are not evidence of real-world fleet performance.

Artifacts and reports are saved under:

- `models/synthetic/anomaly_detector.joblib`
- `models/synthetic/anomaly_detector.metadata.json`
- `data/processed/synthetic/model_selection_report.json`
- `data/processed/synthetic/independent_test_report.json`

The training report records validation selection details and test metrics
separately. Training also writes the model artifact SHA-256 digest to its
metadata sidecar and verifies the digest immediately after saving. The test
suite checks that a changed artifact fails integrity verification.

## FastAPI service

Start the separate service on port 8005 from this directory:

```powershell
$env:ANOMALY_DETECTION_API_KEY = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
python -m uvicorn src.api:app --host 127.0.0.1 --port 8005
```

The service loads the pinned artifact once at startup. It verifies the SHA-256
and metadata before Joblib deserialization, then checks the loaded estimator
and all 35 feature names. A failed check leaves the service running in
model-unavailable mode; it never falls back to another artifact or trains a
replacement. Set `ANOMALY_DETECTION_API_KEY` to a random secret of at least 32
characters in the service process. Never commit the value or expose it to
browser code.

`GET /health` is public and reports model availability, pinned model version,
artifact integrity, feature-schema compatibility, demo-data availability, and
training provenance. Authenticated `POST /predict` accepts only strict feature
vectors, requires `detection_mode: "synthetic_demo"`, and rejects unexpected
fields, including operational record structures. Authenticated
`POST /analyze-demo` accepts no body (or `{}`) and loads a fixed 30-scenario
sample from the service's own generated demo split.

Prediction responses include the binary candidate, outlier score, decision
threshold, severity band, timestamp, and model version. The score is not a
probability. For candidates, score excess below 0.01 is low, 0.01 to below 0.04
is medium, 0.04 to below 0.10 is high, and 0.10 or more is critical. Scores at
or below the threshold have severity `none`. These model-specific bands are not
operational risk calibration. Demo `scenario_category` is the generated label,
not an Isolation Forest prediction; the response marks its source explicitly.

Example request shape (all listed model feature fields are required; GPS
measurements that are unavailable may be `null`):

```json
{
  "detection_mode": "synthetic_demo",
  "scenarios": [{
    "features": {
      "gps_distance_km": 1.2,
      "gps_interval_minutes": 5.0,
      "implied_speed_kmh": 14.4,
      "gps_reported_speed_kmh": 13.0,
      "gps_accuracy_meters": 18.0,
      "gps_freshness_minutes": 1.5,
      "gps_coordinates_valid": 1,
      "gps_timestamps_valid": 1,
      "gps_pair_available": 1,
      "expected_delivery_duration_minutes": 50,
      "reassignment_count": 0,
      "assignment_event_count": 1,
      "activity_history_complete": 1,
      "delivery_duration_minutes": 38.0,
      "delivery_delay_minutes": 0,
      "expected_delivery_distance_km": 10,
      "delivery_distance_km": 12,
      "planned_route_distance_km": 11,
      "actual_route_distance_km": 12,
      "route_deviation_ratio": 1.091,
      "distance_to_expected_ratio": 1.2,
      "failed_delivery_attempts": 0,
      "agent_failed_deliveries_7d": 0,
      "status_event_count": 4,
      "status_transition_valid": 1,
      "agent_status_change_count": 1,
      "agent_activity_ratio": 1.0,
      "agent_active_workload": 2,
      "dispatch_burst_count_10m": 1,
      "dispatch_repeat_route_count_1h": 1,
      "dispatch_creation_hour": 14,
      "data_quality_issue_count": 0,
      "priority": "standard",
      "package_category": "parcel",
      "vehicle_type": "motorcycle"
    }
  }]
}
```

`GET /health` and `POST /predict` do not read MongoDB. The Node backend is
expected to call this service; browsers should not connect to it directly.

## Node.js backend and Admin dashboard

The backend exposes Admin-only session-cookie APIs under `/api/anomaly-detection`:

- `POST /detect` with `{ "mode": "real" }` or `{ "mode": "synthetic_demo" }`.
- `GET /summary?mode=real|synthetic_demo`.
- `GET /alerts?mode=...&severity=...&anomalyType=...&reviewStatus=...&page=1&limit=20`.
- `GET /alerts/:id?mode=...`.
- `PATCH /alerts/:id/review?mode=...` with review status and optional notes.

The browser must not contact port 8005. Stage 3 does not modify the existing
Node integration: it does not yet send `ANOMALY_DETECTION_API_KEY` and its old
`/predict` request includes real mode/raw-record fields, which this service
rejects. Do not use the current real-mode detector until Stage 4 updates the
backend to call `/analyze-demo` without sending any scenario or operational
records. The backend route and alert-review code remain otherwise unchanged.

Real alerts use the `anomaly_alerts` collection. Demo alerts use the separate
`anomaly_demo_alerts` collection, with independent summaries and history. A
unique key prevents concurrent duplicate inserts for the same anomaly, entity,
and evidence hour. Admins can mark alerts under review, resolved, or dismissed
and save notes; review actions do not trigger operational changes.

The existing Admin page is `/admin/anomaly-detection`; its frontend/backend
workflow is outside Stage 3 and must be aligned with the new response in Stage
4. The service itself reads only its generated `synthetic_demo.csv` for
`/analyze-demo`. No customer, agent, dispatch, or delivery records are accepted
or sent by these endpoints. Real-world SWERV accuracy remains unknown.

## Remaining work

Collect a longer, privacy-conscious real history; validate timestamps and event
completeness; review rule findings with Admins; then evaluate rules against
those review labels. The generated Isolation Forest artifact is not validated
for operational use, and its low generated-test recall for GPS jumps, route
deviations, and delays remains unresolved. A trustworthy planned-route source
and documented SLA are prerequisites for route-deviation and SLA-delay checks.
Complete the separately planned backend/UI integration and review manual Admin
workflows before relying on alerts; real-world model accuracy remains unknown.

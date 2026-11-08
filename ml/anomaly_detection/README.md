# SWERV Anomaly Detection Prototype

This workspace contains small, explainable rules for reviewing GPS quality,
dispatch history, and delivery durations. It does not connect to MongoDB, write
alerts, start FastAPI, or change dispatch behavior. It does not train a model.

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
lists NumPy, Pandas, and scikit-learn for model training and FastAPI/Uvicorn for
the later service phase.

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

The seven labels are normal operations plus GPS jumps, invalid coordinates,
stale GPS submissions, repeated reassignments, unusual long durations, and
invalid status transitions. Feature fields include distance, time gap, implied
and reported speed, accuracy, freshness, event counts, assignment count,
delivery duration, status validity, dispatch context, and data-quality
indicators. Normal rows include borderline values and missing GPS pairs so the
labels are not based only on the presence of a single missing field.

The generated ranges are illustrative and have not been calibrated against the
small SWERV sample. Synthetic labels describe generated scenarios only; model
scores on these files cannot establish real-world SWERV anomaly accuracy.

## Model training and evaluation

Train the three comparison models after dataset generation:

```powershell
python -m src.training
```

The preprocessor is fitted only on training rows. Isolation Forest and LOF fit
only the normal training scenarios; LOF uses `novelty=True` for later
validation and test predictions. Random Forest uses the generated category
labels and balanced class weights. The validation threshold is selected to
maximize F1 while keeping the validation false-positive rate at or below 10%
where possible. The independent test is scored only after model selection.

Current synthetic comparison (seeded generated data):

| Model | Validation precision | Validation recall | Validation F1 | Validation FPR | Validation ROC-AUC | Validation PR-AUC |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Isolation Forest | 0.472 | 0.221 | 0.301 | 0.098 | 0.614 | 0.387 |
| Local Outlier Factor | 0.983 | 0.958 | 0.970 | 0.007 | 0.997 | 0.994 |
| Random Forest | 0.998 | 0.986 | 0.992 | 0.001 | 1.000 | 0.999 |

Random Forest was selected by validation F1 under the false-positive target.
Its model version is `random_forest-synthetic-42981f2b88fd`. On the separate
1,500-row synthetic test it achieved precision 1.000, recall 0.983, F1 0.991,
FPR 0.000, FNR 0.017, ROC-AUC 0.999, and PR-AUC 0.999 (405 true positives, 7
false negatives, 1,088 true negatives, and 0 false positives).

These high scores reflect the synthetic generator's labels and rules, not
validated SWERV behavior. Some labels are directly related to rule features,
and scenario ranges are illustrative. They must not be presented as real-world
accuracy. Isolation Forest and LOF produce unsupervised scores; thresholded
precision/recall compare those scores with synthetic labels, while Random
Forest learns the supplied synthetic labels directly.

Artifacts and reports are saved under:

- `models/synthetic/anomaly_detector.joblib`
- `models/synthetic/anomaly_detector.metadata.json`
- `data/processed/synthetic/model_selection_report.json`
- `data/processed/synthetic/independent_test_report.json`

Random Forest was selected using validation F1 while targeting a false-positive
rate at or below 10%. Validation metrics were precision 0.998, recall 0.986,
F1 0.992, FPR 0.001, ROC-AUC 1.000, and PR-AUC 0.999. On the separate synthetic
test it had precision 1.000, recall 0.983, F1 0.991, FPR 0.000, FNR 0.017,
ROC-AUC 0.999, and PR-AUC 0.999. These scores describe agreement with generated
labels only and are not SWERV operational accuracy.

## FastAPI service

Start the separate service on port 8005 from this directory:

```powershell
python -m uvicorn src.api:app --host 127.0.0.1 --port 8005
```

The service loads the selected artifact once at startup. `GET /health` reports
model availability and synthetic provenance. `POST /predict` requires an
explicit `detection_mode` of `real` or `synthetic_demo` and one or more
caller-supplied feature scenarios. It never creates synthetic rows when a real
mode request is made. Real input is labeled `real`, while model metadata still
states that the model was trained on synthetic scenarios.

The response keeps ML candidates in `results` and explainable rule findings in
`rule_based_findings`. Rule-based checks run only when raw dispatch,
dispatch-activity, or GPS records are explicitly supplied. Incomplete inputs
are described in `rule_based_limitations`. ML category candidates are withheld
when hard data-quality requirements fail, including GPS movement eligibility
and the minimum 30-delivery duration baseline.

Example request shape (all listed model feature fields are required; GPS
measurements that are unavailable may be `null`):

```json
{
  "detection_mode": "synthetic_demo",
  "scenarios": [{
    "duration_baseline_count": 5,
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
      "reassignment_count": 0,
      "assignment_event_count": 1,
      "activity_history_complete": 1,
      "delivery_duration_minutes": 38.0,
      "status_event_count": 4,
      "status_transition_valid": 1,
      "agent_status_change_count": 1,
      "agent_active_workload": 2,
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

The Node backend calls FastAPI; the browser does not contact port 8005. Set
`ANOMALY_DETECTION_SERVICE_URL` in `backend/.env`; `.env.example` uses
`http://127.0.0.1:8005`. Detection uses field-limited, read-only queries and
never changes dispatches or agents.

Real alerts use the `anomaly_alerts` collection. Demo alerts use the separate
`anomaly_demo_alerts` collection, with independent summaries and history. A
unique key prevents concurrent duplicate inserts for the same anomaly, entity,
and evidence hour. Admins can mark alerts under review, resolved, or dismissed
and save notes; review actions do not trigger operational changes.

The Admin page is `/admin/anomaly-detection`. Real Data Mode uses only MongoDB
records and reports skipped checks when input quality is insufficient. Synthetic
Demo Mode reads only `synthetic_demo.csv`, labels the results clearly, and does
not create dispatch or agent records. The model was trained on synthetic data;
real-world SWERV accuracy is unknown. The inspected 5 completed deliveries and
12 GPS points are too little for a delivery-duration baseline or reliable route
movement analysis.

## Remaining work

Collect a longer, privacy-conscious real history; validate timestamps and event
completeness; review rule findings with Admins; then evaluate rules against
those review labels. Isolation Forest or Local Outlier Factor should be
considered only after there are enough representative records. A planned route
source and documented SLA are prerequisites for route-deviation and SLA-delay
detection. Complete automated checks and manual Admin UI verification before
operationally relying on any alert; real-world model accuracy remains unknown.

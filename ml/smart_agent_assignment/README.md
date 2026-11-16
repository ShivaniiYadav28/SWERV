# SWERV Smart Agent Assignment ML prototype

This workspace trains a separate regression model that estimates delivery
duration for each eligible dispatch-agent candidate and ranks candidates by
predicted minutes. The current model uses generated synthetic examples. Its
metrics do not establish accuracy on real SWERV deliveries.

The Node.js backend remains responsible for hard eligibility checks and the
final assignment confirmation. The model never assigns an agent.

## Data and features

Generate candidate records with:

```powershell
cd ml/smart_agent_assignment
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m src.synthetic_dataset
```

The generator creates 10,000 rows across 1,000 dispatch scenarios. Each row
represents one candidate for one dispatch and is labeled `data_source=synthetic`.
All candidates belonging to a dispatch share the same scenario ID and time.
The CSV is saved at `data/processed/synthetic_agent_candidates.csv`; it is
separate from MongoDB and from Delivery Time Prediction data.

Training features are available when recommendations are requested:

- Package category, weight, quantity, and priority.
- Straight-line pickup-to-destination distance when coordinates are valid.
- Agent-to-pickup distance from fresh GPS, when available.
- Current active workload, maximum capacity, and workload ratio.
- Vehicle type and eligible package/priority capability profile.
- Fresh GPS indicator and historical delivery count/median when available.
- Recommendation hour and weekday derived from the recommendation timestamp.

The target is `delivery_duration_minutes`. Target values, dispatch scenario IDs,
candidate IDs, delivery completion time, final status, and future GPS/activity
data are never model inputs. Missing optional distance/history values are left
missing for the preprocessing pipeline to impute.

## Train, select, and evaluate

```powershell
python -m src.training
```

The generator seed and model-training seed are both fixed at `121`. Dispatch
scenarios are ordered chronologically and split as groups so that all candidates
for one dispatch remain together. For the generated dataset, the split is:

| Split | Dispatch scenarios | Candidate rows |
| --- | ---: | ---: |
| Training | 700 | 7,000 |
| Validation | 150 | 1,500 |
| Independent final test | 150 | 1,500 |

Linear Regression, Random Forest, and Gradient Boosting are fitted on the
training split and compared on validation. Selection prioritizes NDCG@1, then
top-candidate accuracy, NDCG@3, MAE, and RMSE. The selected model is refitted
on the combined training and validation splits. Only then is it evaluated once
on the untouched final test split. Final-test metrics do not affect model
selection.

The current validation results are:

| Model | MAE (min) | RMSE (min) | R² | Top-candidate accuracy | NDCG@1 | NDCG@3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Linear Regression | 11.44 | 15.26 | 0.861 | 0.693 | 0.820 | 0.892 |
| Random Forest | 10.91 | 15.14 | 0.863 | 0.693 | 0.825 | 0.910 |
| Gradient Boosting | 8.48 | 11.80 | 0.917 | 0.700 | 0.830 | 0.913 |

Gradient Boosting is selected by the validation ranking metrics. Its final-test
results are MAE **8.53 minutes**, RMSE **11.91 minutes**, R² **0.909**,
top-candidate accuracy **0.713**, NDCG@1 **0.841**, and NDCG@3 **0.916**.
These results evaluate generated demo data only; they do not establish
real-world performance or guarantee successful delivery.

Generated outputs:

- Summary: `data/processed/synthetic_training_report.json`
- Model comparison: `data/processed/validation_evaluation_report.json`
- Selected model final test: `data/processed/final_test_evaluation_report.json`
- Model artifacts and their SHA-256 provenance metadata:
  `models/synthetic/*.joblib` and `*.metadata.json`

Metadata records the feature schema, dataset and training seeds, grouped split
configuration, split sizes, validation results, model version, and artifact
SHA-256. Every artifact is marked `training_source=synthetic`. Keep model
artifacts under this feature's workspace; do not use other model projects'
artifacts.

## Run the standalone API locally

From this workspace, configure a local API key in the shell and start the
service. Do not put a real key in source control:

```powershell
$env:SMART_AGENT_ASSIGNMENT_API_KEY = "<set-a-long-random-local-secret>"
python -m uvicorn src.api:app --host 127.0.0.1 --port 8002
```

The service loads `models/synthetic/gradient_boosting.joblib` by default.
`SMART_AGENT_MODEL_PATH` is an optional artifact-path override; the artifact
must have its matching metadata file and approved feature schema.

- `GET http://127.0.0.1:8002/health` is public for health checks. It reports
  model availability and, when loaded, the model version and synthetic-data
  provenance.
- `POST http://127.0.0.1:8002/predict` requires
  `Authorization: Bearer <SMART_AGENT_ASSIGNMENT_API_KEY>`. It accepts a
  dispatch and already-eligible candidate list, validates candidate capacity,
  active status, capabilities, GPS freshness, and optional delivery history,
  and returns candidates ranked by predicted duration. It does not assign an
  agent.
- Open `http://127.0.0.1:8002/docs` for the request and response schemas.

If authentication is not configured, `/predict` fails closed with HTTP 503.
Missing, malformed, or invalid Bearer credentials receive HTTP 401. Invalid
request data receives HTTP 422; an unavailable or invalid model receives HTTP
503. No credentials are included in responses.

Required service environment variable:

| Variable | Required | Purpose |
| --- | --- | --- |
| `SMART_AGENT_ASSIGNMENT_API_KEY` | Yes | Secret Bearer token protecting `/predict`. Keep it out of source control and logs. |
| `SMART_AGENT_MODEL_PATH` | No | Optional path to a compatible model artifact; defaults to the bundled Gradient Boosting model. |

The backend's `SMART_AGENT_ML_SERVICE_BASE_URL` points to this service when
backend integration is configured. The existing `ML_SERVICE_BASE_URL` on port
8001 belongs to Delivery Time Prediction and is not changed by this feature.

## Render deployment configuration

The service-specific [render.yaml](./render.yaml) defines an independent
Render web service. Its exact settings are:

| Setting | Value |
| --- | --- |
| Root directory | `ml/smart_agent_assignment` |
| Build command | `python -m pip install -r requirements.txt` |
| Start command | `uvicorn src.api:app --host 0.0.0.0 --port $PORT` |
| Health-check path | `/health` |
| Python version | `3.13.5` |
| Required environment variable | `SMART_AGENT_ASSIGNMENT_API_KEY`, generated by Render |

The Blueprint uses Render's `generateValue: true` for
`SMART_AGENT_ASSIGNMENT_API_KEY`; Render generates a strong secret for this
service. If configuring the service manually instead, add this variable in the
Render dashboard and use its secret-generation control. Keep the key unique to
Smart Agent Assignment; do not reuse another model service's key or commit its
value.

Before creating or deploying the service:

1. Select the repository Blueprint at `ml/smart_agent_assignment/render.yaml`.
2. Confirm the service root directory and commands match the table above.
3. Confirm Render generates `SMART_AGENT_ASSIGNMENT_API_KEY`; do not enter a
   secret in the YAML file.
4. After you explicitly choose to deploy, open the service URL and verify
   `/health` reports `model_available: true` and
   `model_version: gradient_boosting-synthetic-c092cee9f5a4`.
5. To verify `/predict`, set the generated key in a local process environment
   variable without echoing or committing it, then use the following request
   with a valid demo payload. Replace only the service URL:

```powershell
$serviceUrl = "https://<your-render-service>.onrender.com"
Invoke-RestMethod "$serviceUrl/health"

$headers = @{
    Authorization = "Bearer $env:SMART_AGENT_ASSIGNMENT_API_KEY"
}
$body = @'
{
  "dispatch_request_id": "render-smoke-test",
  "dispatch": {
    "recommendation_time": "2026-11-16T12:00:00Z",
    "priority": "standard",
    "package_category": "parcel",
    "weight_kg": 1,
    "quantity": 1
  },
  "candidates": [{
    "agent_id": "demo-agent-1",
    "agent_code": "DEMO-001",
    "is_active": true,
    "agent_status": "available",
    "vehicle_type": "van",
    "capabilities": ["parcel_delivery"],
    "active_workload": 0,
    "max_capacity": 3,
    "gps_fresh": false,
    "completed_delivery_count": 0
  }]
}
'@
Invoke-RestMethod "$serviceUrl/predict" -Method Post -Headers $headers `
    -ContentType "application/json" -Body $body
```

The checked-in Gradient Boosting artifact and metadata are inside the service
root, and the loader resolves the default artifact relative to its source file.
The backend must be configured separately to send this service's Bearer token
when calling `/predict`. This preparation does not create or deploy the Render
service.

Run Python tests:

```powershell
python -m unittest discover -s tests -v
```

## Additional independent generated-data evaluation

The selected model can also be checked on a separate set of 2,000 new dispatch
scenarios (10 candidates per dispatch). This uses a new random seed and
scenario IDs, does not read the training, validation, or final-test CSVs, and
does not fit or save a model. It uses the same `delivery_duration`
target-generation method as the training data. These results are still
generated-data evaluation, not real-world validation.

With the Feature 2 API running on `127.0.0.1:8002`, run from the project root:

```powershell
$env:SMART_AGENT_ASSIGNMENT_API_KEY = "<the-same-local-secret-used-by-the-api>"
python -m ml.smart_agent_assignment.src.independent_evaluation
```

The dataset and reports are saved under
`data/processed/independent_testing/`. They include regression metrics,
per-dispatch top-candidate and NDCG ranking metrics, API edge checks, and a
before/after SHA-256 check of the selected model. This additional evaluation
is separate from validation-based model selection and the final-test report.

## Limitations

The dataset is synthetic and its target is generated from the same broad
relationships represented by its inputs, with random noise. This is useful for
testing data flow, leakage safeguards, API behavior, and ranking UI, but it is
not evidence that recommendations improve real delivery performance. The
model uses straight-line distances rather than road routing or live traffic.
Validate against sufficiently many real, correctly timestamped deliveries
before relying on predictions operationally.

# SWERV Delivery Time Prediction Dataset

This standalone Python workspace extracts real completed SWERV dispatch
requests from MongoDB and also supports a separate, clearly labeled synthetic
prototype for experimentation. Synthetic records never enter MongoDB or the
real delivery dataset, and synthetic evaluation does not establish real-world
accuracy.

## Requirements

- Python 3.10 or newer
- A MongoDB URI with read access to `dispatchrequests` and
  `dispatchrequestactivities`

The pipeline only uses MongoDB `find` queries. For least-privilege access, use a
MongoDB account with read-only permissions for the SWERV database.

## Setup

From the repository root, create a virtual environment and install the Python
dependencies:

```powershell
cd ml/delivery_time_prediction
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

The script reads `MONGO_URI` from the process environment. It also loads the
existing `backend/.env` when present, without overriding an environment value.
If you need a separate ML environment file, copy `.env.example` to `.env` in
this workspace and set `MONGO_URI` there. Do not commit `.env` or share the URI.
If the URI does not specify a database, this pipeline follows the backend's
Mongoose default database (`test`). Set `MONGO_DATABASE` to override that name.

For a local read-only database user, grant read access to the SWERV database;
the pipeline itself never inserts, updates, deletes, or runs write commands.

## Run

From `ml/delivery_time_prediction`, print current MongoDB-backed collection
progress without writing the CSV or report:

```powershell
python src/dataset.py --check
```

Refresh the dataset and quality report from real completed delivery records:

```powershell
python src/dataset.py
```

Both commands use read-only MongoDB queries. The refresh command rewrites only
the local processed CSV and report; it does not insert, update, or delete
MongoDB records. The report includes total delivered requests, valid and
excluded records with reasons, missing values, records with complete
assignment-time features, additional valid deliveries needed to reach 200, and
the chronological test-set size when the training threshold has been met.

Outputs are written to `data/processed/`:

- `delivery_time_dataset.csv`
- `data_quality_report.json`

The CSV contains one row per usable completed delivery. Its target is
`delivery_duration_minutes`, calculated as delivery time minus the final
assignment time before pickup. `request_created_at`, `assigned_at`, request
priority, package fields, valid coordinates, and straight-line distance are
prediction-time inputs. `picked_up_at`, `delivered_at`, final status, and later
GPS observations are not exported. The target is a label, not a model input.

Each request is matched to its activity records. With repeated assignments,
the pipeline uses the latest assignment event before pickup and verifies it
matches the agent currently assigned to the completed request. New assignment
events store a snapshot of pickup and destination coordinates as they were at
that assignment. For older assignment events without a snapshot, the extractor
uses the request's current coordinates only when the activity history has no
later location change. If a location-change timestamp is missing or a change
occurred at or after assignment, both coordinates are omitted for that legacy
row. Agent GPS history is never used as a substitute.

The extractor validates assignment, assigned, pickup, in-transit and delivery
events; duplicate lifecycle events; event ordering; reassignment history; the
final assigned agent; positive target duration; and coordinate ranges. Missing
coordinates are allowed, while partial or invalid coordinate pairs make a row
invalid. Invalid rows are excluded and counted by reason in the quality report.

Agent vehicle type is currently left out: SWERV activity events do not capture
the vehicle value at assignment time, and the agent's current vehicle value
cannot establish what it was historically. The MongoDB projection also omits
customer names, email, phone, address, instructions, agent data, and credential
or tracking collections.

## Train and evaluate models

After generating the dataset, run the training and evaluation pipeline from
this workspace:

```powershell
python src/training.py
```

The module uses an explicit allowlist of features available at assignment time.
It derives request-to-assignment minutes and hour/day features from the two
available timestamps, imputes missing numeric values with the median, imputes
missing categories with the most common value, and one-hot encodes categories.
The target column is read separately and is never selected as an input. Pickup
time, delivery time, final status, and later GPS observations are not used.

The Linear Regression baseline is compared with Random Forest and Gradient
Boosting regressors. When eligible, the pipeline sorts by assignment time and
holds out the newest 20% (at least 40 records) for testing. It reports MAE,
RMSE, and R². It requires at least 200 valid labeled deliveries before fitting
or saving model artifacts. This is a conservative minimum for a training set
plus a useful chronological holdout, not proof that any model is reliable;
metrics remain exploratory until validated on more future deliveries.

With the current five rows, it refuses to fit models or report performance,
explaining that the training and test samples would be too small. It writes
that decision to `data/processed/training_evaluation_report.json` and saves no
model files. Once the threshold is met, trained pipelines are saved under
`models/` as joblib files.

## Independent synthetic evaluation

To check an already saved synthetic Gradient Boosting artifact against a new
set of generated scenarios, run:

```powershell
python -m src.independent_evaluation
```

This command generates a separate 2,000-row dataset with its own seed and
target-generation formula. It uses the existing approved prediction-time
feature allowlist, loads `models/synthetic/gradient_boosting.joblib` without
training or saving a model, checks the live API on port 8001, and writes its
files under `data/processed/independent_testing/`. The report records the
artifact hash before and after evaluation. These results remain synthetic-only
and are not real-world validation.

Run the safety and preprocessing tests with Python's built-in test runner:

```powershell
python -m unittest discover -s tests -v
```

## Synthetic prototype

When there are not enough real deliveries, generate a separate set of 10,000
Bengaluru-style examples and compare the same three models. This path does not
connect to MongoDB and does not read or overwrite the real CSV or reports:

```powershell
python -m src.synthetic_dataset
python -m src.train_synthetic
```

The generator uses a fixed random seed. Every row has `data_source=synthetic`
and a synthetic record ID. Its target includes distance, assignment-time
traffic period, priority, category, weight, quantity, and random variation.
Delivery timestamps and post-assignment values are not exported as model
features; the existing assignment-time allowlist is reused.

Outputs are kept separate:

- Dataset: `data/processed/synthetic_delivery_time_dataset.csv`
- Metrics and provenance: `data/processed/synthetic_training_evaluation_report.json`
- Three trained pipelines and metadata: `models/synthetic/`

Training uses the newest 20% chronologically as test data. For 10,000 rows,
that is 8,000 training rows and 2,000 test rows. It compares Linear Regression,
Random Forest, and Gradient Boosting using MAE, RMSE, and R², then identifies
the lowest-MAE model. Scores describe performance on generated data only and
do not establish accuracy on real deliveries.

### Run FastAPI with the selected synthetic model

The API now defaults to the model selected in the synthetic evaluation report:
`models/synthetic/gradient_boosting.joblib`. You can still choose another
artifact explicitly. Relative `DELIVERY_MODEL_PATH` values are resolved from
this prediction workspace, so the result does not depend on the shell's current
directory.

```powershell
$report = Get-Content data/processed/synthetic_training_evaluation_report.json -Raw | ConvertFrom-Json
$env:DELIVERY_MODEL_PATH = $report.best_model_artifact
python -m uvicorn src.api:app --host 127.0.0.1 --port 8001
```

`GET http://127.0.0.1:8001/health` shows availability and a model version that
contains `synthetic`. `POST /predict` keeps the existing response schema, and
its model version identifies the synthetic artifact. Missing or invalid models
still return the existing unavailable response.

Run all tests, including synthetic data, leakage, chronological split, model
loading, and API checks:

```powershell
python -m unittest discover -s tests -v
```

## Run the local prediction service

Start the API from this workspace:

```powershell
python -m uvicorn src.api:app --host 127.0.0.1 --port 8001
```

Open `http://127.0.0.1:8001/docs` for the local API description. `GET /health`
reports whether the service is running and whether a model is available. `POST /predict`
accepts only request creation and assignment timestamps, priority,
package category, weight, quantity, and optional pickup/destination coordinate
pairs. It rejects extra fields such as delivery time or final status. Straight-
line distance is derived from valid coordinate pairs using the same calculation
as the dataset pipeline.

The service defaults to the selected synthetic Gradient Boosting model, or the
path set by `DELIVERY_MODEL_PATH`. It verifies that the artifact is a fitted
scikit-learn pipeline with the expected input columns and checks the synthetic
metadata when it is present. The synthetic model is for local prototype testing;
its evaluation does not establish accuracy on real SWERV deliveries. If the
artifact is missing or invalid, `POST /predict` returns HTTP 503 with
`prediction_status: "unavailable"` and a null prediction. It never returns a
placeholder duration. If a model is generated after the API starts, the
service checks again on the next request. Model artifacts use Python
pickle-based joblib format, so only load files generated and controlled by
this project.

The service binds to localhost for development. The existing Node.js backend
can call it through `ML_SERVICE_BASE_URL` and uses the existing `/predict`
response fields. Do not expose it publicly before adding the deployment and
access controls required by the target environment.

## Version 2 generalization workflow

The version 2 workflow uses one shared target generator for training,
validation, and a new final independent test. It leaves the original datasets,
reports, and model artifacts in place.

Generate new training and validation datasets:

```powershell
python -m src.v2_dataset
```

This writes 10,000 training rows and 2,000 validation rows under
`data/processed/v2/`, with independent seeds and no overlapping scenarios.
The shared target code is `src/v2_target.py`. It converts aware timestamps to
`Asia/Kolkata` before identifying weekday rush hours. Its simulated target is:

```text
road_distance = straight_line_distance * triangular(1.12, 1.31, 1.52)
travel_minutes = road_distance / uniform_speed(21, 32 km/h) * 60 * congestion
duration = max(5, travel_minutes * priority_factor * package_factor
              + 6 + 0.72 * sqrt(weight_kg) + 1.1 * (quantity - 1)
              + Gamma(shape=1.7, scale=1.7)
              + Normal(0, max(2.5, 9% of travel_minutes)))
```

Congestion is sampled from 1.12–1.42 on weekday rush hours, 0.96–1.20 on
weekday non-rush hours, and 0.90–1.16 on weekends. Priority and package
factors are defined in `v2_target.py`. The target uses the generated true
trip distance even when a coordinate pair is hidden from model inputs; this
represents a real delivery whose label exists while its map coordinates are
missing. It also means missing-coordinate predictions have less information.
Quantities range from 1 to 5, timestamps cover all local hours, distances
span a wider city radius, and coordinate pairs are sometimes unavailable.

Tune and compare models using training data for fitting and validation data
for model selection:

```powershell
python -m src.v2_training
```

The report and new artifact are saved under `data/processed/v2/` and
`models/v2/`. The final model is refit on training plus validation after the
validation selection is complete. It uses local-hour features and coordinate
availability indicators derived from inputs already present in `/predict`.
The request and response schemas are unchanged. The model loader selects the
matching v1 or v2 feature builder from artifact metadata.

For the final independent evaluation only, start FastAPI with the selected v2
artifact on a separate local port:

```powershell
$report = Get-Content data/processed/v2/training_report.json -Raw | ConvertFrom-Json
$env:DELIVERY_MODEL_PATH = $report.model_artifact
python -m uvicorn src.api:app --host 127.0.0.1 --port 8003
```

Then, in another terminal, generate and evaluate the new 2,000-row independent
test:

```powershell
python -m src.v2_independent_evaluation
```

The independent dataset is created after validation-based selection and kept
separate at `data/processed/v2/independent_test_dataset.csv`. Its evaluation
report is `data/processed/v2/independent_evaluation_report.json`. It is not
used to tune or train the model. The API can be tested by the existing Node.js
integration by setting `ML_SERVICE_BASE_URL=http://127.0.0.1:8003` for the
backend process. All results remain synthetic and do not establish
real-world accuracy.

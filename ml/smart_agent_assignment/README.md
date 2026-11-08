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

## Train and evaluate

```powershell
python -m src.training
```

The newest 20% of dispatch scenarios are held out for testing. Candidates from
one dispatch are never split between training and test sets. For the generated
dataset, the split is 800 scenarios (8,000 candidate rows) for training and 200
scenarios (2,000 rows) for testing.

Linear Regression, Random Forest, and Gradient Boosting are compared using
MAE, RMSE, and R². The report also includes top-candidate accuracy: how often
the model's lowest-duration candidate matches the lowest synthetic target in
that dispatch group. Models are selected by holdout MAE, with ranking accuracy
as the tie-breaker.

Generated outputs:

- Evaluation and provenance: `data/processed/synthetic_training_report.json`
- Model artifacts and their SHA-256 provenance metadata:
  `models/synthetic/*.joblib` and `*.metadata.json`

Every artifact is marked `training_source=synthetic`. Keep model artifacts
under this feature's workspace; do not use Feature 1's model files.

## Start and test the prediction API

From this workspace, point the API at the selected artifact and start it on
port 8002:

```powershell
$report = Get-Content data/processed/synthetic_training_report.json -Raw | ConvertFrom-Json
$env:SMART_AGENT_MODEL_PATH = $report.best_model_artifact
python -m uvicorn src.api:app --host 127.0.0.1 --port 8002
```

Check `GET http://127.0.0.1:8002/health`. It reports the model version and
`training_source: synthetic`. `POST /predict` accepts dispatch-time features
and one or more already eligible candidates. It validates capacity,
capabilities, GPS freshness, and optional historical values, then returns each
candidate's predicted minutes and rank. If the model is missing or invalid,
`/predict` returns HTTP 503 instead of a made-up duration. Open
`http://127.0.0.1:8002/docs` to inspect the schemas and try either endpoint.

The backend uses `SMART_AGENT_ML_SERVICE_BASE_URL`, defaulting to
`http://127.0.0.1:8002`. Add that variable to `backend/.env` for local use. The
existing `ML_SERVICE_BASE_URL` on port 8001 belongs to Delivery Time Prediction
and is not changed by this feature.

Run Python tests:

```powershell
python -m unittest discover -s tests -v
```

## Independent synthetic evaluation

The saved Gradient Boosting model can be checked on a separate set of 2,000
new dispatch scenarios (10 candidates per dispatch). This uses a new random
seed and scenario IDs, does not read the training or holdout CSVs, and does not
fit or save a model. It uses the same `delivery_duration` target-generation
method as the synthetic training data. These results are still synthetic-data
evaluation, not real-world validation.

With the Feature 2 API running on `127.0.0.1:8002`, run from the project root:

```powershell
python -m ml.smart_agent_assignment.src.independent_evaluation
```

The dataset and reports are saved under
`data/processed/independent_testing/`. They include regression metrics,
per-dispatch top-candidate and NDCG ranking metrics, API edge checks, and a
before/after SHA-256 check of the saved model. The independent test data must
remain outside training and model selection.

## Limitations

The dataset is synthetic and its target is generated from the same broad
relationships represented by its inputs, with random noise. This is useful for
testing data flow, leakage safeguards, API behavior, and ranking UI, but it is
not evidence that recommendations improve real delivery performance. The
model uses straight-line distances rather than road routing or live traffic.
Validate against sufficiently many real, correctly timestamped deliveries
before relying on predictions operationally.

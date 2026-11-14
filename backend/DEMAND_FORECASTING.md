# Synthetic Demand Forecasting Demo

The Admin dashboard at `/admin/demand-forecasting` is a synthetic-data demo
only. Its authenticated Node API reads the bundled
`ml/demand_forecasting` ML service. The ML service owns and caches the bundled
CSV, validates its synthetic-only rows, and supplies its last 168 counts to the
saved model. The backend sends only the forecast start and horizon; it never
reads the CSV or queries dispatch and delivery records. The browser cannot
select a real-history mode or submit history counts. Forecasts are never
written to business records.

`POST /api/demand-forecasting/forecast` requires an Admin session. The dashboard
offers 24-hour, 72-hour, and 168-hour forecasts and clearly labels its output
as synthetic. This model has not been validated on actual SWERV operations and
must not guide operational decisions or be treated as confirmed demand.

## Service authentication and configuration

The backend calls FastAPI directly; the browser never receives the shared
secret. Configure these variables:

- Backend: `DEMAND_FORECASTING_SERVICE_URL` is the ML service base URL and
  `DEMAND_FORECASTING_API_KEY` is a randomly generated secret with at least 32
  characters.
- ML service: set `DEMAND_FORECASTING_API_KEY` to the exact same secret.

Keep the key only in the backend and ML service environment settings, never in
frontend variables or API responses. ML `GET /health` remains public for
hosting health checks and reports whether the model and synthetic history are
available. ML `POST /predict` requires `Authorization: Bearer <secret>`.
Missing or incorrect service configuration fails closed.

The backend makes at most two ML requests with a 70-second overall deadline,
up to 50 seconds per attempt, and a one-second retry delay. It retries only
connection/timeouts and upstream HTTP 502, 503, or 504. Authentication,
validation, and malformed successful responses are not retried.

## Recursive evaluation

Run `python -m src.recursive_evaluation` from `ml/demand_forecasting` to
evaluate the verified saved artifact without fitting or replacing it. The
workflow uses the chronological final test period, daily rolling origins, and
recursively feeds model predictions back as later-hour inputs. Its seasonal
naive baseline uses the matching hour from the previous week, known at each
forecast origin. Results are saved separately in
`data/processed/recursive_forecast_evaluation.json`; they are synthetic-only
and do not establish real-world accuracy.

The existing one-step report and recursive evaluation measure different tasks
and should not be compared as if they were the same forecast horizon.

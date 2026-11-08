# SWERV Backend

## Delivery-time prediction

The backend can request a prediction from the local FastAPI service. Configure
`ML_SERVICE_BASE_URL` in `backend/.env`; it defaults to
`http://127.0.0.1:8001`. Start the Python service separately from
`ml/delivery_time_prediction` with:

```powershell
python -m uvicorn src.api:app --host 127.0.0.1 --port 8001
```

Request a prediction for a dispatch request that is assigned and not yet picked
up:

```http
POST /api/dispatch-requests/{id}/prediction
```

The route uses the existing cookie authentication and Admin/Operator role
checks. It builds the Python request from creation and assignment timestamps,
priority, package category, weight, quantity, and available coordinates. If
coordinates changed after assignment, both coordinate pairs are omitted so the
service receives no post-assignment values. Customer details, addresses,
instructions, agent credentials, and tracking data are not sent.

A successful response follows the backend response format and includes
`predictedDurationMinutes`, `modelVersion`, and `predictionStatus`. If the model
is unavailable, the Python service is offline, a timeout occurs, required
request data is invalid, or the Python response is malformed, the backend
returns an error and never substitutes a duration. Predictions are not saved
to MongoDB, and this endpoint does not affect dispatch creation, assignment,
or status updates.

The Python workspace currently has no trained model artifact, so its prediction
endpoint reports that predictions are unavailable until the training pipeline
produces a valid model.

## Agent assignment recommendations

Admin and Operator users can request a read-only list of eligible agents for a
pending or assigned dispatch request:

```http
GET /api/dispatch-requests/{id}/agent-recommendations
```

The route uses the existing authenticated session cookie. A successful response
contains `data.recommendations`, sorted by rank. Each recommendation includes
the agent's ID, name, code and vehicle type, an overall score, current workload,
optional distance, optional historical delivery statistics, and short reasons
for its score. For example:

```json
{
  "success": true,
  "message": "Eligible agents ranked using current workload and available distance and delivery history.",
  "data": {
    "dispatchRequestId": "...",
    "recommendations": [
      {
        "rank": 1,
        "agent": { "id": "...", "name": "Taylor Driver", "agentCode": "AGT-12345678", "vehicleType": "van" },
        "score": 58.6,
        "workload": { "activeDispatchCount": 1, "maxOrders": 4 },
        "distanceKm": 2.3,
        "historicalCompletedDeliveries": 0,
        "historicalMedianDurationMinutes": null,
        "explanation": ["Package and priority capabilities match (parcel_delivery)."]
      }
    ],
    "rankingData": { "pickupCoordinatesAvailable": true, "agentsWithFreshGps": 1, "historicalPerformanceAvailable": false, "minimumHistoricalDeliveries": 10 },
    "notes": ["Vehicle type is not currently a restriction in SWERV assignment rules."]
  }
}
```

The transparent heuristic gives up to 40 points for available capacity, up to
30 for fresh GPS distance from pickup (scaled to zero at 50 km), and up to 30
for relative historical delivery time. GPS is considered fresh for 15 minutes.
Historical performance is included only after an agent has at least 10 valid
assignment-to-delivery records. Missing GPS or insufficient history contributes
zero points. If history is available for only one agent, or all qualifying
agents have the same median duration, the performance factor is neutral at 15
points. Ties are ordered by lower workload, shorter known distance, then agent
code.

Eligibility follows the existing assignment service: active agents with
`available` status, remaining order capacity, and the required package and
priority capabilities. The assignment code has no vehicle-type restriction, so
recommendations do not invent one. Distance is a straight-line estimate, not a
road route or ETA. Historical records are excluded when their latest assignment
event does not match the agent currently recorded on the delivered request.

The endpoint never assigns an agent or changes dispatch, agent, or GPS records.
It returns an empty list when no eligible agents are available, and a `409`
response when the request is not pending or assigned. It does not modify the
delivery-time prediction pipeline.
# Anomaly Detection APIs

The Admin-only anomaly APIs use the existing session cookie and the existing
`requireAuth` and `allowRoles('admin')` middleware. The browser talks to this
backend; it does not call the Python service.

Set `ANOMALY_DETECTION_SERVICE_URL` in `backend/.env` to the FastAPI service
base URL. The default is `http://127.0.0.1:8005`; see `.env.example` for the
placeholder configuration.

Routes under `/api/anomaly-detection`:

- `POST /detect` with `{ "mode": "real" }` or
  `{ "mode": "synthetic_demo" }`.
- `GET /summary?mode=real|synthetic_demo`.
- `GET /alerts` with optional `mode`, `severity`, `anomalyType`,
  `reviewStatus`, `page`, and `limit` query parameters.
- `GET /alerts/:id?mode=...`.
- `PATCH /alerts/:id/review?mode=...` with `{ "reviewStatus": "under_review",
  "reviewNotes": "..." }`. Allowed changes are `under_review`, `resolved`,
  or `dismissed`.

Real and demo alerts use the separate `anomaly_alerts` and
`anomaly_demo_alerts` MongoDB collections. Detection only reads dispatch,
activity, agent, and GPS data; review actions update only the selected alert.
Demo scenarios are read from the isolated synthetic demo CSV. The anomaly model
was trained on synthetic data, so its score is not validated against actual
SWERV operations.

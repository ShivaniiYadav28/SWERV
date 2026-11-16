# SWERV Route Optimization Service

This standalone service accepts an agent location and active delivery stops, requests road-network estimates from OSRM, and returns the existing SWERV nearest-next-stop ordering alongside the request-order baseline. It is a deterministic routing heuristic, not a trained model, and does not provide live-traffic estimates.

## Project structure

- `src/services/routeOptimizer.ts` contains the pickup-aware stop-ordering logic.
- `src/services/routeOptimizationService.ts` calls OSRM and formats route previews.
- `src/routes/` and `src/controllers/` expose the HTTP API.
- `src/utils/` contains request validation and safe HTTP errors.
- `tests/` contains deterministic tests with mocked OSRM responses.

The service has no runtime dependency on the SWERV backend, database, or frontend.

## Local setup

Requires Node.js 20 or newer.

```powershell
cd C:\project-dev\swerv\ml\route_optimization
npm install
$env:PORT = "3000"
$env:ROUTING_SERVICE_BASE_URL = "https://router.project-osrm.org"
$env:ROUTE_OPTIMIZATION_API_KEY = "replace-with-a-long-random-key"
npm run build
npm start
```

`ROUTING_SERVICE_BASE_URL` defaults to `https://router.project-osrm.org`. Configure a routing service you control for production use; the public OSRM demo may be rate-limited or unavailable.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | HTTP port; defaults to `3000`. |
| `ROUTING_SERVICE_BASE_URL` | No | OSRM-compatible base URL; defaults to `https://router.project-osrm.org`. |
| `ROUTE_OPTIMIZATION_API_KEY` | For optimization | Server-side Bearer token expected by `POST /optimize`. If missing, optimization requests fail with HTTP 503; `/health` remains public. |

Never commit a real API key. The service does not log credentials.

## Endpoints

### `GET /health`

Public liveness response:

```json
{ "status": "ok" }
```

### `POST /optimize`

Requires `Authorization: Bearer <ROUTE_OPTIMIZATION_API_KEY>`.

Request:

```json
{
  "agent": {
    "agentId": "agent-001",
    "latitude": 12.9716,
    "longitude": 77.5946
  },
  "deliveries": [
    {
      "dispatchRequestId": "dispatch-001",
      "status": "assigned",
      "pickup": { "latitude": 12.955, "longitude": 77.58 },
      "delivery": { "latitude": 12.965, "longitude": 77.59 }
    },
    {
      "dispatchRequestId": "dispatch-002",
      "status": "in_transit",
      "delivery": { "latitude": 12.9816, "longitude": 77.6046 }
    }
  ]
}
```

`status` must be `assigned`, `picked_up`, or `in_transit`. Assigned deliveries require pickup coordinates; the other statuses contribute a delivery stop only. Send between 1 and 12 uniquely identified deliveries. Coordinates are validated as latitude/longitude ranges.

Successful responses use `{ "success": true, "data": { "preview": ... } }`. The preview contains the agent origin, an input-order baseline and an optimized route. Each route includes ordered stops with dispatch IDs and stop types, `distanceMeters`, `durationSeconds`, and route geometry as `[latitude, longitude]` pairs. `improvement` reports the percentage change in distance and duration; it is `null` when the baseline metric is zero.

Invalid requests return HTTP 400, invalid or missing credentials return HTTP 401, missing server-side key configuration returns HTTP 503, and OSRM/configuration failures return HTTP 503.

## Render preparation

Create a separate Render Web Service using `ml/route_optimization` as its root directory. Use:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment: Node
- Set `ROUTE_OPTIMIZATION_API_KEY` to a secure secret.
- Optionally set `ROUTING_SERVICE_BASE_URL` to your OSRM-compatible deployment; Render supplies `PORT`.

No Render service or deployment is created by this project.

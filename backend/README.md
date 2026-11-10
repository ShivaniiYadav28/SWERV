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

The Python workspace includes a synthetic-trained Gradient Boosting model at
the delivery-time service's default model path. The endpoint can return
predictions when that artifact and its metadata validate. Because this model
was trained on synthetic data, its predictions are a prototype and have not
been validated against real SWERV operations.

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

# Proof of Delivery (POD)

Agents can complete an in-transit delivery only after uploading a delivery
photo, verifying the customer code, saving a customer signature, and recording
device GPS or explicitly marking GPS unavailable. The API checks the assigned
agent and each requirement. POD creation, the Delivered status change, the
agent workload update, and the delivery activity event run in one MongoDB
transaction. A completed POD has no edit or delete endpoint.

Routes use the existing HttpOnly agent or Admin session cookie:

- `GET /api/agent/deliveries/:id/pod` returns the agent's POD checklist.
- `POST /api/agent/deliveries/:id/pod/photo` uploads JPEG, PNG, or WebP (up to
  5 MB) as the raw request body. Send its MIME type as `Content-Type` and its
  filename in `X-File-Name`.
- `POST /api/agent/deliveries/:id/pod/signature` uploads a PNG signature (up to
  1 MB) in the same raw-body format.
- `POST /api/agent/deliveries/:id/pod/otp` requests customer verification.
- `POST /api/agent/deliveries/:id/pod/otp/verify` accepts
  `{ "otp": "123456" }`.
- `POST /api/agent/deliveries/:id/pod/submit` submits either GPS fields
  (`latitude`, `longitude`, optional `accuracyMeters`) or
  `locationUnavailableReason` (`permission_denied`, `unsupported`, `timeout`,
  or `not_available`). The server supplies the authoritative delivery time.
- `GET /api/agent/deliveries/:id/pod/evidence/:kind` lets the assigned agent
  view their evidence (`photo` or `signature`).
- Admin only: `GET /api/admin/pod`, `GET /api/admin/pod/:dispatchId`, and
  `GET /api/admin/pod/:dispatchId/evidence/:kind` provide read-only review.

Photos and signatures are stored outside MongoDB. Local development defaults
to `POD_STORAGE_PROVIDER=local` and writes under `POD_STORAGE_DIR`
(`./private_uploads/pod` relative to the backend working directory). Keep this
directory private, backed up, and excluded from Git.

Production requires S3-compatible object storage. Set these Render environment
variables before deploying:

- `POD_STORAGE_PROVIDER=s3`
- `POD_S3_BUCKET` to a private bucket name
- `POD_S3_REGION` to the bucket region (`auto` for Cloudflare R2)
- For Cloudflare R2, `POD_S3_ENDPOINT` as
  `https://<account-id>.r2.cloudflarestorage.com`
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for Cloudflare R2. Both
  credentials are required; ambient AWS credentials are not used for R2.
- For other S3-compatible providers, use `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`, or configure a workload IAM role where supported
- Optional `AWS_SESSION_TOKEN` when using temporary AWS credentials
- Optional `POD_S3_ENDPOINT` for a compatible storage provider; it must use
  HTTPS in production
- Optional `POD_S3_FORCE_PATH_STYLE=true` when required by that provider

The backend requires Node.js 20 or newer. The `engines.node` setting in
`backend/package.json` provides Render's runtime version selection.

Grant the backend identity only `s3:PutObject`, `s3:GetObject`, and
`s3:DeleteObject` for objects under the bucket's `pod/` prefix. Do not make the
bucket public.

The backend refuses to start in production if S3 storage is not configured;
it never silently writes new production proof images to Render's ephemeral
filesystem. Keep the bucket private, enable provider-side encryption, and
apply appropriate backup and retention controls. Image reads remain protected
by the authenticated agent or Admin routes, and the bucket is never made
public. Existing records without a `storageProvider` continue to resolve from
the legacy local directory; files already removed from an ephemeral disk cannot
be recovered by the application.

This repository does not currently configure an email or SMS provider. In
production, OTP requests return HTTP 503 until a provider is connected; the
service does not claim that a code was delivered. For local development only,
set `POD_DEV_OTP_ENABLED=true` with `NODE_ENV=development`. The OTP endpoint
then returns a clearly labelled test code that is not sent to the customer.
The backend stores only a salted scrypt hash, expires codes after five minutes,
limits verification attempts, and applies resend and endpoint rate limits. Keep
`POD_DEV_OTP_ENABLED=false` outside local testing.

For automated checks, run `npm test` and `npm run build` from `backend/`.

### Resetting an agent password

An authenticated Admin can reset an agent's login password with:

```http
POST /api/admin/agents/:id/reset-password
Content-Type: application/json
```

```json
{ "newPassword": "Aisha@123456" }
```

The password must be 12–72 characters, matching the existing agent password
rules. The API uses the existing bcrypt password hashing service and returns
only the agent ID and a success message. Operators and unauthenticated requests
are rejected.

## Real-time fleet updates

The Express API and Socket.IO share the same HTTP server. Socket connections use
the existing `swerv_access` and `swerv_agent_access` HttpOnly cookies. The
server verifies the cookie against the active MongoDB user or agent before it
assigns a room. Admins and Operators can join `fleet:monitors`, matching the
existing authorization on the Live Fleet API. An agent is assigned only to
`agent:<authenticated-agent-id>`. Clients cannot request room membership.

Socket.IO uses the existing `CLIENT_URL` setting for its allowed browser origin;
no new environment variable or credential is required.

Events sent by the server:

- `fleet:location` is sent only to `fleet:monitors` after an accepted location
  is saved. Its payload contains the agent ID, coordinates and GPS measurements,
  recorded/received timestamps, basic agent details, and a small active
  dispatch summary. It does not contain customer details.
- `dispatch:updated` is sent to fleet monitors and the rooms for the current and
  previous assigned agents. Its payload is `{ dispatchId, status,
  assignedAgentId }`. It is emitted only after the dispatch transaction commits,
  including when POD completes a delivery.

The Agent Portal browser tracker starts only while the authenticated agent has
an active delivery and browser location permission. It sends a reading every
20 seconds. The backend rejects readings older than two minutes and applies an
atomic 15-second per-agent throttle. Accepted readings continue to use the
existing `AgentLocation` history collection; the Agent also stores the last
accepted server receipt time for throttling. When dispatch updates remove the
agent's active delivery, the portal refreshes eligibility and stops its GPS
watcher. The Live Fleet page applies socket updates immediately and retains a
60-second API refresh as a fallback when the socket disconnects.

For local verification, start the backend and frontend with `CLIENT_URL` set to
the frontend origin, sign in as an Admin or Operator, then open Live Fleet. Sign
in to the Agent Portal in another browser session, assign an active delivery,
allow browser location, and start tracking. The new GPS marker should appear or
move without a page refresh. Change the dispatch status or complete POD and
verify the fleet and agent views refresh. Deny location permission to confirm
that the rest of the Agent Portal remains usable.

## Route optimization

The Admin/Operator Route Optimization page works with the existing one-pickup,
one-destination dispatch schema. It plans up to 12 active deliveries already
assigned to one active agent. Pending requests are not attached to an agent yet;
assign them through the existing dispatch workflow before planning a route. A
request in `assigned` status contributes pickup and destination stops. A request
in `picked_up` or `in_transit` contributes only its destination.

The backend requests a road distance/time matrix and route geometry from OSRM.
`ROUTING_SERVICE_BASE_URL` can point to an OSRM-compatible server; the example
defaults to `https://router.project-osrm.org`. The public demo may be rate-limited
or unavailable and follows fair-use restrictions, so use a self-hosted or
contracted routing service for production reliability. OSRM estimates do not
include live traffic. If the provider fails or cannot connect stops, the API
returns an error and does not substitute straight-line distances or fabricated
times.

The ordering algorithm is a nearest-next-stop heuristic. It chooses the
remaining eligible stop with the shortest provider-estimated travel time and
always keeps each pickup before its delivery. It is quick and understandable,
but does not guarantee the globally shortest route. The baseline is the
agent's saved sequence when one exists, otherwise the dispatch creation order.
If no fresh agent GPS position is available, the comparison starts at the first
baseline stop; the page labels this assumption instead of presenting it as the
agent's current location.

Authenticated Admin and Operator endpoints:

- `GET /api/route-optimization/agents/:agentId/deliveries` lists eligible
  assigned deliveries and coordinate gaps without returning customer details.
- `GET /api/route-optimization/agents/:agentId/plan` reads the saved sequence.
- `POST /api/route-optimization/preview` accepts `{ "agentId": "...",
  "dispatchRequestIds": ["..."] }` and returns baseline/optimized stops,
  provider road distance/time, route geometry and calculated comparison.
- `POST /api/route-optimization/apply` accepts the agent ID, selected dispatch
  IDs and optimized `{ dispatchRequestId, stopType }` sequence. It rechecks
  current assignment, active status, coordinates, complete stop membership and
  pickup precedence before saving the sequence in `RoutePlan`.

Applying a plan changes only that agent's saved route order. It does not assign
dispatches or change their lifecycle statuses. The frontend asks for
confirmation before calling the apply endpoint.

## Notification Management

Notifications are saved separately from dispatch activity and anomaly alert
records. Each notification belongs to one user or one agent. API reads and
updates always scope by both recipient type and authenticated recipient ID.
Dispatch creation, assignment/reassignment, selected lifecycle changes, POD
completion, agent availability changes, and newly saved real anomaly alerts
create notifications. Synthetic anomaly demo alerts and GPS updates do not.

Supported event types are `new_dispatch`, `dispatch_assigned`,
`dispatch_reassigned`, `dispatch_status_changed`, `delivery_completed`,
`anomaly_detected`, and `agent_status_changed`. Business-event notifications
are written in the same MongoDB transaction where the originating flow uses a
transaction. New real anomaly alerts and their notifications are also saved
together. Duplicate anomaly detections do not create duplicate notifications.

User-session endpoints for Admins and Operators:

- `GET /api/notifications?page=1&limit=10&unreadOnly=true` lists only the
  signed-in user's notifications. `unreadOnly` is optional.
- `GET /api/notifications/unread-count` returns that user's unread count.
- `PATCH /api/notifications/:id/read` marks one owned notification as read.
- `PATCH /api/notifications/read-all` marks all of the signed-in user's
  notifications as read.

Agents use the same operations under `/api/agent/notifications` with their
agent session cookie. A user session cannot access agent notifications, and an
agent session cannot access user notifications. Clients do not provide a
recipient ID for list or read operations.

Socket.IO emits `notification:new` after notification persistence commits.
Its payload contains `id`, `recipientType`, `recipientId`, `eventType`,
`title`, `message`, `relatedEntityType`, `relatedEntityId`, `createdAt`, and
`readAt`. Authenticated Admins and Operators join both `fleet:monitors` and
their server-assigned `user:<userId>` room. Agents join only
`agent:<agentId>`. Notifications are sent to the matching private recipient
room, never to the fleet-wide room. The frontend refreshes from the API after
socket reconnection; MongoDB remains the source of truth.

Run backend tests from `backend/`:

```powershell
npx vitest run test/notification.test.ts test/notificationModel.test.ts test/realtime.test.ts test/anomalyDetection.test.ts
```

Frontend notification tests use the existing Node test runner through the
installed backend TypeScript runner. From `frontend/`, run:

```powershell
..\backend\node_modules\.bin\tsx.cmd --test test/notifications.test.ts test/notificationBell.test.ts
```

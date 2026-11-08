# SWERV

SWERV — AI-Powered Real-Time Fleet Dispatch & Operations Engine — currently provides a React operations dashboard and an Express API with cookie-based authentication and role checks. Fleet operations and analytics remain demo placeholders.

## Requirements

- Node.js 20.19+ or 22.12+
- npm
- MongoDB Atlas or another MongoDB replica set (transactions are required for the one-time administrator bootstrap)

## Environment

For a fresh checkout, copy the example only if a local environment file does not already exist, then set its values. Do not overwrite an existing `.env`/`.ENV` file; it may contain your MongoDB connection string.

```powershell
if (-not (Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
```

| Variable | Purpose |
| --- | --- |
| `PORT` | API port; defaults to `5000` |
| `NODE_ENV` | Use `development` locally and `production` when deployed |
| `CLIENT_URL` | Exact frontend origin allowed by CORS, normally `http://localhost:5173` |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Random signing key, at least 32 characters |
| `JWT_EXPIRES_IN` | JWT and cookie lifetime, e.g. `1d`, `12h`, `30m`; defaults to `1d` |

Keep `.env`/`.ENV` local. Both are ignored by Git. Never put real values in `.env.example`.

## Run locally

Start the backend in one terminal after setting the environment variables:

```powershell
cd backend
npm install
npm run dev
```

Start the frontend in another terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>. The API listens on <http://localhost:5000> after MongoDB connects. The health check is <http://localhost:5000/api/health>.

## Authentication architecture

- Passwords are hashed with bcryptjs (12 rounds) and excluded from normal model reads and JSON responses.
- Login issues a signed JWT in the `swerv_access` HttpOnly cookie. The token is never returned in JSON or stored in browser localStorage.
- Cookies use `SameSite=Lax`, `Path=/`, and `Secure` in production. CORS allows only `CLIENT_URL` and enables credentials.
- Each protected request verifies the JWT, reloads the user from MongoDB, and rejects deleted or inactive accounts. Authorization uses the database role, not a client-supplied or stale token role.
- Registration is rate limited to 10 attempts per IP per 15 minutes. Login shares that limiter. The limiter is relaxed only in the automated test environment.
- The bootstrap state is a singleton MongoDB document. Initial-admin assignment and user creation happen in one transaction. The first successful public registration becomes `admin`; all later public registrations are `operator`. Clients cannot set a role. MongoDB Atlas supports the required transaction behavior.

## Roles

| Role | Permissions |
| --- | --- |
| `admin` | Authenticated dashboard and `GET /api/admin/dashboard` |
| `operator` | Authenticated dashboard and current-user profile |

There is no public role-change API.

## Authentication APIs

All request and response bodies use JSON. Successful API responses follow `{ "success": true, "message": "…", "data": { … } }`; errors follow `{ "success": false, "message": "…" }` (validation errors may also include `errors`). The JWT is carried only by the response cookie.

### Register — `POST /api/auth/register`

```json
{
  "name": "Casey Morgan",
  "email": "casey@example.com",
  "password": "ChooseASecret9!"
}
```

Returns `201` with a safe user profile and sets the authentication cookie. The first account is the initial administrator. A duplicate email returns `409`; invalid input or an attempted extra `role` field returns `400`.

Example response body (timestamps and the generated ID vary):

```json
{
  "success": true,
  "message": "Account created.",
  "data": {
    "user": {
      "id": "665f…",
      "name": "Casey Morgan",
      "email": "casey@example.com",
      "role": "admin",
      "isActive": true,
      "createdAt": "2026-11-03T00:00:00.000Z",
      "updatedAt": "2026-11-03T00:00:00.000Z"
    }
  }
}
```

### Login — `POST /api/auth/login`

```json
{
  "email": "casey@example.com",
  "password": "ChooseASecret9!"
}
```

Returns `200` with the safe profile and sets the cookie. Incorrect credentials return the same generic `401` response.

### Logout — `POST /api/auth/logout`

Clears the `swerv_access` cookie and returns `200`. The endpoint is safe to call even if already signed out.

### Current user — `GET /api/auth/me`

Requires the authentication cookie. Returns the safe current-user profile; missing, malformed, expired, or inactive credentials return `401`.

### Administrator check — `GET /api/admin/dashboard`

Requires the cookie and the `admin` role. An unauthenticated request returns `401`; an operator receives `403`.

## Postman quick check

1. Send `POST http://localhost:5000/api/auth/register` with the registration JSON above. Postman’s cookie jar should retain `swerv_access`.
2. Send `GET http://localhost:5000/api/auth/me` and confirm it returns the registered profile.
3. Send `GET http://localhost:5000/api/admin/dashboard`; it succeeds for the first registered user. Register another user and repeat to confirm an operator gets `403`.
4. Send `POST http://localhost:5000/api/auth/logout`, then call `/api/auth/me` again and confirm it returns `401`.

## Build and tests

```powershell
cd frontend
npm run build
npm run lint

cd ../backend
npm run build
npm test
```

Backend integration tests use a temporary in-memory MongoDB replica set, so they exercise transaction-based admin bootstrap without writing test accounts to Atlas.

## Milestone boundary

The dashboard cards are clearly marked demo placeholders. Fleet-agent management, dispatch, geospatial queries, Socket.IO, algorithms, simulation, analytics, Redis, and ML are outside the completed milestones and are not implemented here.

## Fleet agent management (Milestone 3)

Agents are stored separately from user accounts. The model includes a server-generated immutable `agentCode`, name, normalized unique email, phone, active flag, vehicle (`vehicleType`, `registrationNumber`, `manufacturer`, `model`), operational `status`, `capacity.maxOrders`, `capabilities`, and Mongoose timestamps. Vehicle registrations are unique. Agent records contain no password or location data. Activity history stores the agent, event, description, authenticated actor, optional before/after values, and creation time.

All routes require the `swerv_access` authentication cookie. Admins and Operators can list and view agents. Only Admins can create, edit, archive, or suspend/reinstate an agent. Both roles can make permitted operational status changes. Agent writes and their activity events commit in the same MongoDB transaction.

| Method and path | Role | Request body |
| --- | --- | --- |
| `POST /api/agents` | Admin | name, email, phone, vehicle, capacity, capabilities |
| `GET /api/agents` | Admin, Operator | Query filters below |
| `GET /api/agents/:id` | Admin, Operator | � |
| `PATCH /api/agents/:id` | Admin | Any subset of name, email, phone, vehicle, capacity, capabilities |
| `PATCH /api/agents/:id/status` | Admin, Operator | `{ "status": "on_duty" }` |
| `PATCH /api/agents/:id/archive` | Admin | � |

Create body example:

```json
{
  "name": "Morgan Lee",
  "email": "morgan@example.com",
  "phone": "+1 555 123 4567",
  "vehicle": {
    "vehicleType": "van",
    "registrationNumber": "SW-1234",
    "manufacturer": "Ford",
    "model": "Transit"
  },
  "capacity": { "maxOrders": 12 },
  "capabilities": ["parcel_delivery", "express_delivery"]
}
```

The server generates `agentCode`; clients cannot set it, `isActive`, or status in create/edit bodies. Vehicle types are `car`, `van`, `motorcycle`, `truck`, `bicycle`. Capabilities are `parcel_delivery`, `food_delivery`, `document_delivery`, `heavy_goods`, and `express_delivery`.

Status transitions are `available` ? `unavailable`, `on_duty`, or `suspended`; `unavailable` ? `available` or `suspended`; `on_duty` ? `unavailable` or `suspended`; and `suspended` ? `unavailable`. A transition into or out of `suspended` is Admin-only. Archived agents cannot be edited, have status changed, or be archived again.

List query parameters are `page` (default 1), `limit` (default 20, maximum 100), `search` (name/email/agentCode), `status`, `vehicleType`, `capability`, and `isActive` (default true). For example:

```text
GET http://localhost:5000/api/agents?page=1&limit=20&status=available&vehicleType=van&capability=parcel_delivery&isActive=true
GET http://localhost:5000/api/agents?search=morgan
```

Success uses `{ "success": true, "message": "...", "data": { ... } }`. List data contains `agents` and pagination metadata. Agent detail data contains `agent` and the latest 20 `activity` events. Errors use `{ "success": false, "message": "..." }`; malformed input or IDs return 400, missing records 404, role restrictions 403, missing/invalid auth 401, and duplicate email/registration values 409.

### Postman checks

Use the existing register/login endpoint first and retain the `swerv_access` cookie in Postman's cookie jar. The initial registered account is an Admin; subsequent public registrations are Operators. Try the create example above as Admin, list agents as either role, and retrieve a created record using its `_id`. Patch its phone as Admin, then change status with `PATCH /api/agents/:id/status` and `{ "status": "on_duty" }`. Confirm an Operator receives 403 when creating/editing, and when attempting to suspend. Archive as Admin and verify the record disappears from the default list; `GET /api/agents?isActive=false` lists archived agents. Duplicate email or registration returns 409.


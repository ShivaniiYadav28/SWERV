# SWERV Anomaly Detection on Render

This guide prepares the standalone FastAPI service only. It does not create or
change the SWERV backend, frontend, Vercel project, or any other Render
service. Do not deploy this service until deployment is explicitly approved.

## Render Service

The new service is defined in this workspace's `render.yaml`:

| Setting | Value |
| --- | --- |
| Service name | `swerv-anomaly-detection` |
| Service type | Web Service |
| Runtime | Python |
| Root directory | `ml/anomaly_detection` |
| Build command | `pip install -r requirements.txt` |
| Start command | `uvicorn src.api:app --host 0.0.0.0 --port $PORT` |
| Health check path | `/health` |
| Auto deploy | Disabled |

The service has no MongoDB dependency. Its demo scenarios are loaded from its
own generated demo dataset. The browser does not call this service directly;
the existing Node backend calls authenticated `/analyze-demo` with an empty
request body.

The Blueprint generates `ANOMALY_DETECTION_API_KEY` as a secret value. When
creating the service, copy that value directly from its private Render
environment settings into the existing SWERV backend's private environment
settings. Do not put it in this file, source code, frontend variables, a commit,
or a log.

## Environment Variables

Required by the anomaly service:

| Variable | Value |
| --- | --- |
| `ANOMALY_DETECTION_API_KEY` | Random secret of at least 32 characters. Render generates it for the new service. |
| `PORT` | Injected by Render; Uvicorn uses `$PORT`. |

Required by the existing SWERV backend to use this service:

| Variable | Value |
| --- | --- |
| `ANOMALY_DETECTION_SERVICE_URL` | `https://swerv-anomaly-detection.onrender.com` (or the service's actual Render URL) |
| `ANOMALY_DETECTION_API_KEY` | The exact same secret value configured on the anomaly service. |

The API key is server-to-server only. Never create a `VITE_` variable for it.
It is not needed by Vercel or browser code.

For a locally generated key, use Python's `secrets` module and keep the output
private:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Set the same generated value in both service environments. Do not paste it into
shell commands that may be retained in history; use the environment editor or
a protected secret store.

## Verification

After the service is deployed with approval, check the public health endpoint:

```powershell
$serviceUrl = 'https://swerv-anomaly-detection.onrender.com'
Invoke-RestMethod "$serviceUrl/health"
```

Expected readiness fields include:

```json
{
  "status": "ok",
  "model_available": true,
  "model_version": "isolation_forest-synthetic-b3c24dbf05ff",
  "artifact_integrity_status": "verified",
  "feature_schema_compatible": true,
  "demo_data_available": true
}
```

To test the protected demonstration endpoint from a trusted backend-side
environment, set `$env:ANOMALY_DETECTION_API_KEY` using the protected value,
then run:

```powershell
$headers = @{ Authorization = "Bearer $env:ANOMALY_DETECTION_API_KEY" }
Invoke-RestMethod -Method Post -Uri "$serviceUrl/analyze-demo" -Headers $headers -ContentType 'application/json' -Body '{}'
```

The response contains 30 service-generated scenarios. `scenario_category` is
generated dataset context, not an Isolation Forest category prediction. The
model score is not a probability, and demo candidates are not confirmed
operational incidents. `/predict` is also protected and accepts only strict
feature vectors with `detection_mode: "synthetic_demo"`; it does not accept
dispatch, customer, agent, delivery, or GPS record objects.

The local Python suite can be run before deployment from this directory:

```powershell
python -m unittest discover -s tests -v
```

## Artifact Delivery

The trained `.joblib` artifact is Git LFS-managed. Before any future deployment,
confirm the Render build checkout contains the actual artifact bytes, not an
LFS pointer, and that `models/synthetic/anomaly_detector.metadata.json` is
present. The service verifies the pinned SHA-256 and schema before Joblib
deserialization. `/health` must report `artifact_integrity_status: "verified"`
and the expected model version. Do not retrain or substitute an artifact as a
deployment workaround.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Health reports `model_available: false` or integrity `failed` | Confirm the model artifact was fetched from Git LFS, its metadata sidecar is included, and both match the approved model version/hash. |
| Health reports schema incompatible | Deploy the matching anomaly service source and unchanged Stage 2 artifact/metadata together. |
| Health reports demo data unavailable | Confirm `data/processed/synthetic/synthetic_demo.csv` and its dataset metadata are included beneath the configured root directory. |
| `/analyze-demo` returns 401 | Confirm the request uses `Authorization: Bearer ...` and that the caller's key matches the service key exactly. |
| `/analyze-demo` returns 503 authentication configuration error | Set a non-empty `ANOMALY_DETECTION_API_KEY` of at least 32 characters on the ML service. |
| Backend returns a configuration 503 | Set both backend variables, and ensure the key matches the anomaly service value. |
| Backend returns an upstream 502/503 | Check the Render service health, startup logs, request contract/version, and network access. The backend response intentionally hides upstream details. |
| Service fails to bind | Keep the configured start command bound to `0.0.0.0` and Render's injected `$PORT`. |

The API key must never be logged. The service itself logs only safe error
categories and model readiness state.

## Deployment Gate

This Blueprint has `autoDeploy: false`. Stage 6 has not deployed the service or
changed Render settings. Deployment also requires an approved commit containing
the complete anomaly service and backend integration, plus confirmation that
the remote repository provides the matching Git LFS artifact. Obtain explicit
approval before creating or deploying the Render service.
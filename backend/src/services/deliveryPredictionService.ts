import { getDemoMlServiceBaseUrl, getMlServiceBaseUrl } from '../config/mlService.js';
import { DispatchRequest, dispatchPriorities, packageCategories } from '../models/DispatchRequest.js';
import { DispatchRequestActivity } from '../models/DispatchRequestActivity.js';
import { HttpError } from '../utils/httpError.js';

export const predictionTimeoutMs = 5_000;
export const demoPredictionTimeoutMs = 70_000;
export const demoPredictionAttemptTimeoutMs = 50_000;

const demoPredictionMaxAttempts = 2;
const demoPredictionRetryDelayMs = 1_000;

type PredictionInput = {
  request_created_at: string;
  assigned_at: string;
  priority: string;
  package_category: string;
  weight_kg: number;
  quantity: number;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  destination_latitude: number | null;
  destination_longitude: number | null;
};

export type PredictionResult = {
  predictedDurationMinutes: number;
  modelVersion: string;
  predictionStatus: 'available';
};

export type DemoPredictionResult = {
  predictedDurationMinutes: number;
  predictionType: 'simulated_demo';
  modelVersion: string;
  predictionStatus: 'available';
  disclaimer: string;
};

type PythonPredictionResponse = {
  predicted_duration_minutes: number | null;
  model_version: string | null;
  prediction_status: 'available' | 'unavailable';
  message: string;
};

type PythonDemoPredictionResponse = {
  predicted_duration_minutes: number | null;
  prediction_type: 'simulated_demo';
  model_version: string | null;
  prediction_status: 'available' | 'unavailable';
  message: string;
};

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function getCoordinates(
  location: { latitude?: number | null; longitude?: number | null } | undefined,
  useCoordinates: boolean,
): { latitude: number | null; longitude: number | null } {
  const latitude = location?.latitude;
  const longitude = location?.longitude;
  const isValidPair =
    typeof latitude === 'number'
    && Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
    && typeof longitude === 'number'
    && Number.isFinite(longitude)
    && longitude >= -180
    && longitude <= 180;

  if (!useCoordinates || !isValidPair) {
    return { latitude: null, longitude: null };
  }
  return { latitude, longitude };
}

function buildPredictionInput(
  dispatchRequest: {
    createdAt?: Date;
    priority?: string;
    package?: { category?: string; weightKg?: number; quantity?: number };
    pickup?: { latitude?: number | null; longitude?: number | null };
    delivery?: { latitude?: number | null; longitude?: number | null };
  },
  assignedAt: Date,
  useCoordinates: boolean,
): PredictionInput {
  const packageDetails = dispatchRequest.package;
  if (
    !validDate(dispatchRequest.createdAt)
    || !validDate(assignedAt)
    || assignedAt < dispatchRequest.createdAt
    || !dispatchRequest.priority
    || !dispatchPriorities.includes(dispatchRequest.priority as typeof dispatchPriorities[number])
    || !packageDetails?.category
    || !packageCategories.includes(packageDetails.category as typeof packageCategories[number])
    || typeof packageDetails.weightKg !== 'number'
    || !Number.isFinite(packageDetails.weightKg)
    || packageDetails.weightKg <= 0
    || packageDetails.weightKg > 10_000
    || typeof packageDetails.quantity !== 'number'
    || !Number.isInteger(packageDetails.quantity)
    || packageDetails.quantity < 1
    || packageDetails.quantity > 1_000
  ) {
    throw new HttpError(409, 'This dispatch request is missing valid prediction inputs.');
  }

  const pickup = getCoordinates(dispatchRequest.pickup, useCoordinates);
  const destination = getCoordinates(dispatchRequest.delivery, useCoordinates);

  return {
    request_created_at: dispatchRequest.createdAt.toISOString(),
    assigned_at: assignedAt.toISOString(),
    priority: dispatchRequest.priority,
    package_category: packageDetails.category,
    weight_kg: packageDetails.weightKg,
    quantity: packageDetails.quantity,
    pickup_latitude: pickup.latitude,
    pickup_longitude: pickup.longitude,
    destination_latitude: destination.latitude,
    destination_longitude: destination.longitude,
  };
}

function parsePythonResponse(value: unknown): PythonPredictionResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const expectedKeys = [
    'predicted_duration_minutes',
    'model_version',
    'prediction_status',
    'message',
  ];
  if (Object.keys(response).sort().join(',') !== expectedKeys.sort().join(',')) return null;
  if (
    (response.prediction_status !== 'available' && response.prediction_status !== 'unavailable')
    || !(response.predicted_duration_minutes === null
      || (typeof response.predicted_duration_minutes === 'number'
        && Number.isFinite(response.predicted_duration_minutes)))
    || !(response.model_version === null || typeof response.model_version === 'string')
    || typeof response.message !== 'string'
    || response.message.trim().length === 0
  ) {
    return null;
  }

  if (response.prediction_status === 'available') {
    if (
      typeof response.predicted_duration_minutes !== 'number'
      || response.predicted_duration_minutes <= 0
      || typeof response.model_version !== 'string'
      || response.model_version.length === 0
    ) {
      return null;
    }
  } else if (response.predicted_duration_minutes !== null || response.model_version !== null) {
    return null;
  }

  return response as PythonPredictionResponse;
}

async function requestPythonPrediction(input: PredictionInput): Promise<PredictionResult> {
  const baseUrl = getMlServiceBaseUrl();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(predictionTimeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown connection error';
    console.error(`[delivery-time-prediction] Could not reach ${baseUrl}/predict: ${detail}`);
    throw new HttpError(503, 'Delivery time prediction service is unavailable.');
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new HttpError(503, 'Delivery time prediction service is unavailable.');
    }
    throw new HttpError(502, 'Prediction service returned an invalid response.');
  }

  const prediction = parsePythonResponse(responseBody);
  if (!prediction) {
    if (!response.ok) {
      console.error(`[delivery-time-prediction] Model service returned HTTP ${response.status} with an invalid error response.`);
    }
    throw new HttpError(502, 'Prediction service returned an invalid response.');
  }
  if (!response.ok) {
    console.error(`[delivery-time-prediction] Model service returned HTTP ${response.status}: ${prediction.message}`);
    if (response.status === 503 && prediction.prediction_status === 'unavailable') {
      throw new HttpError(503, 'Delivery time prediction is currently unavailable.');
    }
    throw new HttpError(502, 'Prediction service could not process the request.');
  }
  if (prediction.prediction_status === 'unavailable') {
    throw new HttpError(502, 'Prediction service returned an invalid response.');
  }

  return {
    predictedDurationMinutes: prediction.predicted_duration_minutes as number,
    modelVersion: prediction.model_version as string,
    predictionStatus: 'available',
  };
}

function parsePythonDemoResponse(value: unknown): PythonDemoPredictionResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const expectedKeys = [
    'predicted_duration_minutes',
    'prediction_type',
    'model_version',
    'prediction_status',
    'message',
  ];
  if (Object.keys(response).sort().join(',') !== expectedKeys.sort().join(',')) return null;
  if (
    response.prediction_type !== 'simulated_demo'
    || (response.prediction_status !== 'available' && response.prediction_status !== 'unavailable')
    || !(response.predicted_duration_minutes === null
      || (typeof response.predicted_duration_minutes === 'number'
        && Number.isFinite(response.predicted_duration_minutes)))
    || !(response.model_version === null || typeof response.model_version === 'string')
    || typeof response.message !== 'string'
    || response.message.trim().length === 0
  ) {
    return null;
  }

  if (response.prediction_status === 'available') {
    if (
      typeof response.predicted_duration_minutes !== 'number'
      || response.predicted_duration_minutes <= 0
      || typeof response.model_version !== 'string'
      || response.model_version.length === 0
    ) {
      return null;
    }
  } else if (
    response.predicted_duration_minutes !== null
    || !(response.model_version === null || typeof response.model_version === 'string')
  ) {
    return null;
  }

  return response as PythonDemoPredictionResponse;
}

function isTransientConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || error instanceof TypeError;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function waitBeforeDemoRetry(requestStartedAt: number): Promise<void> {
  const remainingMs = demoPredictionTimeoutMs - (Date.now() - requestStartedAt);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(demoPredictionRetryDelayMs, remainingMs));
  });
}

async function requestPythonDemoPrediction(input: PredictionInput): Promise<DemoPredictionResult> {
  const baseUrl = getDemoMlServiceBaseUrl();
  const requestStartedAt = Date.now();

  for (let attempt = 1; attempt <= demoPredictionMaxAttempts; attempt += 1) {
    const remainingMs = demoPredictionTimeoutMs - (Date.now() - requestStartedAt);
    if (remainingMs <= 0) {
      console.warn('[delivery-time-prediction] Demo request deadline reached', {
        attempt,
        elapsed_ms: Date.now() - requestStartedAt,
        reason: 'overall_timeout',
      });
      throw new HttpError(503, 'Demo prediction service is unavailable.');
    }

    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const attemptTimeoutMs = Math.min(demoPredictionAttemptTimeoutMs, remainingMs);
    const attemptTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, attemptTimeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/demo/predict`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
      } catch (error) {
        const elapsedMs = Date.now() - attemptStartedAt;
        const reason = timedOut || isTimeoutError(error) ? 'timeout' : 'connection_error';
        console.warn('[delivery-time-prediction] Demo upstream request failed', {
          attempt,
          elapsed_ms: elapsedMs,
          reason,
        });
        if (!timedOut && !isTransientConnectionError(error)) {
          throw new HttpError(503, 'Demo prediction service is unavailable.');
        }
        if (attempt === demoPredictionMaxAttempts) {
          throw new HttpError(503, 'Demo prediction service is unavailable.');
        }
        await waitBeforeDemoRetry(requestStartedAt);
        continue;
      }

      const elapsedMs = Date.now() - attemptStartedAt;
      if ([502, 503, 504].includes(response.status)) {
        console.warn('[delivery-time-prediction] Demo upstream returned a transient status', {
          attempt,
          upstream_status: response.status,
          elapsed_ms: elapsedMs,
        });
        if (attempt === demoPredictionMaxAttempts) {
          throw new HttpError(503, 'Demo delivery time prediction is currently unavailable.');
        }
        await waitBeforeDemoRetry(requestStartedAt);
        continue;
      }

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch (error) {
        if (timedOut || isTimeoutError(error) || error instanceof TypeError) {
          const reason = timedOut || isTimeoutError(error) ? 'timeout' : 'connection_error';
          console.warn('[delivery-time-prediction] Demo upstream response failed', {
            attempt,
            upstream_status: response.status,
            elapsed_ms: Date.now() - attemptStartedAt,
            reason,
          });
          if (attempt < demoPredictionMaxAttempts) {
            await waitBeforeDemoRetry(requestStartedAt);
            continue;
          }
          throw new HttpError(503, 'Demo prediction service is unavailable.');
        }
        if (!response.ok) {
          console.warn('[delivery-time-prediction] Demo upstream returned an invalid error response', {
            attempt,
            upstream_status: response.status,
            elapsed_ms: Date.now() - attemptStartedAt,
            reason: 'invalid_error_response',
          });
          throw new HttpError(503, 'Demo delivery time prediction is currently unavailable.');
        }
        console.warn('[delivery-time-prediction] Demo upstream returned malformed successful JSON', {
          attempt,
          upstream_status: response.status,
          elapsed_ms: Date.now() - attemptStartedAt,
          reason: 'invalid_json',
        });
        throw new HttpError(502, 'Demo prediction service returned an invalid response.');
      }

      const prediction = parsePythonDemoResponse(responseBody);
      if (!prediction) {
        const status = response.ok ? 502 : 503;
        console.warn('[delivery-time-prediction] Demo upstream returned an invalid response', {
          attempt,
          upstream_status: response.status,
          elapsed_ms: Date.now() - attemptStartedAt,
          reason: response.ok ? 'invalid_success_response' : 'invalid_error_response',
        });
        throw new HttpError(
          status,
          response.ok
            ? 'Demo prediction service returned an invalid response.'
            : 'Demo delivery time prediction is currently unavailable.',
        );
      }
      if (!response.ok) {
        console.warn('[delivery-time-prediction] Demo upstream returned an error', {
          attempt,
          upstream_status: response.status,
          elapsed_ms: Date.now() - attemptStartedAt,
          reason: 'upstream_error',
        });
        if (response.status === 503 && prediction.prediction_status === 'unavailable') {
          throw new HttpError(503, 'Demo delivery time prediction is currently unavailable.');
        }
        throw new HttpError(502, 'Demo prediction service could not process the request.');
      }
      if (prediction.prediction_status === 'unavailable') {
        console.warn('[delivery-time-prediction] Demo model reported unavailable', {
          attempt,
          upstream_status: response.status,
          elapsed_ms: Date.now() - attemptStartedAt,
          reason: 'model_unavailable',
        });
        throw new HttpError(503, 'Demo delivery time prediction is currently unavailable.');
      }

      console.info('[delivery-time-prediction] Demo upstream response', {
        attempt,
        upstream_status: response.status,
        elapsed_ms: Date.now() - attemptStartedAt,
      });

      return {
        predictedDurationMinutes: Math.round(prediction.predicted_duration_minutes! * 10) / 10,
        predictionType: 'simulated_demo',
        modelVersion: prediction.model_version!,
        predictionStatus: 'available',
        disclaimer: 'Research Demo — Simulated Dataset',
      };
    } finally {
      clearTimeout(attemptTimer);
    }
  }

  throw new HttpError(503, 'Demo prediction service is unavailable.');
}

export async function predictDispatchRequestDeliveryTime(
  dispatchRequestId: string,
): Promise<PredictionResult> {
  const dispatchRequest = await DispatchRequest.findById(dispatchRequestId).lean();
  if (!dispatchRequest) throw new HttpError(404, 'Dispatch request not found.');
  if (dispatchRequest.status !== 'assigned' || !dispatchRequest.assignedAgent) {
    throw new HttpError(409, 'Prediction is available only while a dispatch request is assigned and not yet picked up.');
  }

  const activity = await DispatchRequestActivity.find({
    dispatchRequestId: dispatchRequest._id,
    eventType: { $in: ['assignment_changed', 'locations_changed'] },
  })
    .select('eventType createdAt newValue.agentId')
    .sort({ createdAt: -1 })
    .lean();

  const latestAssignment = activity.find((event) => event.eventType === 'assignment_changed');
  const assignmentAgentId = (latestAssignment?.newValue as { agentId?: unknown } | undefined)?.agentId;
  if (
    !latestAssignment
    || !validDate(latestAssignment.createdAt)
    || String(assignmentAgentId ?? '') !== dispatchRequest.assignedAgent.toString()
  ) {
    throw new HttpError(409, 'Dispatch assignment history is incomplete; prediction cannot be generated.');
  }

  const coordinatesChangedAfterAssignment = activity.some(
    (event) => event.eventType === 'locations_changed'
      && validDate(event.createdAt)
      && event.createdAt >= latestAssignment.createdAt,
  );
  const input = buildPredictionInput(
    dispatchRequest,
    latestAssignment.createdAt,
    !coordinatesChangedAfterAssignment,
  );
  return requestPythonPrediction(input);
}

export async function predictDispatchRequestDemoDeliveryTime(
  dispatchRequestId: string,
): Promise<DemoPredictionResult> {
  const dispatchRequest = await DispatchRequest.findById(dispatchRequestId).lean();
  if (!dispatchRequest) throw new HttpError(404, 'Dispatch request not found.');
  if (dispatchRequest.status !== 'assigned' || !dispatchRequest.assignedAgent) {
    throw new HttpError(409, 'Prediction is available only while a dispatch request is assigned and not yet picked up.');
  }

  const activity = await DispatchRequestActivity.find({
    dispatchRequestId: dispatchRequest._id,
    eventType: { $in: ['assignment_changed', 'locations_changed'] },
  })
    .select('eventType createdAt newValue.agentId')
    .sort({ createdAt: -1 })
    .lean();

  const latestAssignment = activity.find((event) => event.eventType === 'assignment_changed');
  const assignmentAgentId = (latestAssignment?.newValue as { agentId?: unknown } | undefined)?.agentId;
  if (
    !latestAssignment
    || !validDate(latestAssignment.createdAt)
    || String(assignmentAgentId ?? '') !== dispatchRequest.assignedAgent.toString()
  ) {
    throw new HttpError(409, 'Dispatch assignment history is incomplete; prediction cannot be generated.');
  }

  const coordinatesChangedAfterAssignment = activity.some(
    (event) => event.eventType === 'locations_changed'
      && validDate(event.createdAt)
      && event.createdAt >= latestAssignment.createdAt,
  );
  const input = buildPredictionInput(
    dispatchRequest,
    latestAssignment.createdAt,
    !coordinatesChangedAfterAssignment,
  );
  return requestPythonDemoPrediction(input);
}

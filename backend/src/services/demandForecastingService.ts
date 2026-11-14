import {
  getDemandForecastingServiceApiKey,
  getDemandForecastingServiceUrl,
} from '../config/demandForecastingService.js';
import { HttpError } from '../utils/httpError.js';

export const forecastTimeoutMs = 70_000;
export const forecastAttemptTimeoutMs = 50_000;
const maximumForecastPeriods = 168;
const maximumForecastAttempts = 2;
const retryDelayMs = 1_000;
const syntheticHistorySource = 'synthetic_hourly_demand.csv' as const;

export type DemandForecastInput = {
  forecastStartTimestamp: string;
  forecastPeriods: number;
};

export type HourlyDemandPrediction = {
  timestamp: string;
  requestCount: number;
};

export type DemandForecastResult = {
  mode: 'synthetic_demo';
  historySource: typeof syntheticHistorySource;
  historyProvenance: string;
  forecastStartTimestamp: string;
  forecastPeriods: number;
  predictions: HourlyDemandPrediction[];
  modelVersion: string;
  trainingSource: 'synthetic';
  syntheticProvenance: string;
};

function expectedForecastTimestamp(startTimestamp: string, periodIndex: number): string {
  return new Date(Date.parse(startTimestamp) + periodIndex * 60 * 60 * 1_000).toISOString();
}

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || error instanceof TypeError;
}

async function waitBeforeRetry(requestStartedAt: number): Promise<void> {
  const remainingMs = forecastTimeoutMs - (Date.now() - requestStartedAt);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, Math.min(retryDelayMs, remainingMs));
  });
}

function parsePythonForecast(
  value: unknown,
  input: DemandForecastInput,
): Omit<DemandForecastResult, 'mode'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const expectedKeys = [
    'forecast_start_timestamp',
    'forecast_periods',
    'predictions',
    'model_version',
    'history_source',
    'history_provenance',
    'training_source',
    'synthetic_provenance',
  ].sort();
  if (Object.keys(response).sort().join(',') !== expectedKeys.join(',')) return null;
  if (
    typeof response.forecast_start_timestamp !== 'string'
    || Date.parse(response.forecast_start_timestamp) !== Date.parse(input.forecastStartTimestamp)
    || response.forecast_periods !== input.forecastPeriods
    || typeof response.model_version !== 'string'
    || !response.model_version.includes('synthetic')
    || response.history_source !== syntheticHistorySource
    || typeof response.history_provenance !== 'string'
    || response.history_provenance.trim().length === 0
    || response.training_source !== 'synthetic'
    || typeof response.synthetic_provenance !== 'string'
    || response.synthetic_provenance.trim().length === 0
    || !Array.isArray(response.predictions)
    || response.predictions.length !== input.forecastPeriods
  ) return null;

  const predictions: HourlyDemandPrediction[] = [];
  for (let index = 0; index < response.predictions.length; index += 1) {
    const item = response.predictions[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const prediction = item as Record<string, unknown>;
    if (
      Object.keys(prediction).sort().join(',') !== 'request_count,timestamp'
      || typeof prediction.timestamp !== 'string'
      || Date.parse(prediction.timestamp) !== Date.parse(expectedForecastTimestamp(input.forecastStartTimestamp, index))
      || !Number.isSafeInteger(prediction.request_count)
      || (prediction.request_count as number) < 0
    ) return null;
    predictions.push({
      timestamp: new Date(prediction.timestamp).toISOString(),
      requestCount: prediction.request_count as number,
    });
  }

  return {
    forecastStartTimestamp: new Date(response.forecast_start_timestamp).toISOString(),
    forecastPeriods: response.forecast_periods as number,
    predictions,
    modelVersion: response.model_version,
    historySource: response.history_source,
    historyProvenance: response.history_provenance,
    trainingSource: 'synthetic',
    syntheticProvenance: response.synthetic_provenance,
  };
}

export async function requestDemandForecast(input: DemandForecastInput): Promise<DemandForecastResult> {
  if (!Number.isInteger(input.forecastPeriods) || input.forecastPeriods < 1 || input.forecastPeriods > maximumForecastPeriods) {
    throw new HttpError(400, `forecastPeriods must be between 1 and ${maximumForecastPeriods}.`);
  }

  const baseUrl = getDemandForecastingServiceUrl();
  const apiKey = getDemandForecastingServiceApiKey();
  const requestStartedAt = Date.now();

  for (let attempt = 1; attempt <= maximumForecastAttempts; attempt += 1) {
    const remainingMs = forecastTimeoutMs - (Date.now() - requestStartedAt);
    if (remainingMs <= 0) {
      console.warn('[demand-forecasting] Request deadline reached', {
        attempt,
        elapsed_ms: Date.now() - requestStartedAt,
        reason: 'overall_timeout',
      });
      throw new HttpError(503, 'Demand forecasting service is unavailable or timed out.');
    }

    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const attemptTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.min(forecastAttemptTimeoutMs, remainingMs));

    try {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/predict`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            forecast_start_timestamp: input.forecastStartTimestamp,
            forecast_periods: input.forecastPeriods,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        const reason = timedOut || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
          ? 'timeout'
          : 'connection_error';
        console.warn('[demand-forecasting] Upstream request failed', {
          attempt,
          elapsed_ms: Date.now() - attemptStartedAt,
          reason,
        });
        if (!timedOut && !isTransientError(error)) {
          throw new HttpError(503, 'Demand forecasting service is unavailable or timed out.');
        }
        if (attempt === maximumForecastAttempts) {
          throw new HttpError(503, 'Demand forecasting service is unavailable or timed out.');
        }
        await waitBeforeRetry(requestStartedAt);
        continue;
      }

      const elapsedMs = Date.now() - attemptStartedAt;
      if ([502, 503, 504].includes(response.status)) {
        console.warn('[demand-forecasting] Upstream returned a transient status', {
          attempt,
          upstream_status: response.status,
          elapsed_ms: elapsedMs,
        });
        if (attempt === maximumForecastAttempts) {
          throw new HttpError(503, 'Demand forecasting service is currently unavailable.');
        }
        await waitBeforeRetry(requestStartedAt);
        continue;
      }

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch (error) {
        const transient = timedOut || isTransientError(error);
        console.warn('[demand-forecasting] Upstream response could not be read', {
          attempt,
          upstream_status: response.status,
          elapsed_ms: Date.now() - attemptStartedAt,
          reason: transient ? 'timeout_or_connection_error' : 'invalid_response',
        });
        if (transient && attempt < maximumForecastAttempts) {
          await waitBeforeRetry(requestStartedAt);
          continue;
        }
        if (transient) {
          throw new HttpError(503, 'Demand forecasting service is unavailable or timed out.');
        }
        throw new HttpError(502, 'Demand forecasting service returned an invalid response.');
      }

      if (!response.ok) {
        console.warn('[demand-forecasting] Upstream rejected request', {
          attempt,
          upstream_status: response.status,
          elapsed_ms: Date.now() - attemptStartedAt,
          reason: response.status === 401 || response.status === 403
            ? 'authentication_error'
            : response.status === 422
              ? 'validation_error'
              : 'upstream_error',
        });
        if (response.status === 422) {
          throw new HttpError(502, 'Demand forecasting service rejected the validated request.');
        }
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          throw new HttpError(503, 'Demand forecasting service is currently unavailable.');
        }
        throw new HttpError(502, 'Demand forecasting service could not process the request.');
      }

      const result = parsePythonForecast(responseBody, input);
      if (!result) {
        console.warn('[demand-forecasting] Upstream returned an invalid successful response', {
          attempt,
          upstream_status: response.status,
          elapsed_ms: Date.now() - attemptStartedAt,
          reason: 'invalid_success_response',
        });
        throw new HttpError(502, 'Demand forecasting service returned an invalid forecast or model metadata.');
      }

      console.info('[demand-forecasting] Upstream forecast succeeded', {
        attempt,
        upstream_status: response.status,
        elapsed_ms: Date.now() - attemptStartedAt,
      });
      return {
        ...result,
        mode: 'synthetic_demo',
      };
    } finally {
      clearTimeout(attemptTimer);
    }
  }

  throw new HttpError(503, 'Demand forecasting service is unavailable or timed out.');
}

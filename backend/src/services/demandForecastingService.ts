import { getDemandForecastingServiceUrl } from '../config/demandForecastingService.js';
import { DispatchRequest } from '../models/DispatchRequest.js';
import { HttpError } from '../utils/httpError.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const forecastTimeoutMs = 5_000;
const maximumForecastPeriods = 168;
const requiredHistoryHours = 168;
const millisecondsPerHour = 60 * 60 * 1_000;
const workspaceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ml/demand_forecasting');
const syntheticDatasetPath = resolve(workspaceDirectory, 'data/synthetic_hourly_demand.csv');
export type DemandDataMode = 'real' | 'synthetic_demo';

export type DemandHistoryResult = {
  available: boolean;
  message: string;
  forecastStartTimestamp: string;
  historyStartTimestamp: string;
  requiredHistoryHours: number;
  availableHistoryHours: number;
  historicalRequestCounts: number[] | null;
  mode: DemandDataMode;
  source: 'DispatchRequest.createdAt' | 'synthetic_hourly_demand.csv';
  provenance: string;
};

export type DemandForecastInput = {
  mode: DemandDataMode;
  forecastStartTimestamp: string;
  forecastPeriods: number;
  historicalRequestCounts: number[];
};

export type HourlyDemandPrediction = {
  timestamp: string;
  requestCount: number;
};

export type DemandForecastResult = {
  mode: DemandDataMode;
  historySource: DemandHistoryResult['source'];
  historyProvenance: string;
  forecastStartTimestamp: string;
  forecastPeriods: number;
  predictions: HourlyDemandPrediction[];
  modelVersion: string;
  trainingSource: 'synthetic';
  syntheticProvenance: string;
};

type PythonDemandForecastResponse = {
  forecast_start_timestamp: string;
  forecast_periods: number;
  predictions: Array<{ timestamp: string; request_count: number }>;
  model_version: string;
  training_source: 'synthetic';
  synthetic_provenance: string;
};

export async function getDemandHistory(
  mode: DemandDataMode,
  now = new Date(),
): Promise<DemandHistoryResult> {
  if (mode === 'synthetic_demo') return getSyntheticDemoHistory();
  return getRecentDemandHistory(now);
}

export async function getRecentDemandHistory(now = new Date()): Promise<DemandHistoryResult> {
  const forecastStart = new Date(Math.floor(now.getTime() / millisecondsPerHour) * millisecondsPerHour);
  const historyStart = new Date(forecastStart.getTime() - requiredHistoryHours * millisecondsPerHour);
  const earliestRequest = await DispatchRequest.findOne({ createdAt: { $type: 'date' } })
    .select('createdAt')
    .sort({ createdAt: 1 })
    .lean();
  const availableHistoryHours = earliestRequest?.createdAt instanceof Date
    ? Math.max(0, Math.min(
      requiredHistoryHours,
      Math.floor((forecastStart.getTime() - earliestRequest.createdAt.getTime()) / millisecondsPerHour),
    ))
    : 0;

  if (!earliestRequest || earliestRequest.createdAt > historyStart) {
    return {
      available: false,
      message: earliestRequest
        ? `Only ${availableHistoryHours} of ${requiredHistoryHours} required hourly history buckets are covered by recorded dispatch data.`
        : 'No recorded dispatch history is available for a forecast.',
      forecastStartTimestamp: forecastStart.toISOString(),
      historyStartTimestamp: historyStart.toISOString(),
      requiredHistoryHours,
      availableHistoryHours,
      historicalRequestCounts: null,
      source: 'DispatchRequest.createdAt',
      mode: 'real',
      provenance: 'Read-only counts from DispatchRequest.createdAt; incomplete hours are not estimated.',
    };
  }

  const hourlyGroups = await DispatchRequest.aggregate<{
    _id: string;
    requestCount: number;
  }>([
    { $match: { createdAt: { $gte: historyStart, $lt: forecastStart } } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%dT%H:00:00.000Z',
            date: '$createdAt',
            timezone: 'UTC',
          },
        },
        requestCount: { $sum: 1 },
      },
    },
  ]);
  const counts = Array<number>(requiredHistoryHours).fill(0);
  for (const bucket of hourlyGroups) {
    const index = (Date.parse(bucket._id) - historyStart.getTime()) / millisecondsPerHour;
    if (Number.isInteger(index) && index >= 0 && index < counts.length) {
      counts[index] = bucket.requestCount;
    }
  }

  return {
    available: true,
    message: 'A complete 168-hour history is available from recorded dispatch creation times.',
    forecastStartTimestamp: forecastStart.toISOString(),
    historyStartTimestamp: historyStart.toISOString(),
    requiredHistoryHours,
    availableHistoryHours: requiredHistoryHours,
    historicalRequestCounts: counts,
    source: 'DispatchRequest.createdAt',
    mode: 'real',
    provenance: 'Read-only counts from DispatchRequest.createdAt; zero buckets are included only inside the covered recorded window.',
  };
}

function getSyntheticDemoHistory(): DemandHistoryResult {
  const unavailable = (message: string, availableHistoryHours = 0): DemandHistoryResult => ({
    available: false,
    message,
    forecastStartTimestamp: '',
    historyStartTimestamp: '',
    requiredHistoryHours,
    availableHistoryHours,
    historicalRequestCounts: null,
    mode: 'synthetic_demo',
    source: 'synthetic_hourly_demand.csv',
    provenance: 'Generated synthetic hourly dataset; it does not represent actual SWERV demand.',
  });

  let fileContents: string;
  try {
    fileContents = readFileSync(syntheticDatasetPath, 'utf8');
  } catch {
    return unavailable('The bundled synthetic demo history is unavailable.');
  }

  const rows = fileContents.trim().split(/\r?\n/);
  if (rows.length < requiredHistoryHours + 1 || rows[0] !== 'timestamp,hour_of_day,day_of_week,is_weekend,month,trend_index,request_count,data_source') {
    return unavailable('The bundled synthetic demo history has an invalid format.');
  }
  const parsedRows: Array<{ timestamp: number; count: number }> = [];
  for (const row of rows.slice(1)) {
    const columns = row.split(',');
    if (columns.length !== 8 || columns[7] !== 'synthetic') return unavailable('The bundled history contains invalid or non-synthetic rows.');
    const timestamp = Date.parse(columns[0]);
    const count = Number(columns[6]);
    if (
      !Number.isFinite(timestamp)
      || !columns[0].endsWith('+00:00')
      || new Date(timestamp).getUTCMinutes() !== 0
      || new Date(timestamp).getUTCSeconds() !== 0
      || new Date(timestamp).getUTCMilliseconds() !== 0
      || !/^(0|[1-9]\d*)$/.test(columns[6])
      || !Number.isSafeInteger(count)
      || count < 0
    ) return unavailable('The bundled history contains invalid hourly values.');
    parsedRows.push({ timestamp, count });
  }
  for (let index = 1; index < parsedRows.length; index += 1) {
    if (parsedRows[index].timestamp - parsedRows[index - 1].timestamp !== millisecondsPerHour) {
      return unavailable('The bundled synthetic history does not contain continuous hourly buckets.');
    }
  }
  const historyRows = parsedRows.slice(-requiredHistoryHours);
  if (historyRows.length !== requiredHistoryHours) return unavailable('The bundled synthetic history has fewer than 168 hourly buckets.');
  const historyStart = new Date(historyRows[0].timestamp);
  const forecastStart = new Date(historyRows[historyRows.length - 1].timestamp + millisecondsPerHour);
  return {
    available: true,
    message: 'A complete 168-hour history is available from the explicitly selected synthetic demo dataset.',
    forecastStartTimestamp: forecastStart.toISOString(),
    historyStartTimestamp: historyStart.toISOString(),
    requiredHistoryHours,
    availableHistoryHours: requiredHistoryHours,
    historicalRequestCounts: historyRows.map((row) => row.count),
    mode: 'synthetic_demo',
    source: 'synthetic_hourly_demand.csv',
    provenance: 'Generated synthetic hourly dataset; it does not represent actual SWERV demand.',
  };
}

function expectedForecastTimestamp(startTimestamp: string, periodIndex: number): string {
  return new Date(Date.parse(startTimestamp) + periodIndex * 60 * 60 * 1_000).toISOString();
}

function parsePythonForecast(
  value: unknown,
  input: DemandForecastInput,
): Omit<DemandForecastResult, 'mode' | 'historySource' | 'historyProvenance'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const expectedKeys = [
    'forecast_start_timestamp',
    'forecast_periods',
    'predictions',
    'model_version',
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
    trainingSource: 'synthetic',
    syntheticProvenance: response.synthetic_provenance,
  };
}

export async function requestDemandForecast(input: DemandForecastInput): Promise<DemandForecastResult> {
  if (input.historicalRequestCounts.length !== requiredHistoryHours) {
    throw new HttpError(400, `Provide exactly ${requiredHistoryHours} historical hourly counts.`);
  }
  if (
    input.historicalRequestCounts.some((count) =>
      !Number.isSafeInteger(count) || count < 0,
    )
  ) {
    throw new HttpError(400, 'Historical request counts must be non-negative integers.');
  }
  if (!Number.isInteger(input.forecastPeriods) || input.forecastPeriods < 1 || input.forecastPeriods > maximumForecastPeriods) {
    throw new HttpError(400, `forecastPeriods must be between 1 and ${maximumForecastPeriods}.`);
  }

  const selectedHistory = await getDemandHistory(input.mode);
  if (!selectedHistory.available || !selectedHistory.historicalRequestCounts) {
    throw new HttpError(409, selectedHistory.message);
  }
  if (
    selectedHistory.forecastStartTimestamp !== input.forecastStartTimestamp
    || selectedHistory.historicalRequestCounts.some((count, index) => count !== input.historicalRequestCounts[index])
  ) {
    throw new HttpError(409, 'Selected history changed. Refresh the history before requesting a forecast.');
  }

  let response: Response;
  try {
    const baseUrl = getDemandForecastingServiceUrl();
    response = await fetch(`${baseUrl}/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        forecast_start_timestamp: input.forecastStartTimestamp,
        forecast_periods: input.forecastPeriods,
        historical_request_counts: input.historicalRequestCounts,
      }),
      signal: AbortSignal.timeout(forecastTimeoutMs),
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Demand forecasting service is unavailable or timed out.');
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new HttpError(502, 'Demand forecasting service returned an invalid response.');
  }

  if (!response.ok) {
    if (response.status === 503) {
      throw new HttpError(503, 'Demand forecasting model is currently unavailable.');
    }
    if (response.status === 422) {
      throw new HttpError(502, 'Demand forecasting service rejected the validated request.');
    }
    throw new HttpError(502, 'Demand forecasting service could not process the request.');
  }

  const result = parsePythonForecast(responseBody, input);
  if (!result) {
    throw new HttpError(502, 'Demand forecasting service returned an invalid forecast or model metadata.');
  }
  return {
    ...result,
    mode: input.mode,
    historySource: selectedHistory.source,
    historyProvenance: selectedHistory.provenance,
  };
}

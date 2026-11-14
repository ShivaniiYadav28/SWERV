import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { User } from '../src/models/User.js';
import { createAccessToken } from '../src/utils/jwt.js';
import {
  forecastAttemptTimeoutMs,
  forecastTimeoutMs,
  requestDemandForecast,
} from '../src/services/demandForecastingService.js';

let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';

const validForecastRequest = {
  forecastStartTimestamp: '',
  forecastPeriods: 3,
};
const serviceApiKey = 'test-demand-forecasting-service-key-32-chars';

function cookie(userId: string): string {
  return `swerv_access=${createAccessToken(userId)}`;
}

function makePythonResponse(
  input: { forecast_start_timestamp: string; forecast_periods: number },
  overrides: Record<string, unknown> = {},
) {
  const startTimestamp = Date.parse(input.forecast_start_timestamp);
  return {
    forecast_start_timestamp: new Date(startTimestamp).toISOString(),
    forecast_periods: input.forecast_periods,
    predictions: Array.from({ length: input.forecast_periods }, (_, index) => ({
      timestamp: new Date(startTimestamp + index * 60 * 60 * 1_000).toISOString(),
      request_count: index,
    })),
    model_version: 'gradient_boosting-synthetic-api-test',
    history_source: 'synthetic_hourly_demand.csv',
    history_provenance: 'Bundled synthetic CSV; not actual SWERV demand.',
    training_source: 'synthetic',
    synthetic_provenance: 'Synthetic test model; real-world accuracy is not validated.',
    ...overrides,
  };
}

function validPythonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => makePythonResponse({
      forecast_start_timestamp: validForecastRequest.forecastStartTimestamp,
      forecast_periods: validForecastRequest.forecastPeriods,
    }),
  } as Response;
}

function mockPythonService(
  responseBody: unknown = makePythonResponse({
    forecast_start_timestamp: validForecastRequest.forecastStartTimestamp,
    forecast_periods: validForecastRequest.forecastPeriods,
  }),
  status = 200,
) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody,
  }) as Response));
}

function forecast(cookieValue = adminCookie) {
  return request(app)
    .post('/api/demand-forecasting/forecast')
    .set('Cookie', cookieValue)
    .send(validForecastRequest);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-demand-tests-secret-0123456789-abcdefghij';
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.DEMAND_FORECASTING_SERVICE_URL = 'http://127.0.0.1:8004';
  process.env.DEMAND_FORECASTING_API_KEY = serviceApiKey;
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  validForecastRequest.forecastStartTimestamp = new Date(
    (Math.floor(Date.now() / (60 * 60 * 1_000)) + 1) * 60 * 60 * 1_000,
  ).toISOString();
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  mockPythonService();
  await Promise.all([User.deleteMany({}), DispatchRequest.deleteMany({})]);
  const [admin, operator] = await User.create([
    { name: 'Forecast Admin', email: 'forecast-admin@example.com', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Forecast Operator', email: 'forecast-operator@example.com', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  adminCookie = cookie(admin.id);
  operatorCookie = cookie(operator.id);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('demand forecasting endpoint', () => {
  it('does not expose a backend history endpoint or read operational records', async () => {
    const findOneSpy = vi.spyOn(DispatchRequest, 'findOne');
    const aggregateSpy = vi.spyOn(DispatchRequest, 'aggregate');
    const beforeCount = await DispatchRequest.countDocuments();
    await request(app).get('/api/demand-forecasting/history').expect(404);
    expect(findOneSpy).not.toHaveBeenCalled();
    expect(aggregateSpy).not.toHaveBeenCalled();
    expect(await DispatchRequest.countDocuments()).toBe(beforeCount);
  });

  it('sends only forecast start and horizon and validates synthetic ML metadata', async () => {
    const response = await forecast().expect(200);
    const upstreamCall = vi.mocked(fetch).mock.calls[0];
    const upstreamInput = JSON.parse(String(upstreamCall?.[1]?.body)) as Record<string, unknown>;

    expect(upstreamCall?.[0]).toBe('http://127.0.0.1:8004/predict');
    expect(upstreamInput).toEqual({
      forecast_start_timestamp: validForecastRequest.forecastStartTimestamp,
      forecast_periods: validForecastRequest.forecastPeriods,
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${serviceApiKey}`,
    });
    expect(response.body.data.forecast).toMatchObject({
      mode: 'synthetic_demo',
      historySource: 'synthetic_hourly_demand.csv',
      historyProvenance: 'Bundled synthetic CSV; not actual SWERV demand.',
      forecastStartTimestamp: new Date(validForecastRequest.forecastStartTimestamp).toISOString(),
      forecastPeriods: 3,
      predictions: [
        { timestamp: new Date(Date.parse(validForecastRequest.forecastStartTimestamp)).toISOString(), requestCount: 0 },
        { timestamp: new Date(Date.parse(validForecastRequest.forecastStartTimestamp) + 60 * 60 * 1_000).toISOString(), requestCount: 1 },
        { timestamp: new Date(Date.parse(validForecastRequest.forecastStartTimestamp) + 2 * 60 * 60 * 1_000).toISOString(), requestCount: 2 },
      ],
      modelVersion: 'gradient_boosting-synthetic-api-test',
      trainingSource: 'synthetic',
      syntheticProvenance: 'Synthetic test model; real-world accuracy is not validated.',
    });
    expect(await DispatchRequest.countDocuments()).toBe(0);
  });

  it.each([24, 72, 168])('supports an explicit synthetic demo forecast horizon of %i hours', async (periods) => {
    const input = { ...validForecastRequest, forecastPeriods: periods };
    mockPythonService(makePythonResponse({
      forecast_start_timestamp: input.forecastStartTimestamp,
      forecast_periods: periods,
    }));
    const response = await request(app)
      .post('/api/demand-forecasting/forecast')
      .set('Cookie', adminCookie)
      .send(input)
      .expect(200);
    expect(response.body.data.forecast.forecastPeriods).toBe(periods);
    expect(response.body.data.forecast.predictions).toHaveLength(periods);
  });

  it('rejects real mode and client-supplied operational history', async () => {
    const beforeCount = await DispatchRequest.countDocuments();
    await request(app)
      .post('/api/demand-forecasting/forecast')
      .set('Cookie', adminCookie)
      .send({ ...validForecastRequest, mode: 'real' })
      .expect(400);
    await request(app)
      .post('/api/demand-forecasting/forecast')
      .set('Cookie', adminCookie)
      .send({ ...validForecastRequest, historical_request_counts: Array(168).fill(1) })
      .expect(400);
    const afterCount = await DispatchRequest.countDocuments();
    expect(fetch).not.toHaveBeenCalled();
    expect(afterCount).toBe(beforeCount);
  });

  it('requires authentication and restricts forecasts to Admin users', async () => {
    await request(app).post('/api/demand-forecasting/forecast').send(validForecastRequest).expect(401);
    await forecast(operatorCookie).expect(403);
    await forecast(adminCookie).expect(200);
  });

  it('rejects non-UTC or unaligned timestamps and invalid horizons', async () => {
    const invalidRequests = [
      { ...validForecastRequest, forecastStartTimestamp: '2026-11-08T00:00:00' },
      { ...validForecastRequest, forecastStartTimestamp: '2026-11-08T00:30:00Z' },
      { ...validForecastRequest, forecastStartTimestamp: '2026-11-08T03:00:00+03:00' },
      { ...validForecastRequest, forecastPeriods: 0 },
      { ...validForecastRequest, forecastPeriods: 169 },
    ];

    for (const body of invalidRequests) {
      await request(app)
        .post('/api/demand-forecasting/forecast')
        .set('Cookie', adminCookie)
        .send(body)
        .expect(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps an offline or timed-out Python service to a safe 503 response', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('private connection detail'); });
    vi.stubGlobal('fetch', fetchMock);

    const response = await forecast().expect(503);
    expect(response.body.message).toContain('unavailable or timed out');
    expect(response.body.message).not.toContain('private connection detail');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transient connection failure once and returns the second successful forecast', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce(validPythonResponse());
    vi.stubGlobal('fetch', fetchMock);

    await forecast().expect(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504])('retries upstream HTTP %i once', async (status) => {
    const transientResponse = {
      ok: false,
      status,
      json: async () => ({ detail: 'private upstream detail' }),
    } as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(transientResponse)
      .mockResolvedValueOnce(validPythonResponse());
    vi.stubGlobal('fetch', fetchMock);

    await forecast().expect(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports an unavailable upstream model without returning its internal detail', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ detail: 'private model path' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const response = await forecast().expect(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.body.message).toContain('currently unavailable');
    expect(response.body.message).not.toContain('private model path');
  });

  it('reports upstream validation errors as an integration error', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ detail: 'internal request details' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const response = await forecast().expect(502);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.body.message).toContain('rejected the validated request');
    expect(response.body.message).not.toContain('internal request details');
  });

  it.each([401, 403])('does not retry ML authentication failures with HTTP %i', async (status) => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({ detail: 'unauthorized' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await forecast().expect(503);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns a safe configuration error without calling upstream when the service key is missing', async () => {
    const originalKey = process.env.DEMAND_FORECASTING_API_KEY;
    delete process.env.DEMAND_FORECASTING_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await forecast().expect(503);
      expect(response.body.message).not.toContain(serviceApiKey);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalKey === undefined) delete process.env.DEMAND_FORECASTING_API_KEY;
      else process.env.DEMAND_FORECASTING_API_KEY = originalKey;
    }
  });

  it('uses a bounded overall deadline and preserves authenticated backend access', async () => {
    expect(forecastTimeoutMs).toBe(70_000);
    expect(forecastAttemptTimeoutMs).toBe(50_000);
    await request(app).post('/api/demand-forecasting/forecast').send(validForecastRequest).expect(401);
    await forecast(operatorCookie).expect(403);
  });

  it('uses only the remaining overall deadline for the second attempt', async () => {
    vi.useFakeTimers();
    const requestStartedAt = Date.now();
    const abortTimes: number[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        abortTimes.push(Date.now());
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const forecastPromise = requestDemandForecast(validForecastRequest);
      const forecastRejection = expect(forecastPromise).rejects.toMatchObject({ status: 503 });
      await vi.advanceTimersByTimeAsync(forecastTimeoutMs);
      await forecastRejection;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(abortTimes).toEqual([
        requestStartedAt + forecastAttemptTimeoutMs,
        requestStartedAt + forecastTimeoutMs,
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid prediction rows or non-synthetic model metadata', async () => {
    const invalidMetadata = makePythonResponse({
      forecast_start_timestamp: validForecastRequest.forecastStartTimestamp,
      forecast_periods: validForecastRequest.forecastPeriods,
    }, { training_source: 'real' });
    const invalidMetadataFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => invalidMetadata,
    }) as Response);
    vi.stubGlobal('fetch', invalidMetadataFetch);
    await forecast().expect(502);
    expect(invalidMetadataFetch).toHaveBeenCalledOnce();

    const invalidPredictionFetch = vi.fn(async () => {
      const invalidPrediction = makePythonResponse({
        forecast_start_timestamp: validForecastRequest.forecastStartTimestamp,
        forecast_periods: validForecastRequest.forecastPeriods,
      });
      (invalidPrediction.predictions[0] as { request_count: number }).request_count = -1;
      return {
        ok: true,
        status: 200,
        json: async () => invalidPrediction,
      } as Response;
    });
    vi.stubGlobal('fetch', invalidPredictionFetch);
    await forecast().expect(502);
    expect(invalidPredictionFetch).toHaveBeenCalledOnce();
  });
});

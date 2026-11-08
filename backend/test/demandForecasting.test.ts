import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { User } from '../src/models/User.js';
import { createAccessToken } from '../src/utils/jwt.js';
import { getDemandHistory, getRecentDemandHistory } from '../src/services/demandForecastingService.js';

let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';

const validForecastRequest = {
  mode: 'synthetic_demo' as const,
  forecastStartTimestamp: '',
  forecastPeriods: 3,
  historicalRequestCounts: [] as number[],
};

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
    training_source: 'synthetic',
    synthetic_provenance: 'Synthetic test model; real-world accuracy is not validated.',
    ...overrides,
  };
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

async function addDispatchRequestAt(createdAt: Date) {
  return DispatchRequest.create({
    customer: { name: 'History Customer', email: 'history@example.com', phone: '+1 555 111 2222' },
    pickup: {
      address: '10 North Street', city: 'Portland', region: 'Oregon',
      postalCode: '97201', country: 'United States',
    },
    delivery: {
      address: '25 River Road', city: 'Portland', region: 'Oregon',
      postalCode: '97202', country: 'United States',
    },
    package: { description: 'Small boxed item', category: 'parcel', weightKg: 2, quantity: 1 },
    priority: 'standard',
    createdAt,
  });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-demand-tests-secret-0123456789-abcdefghij';
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.DEMAND_FORECASTING_SERVICE_URL = 'http://127.0.0.1:8004';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  const demoHistory = await getDemandHistory('synthetic_demo');
  if (!demoHistory.available || !demoHistory.historicalRequestCounts) {
    throw new Error('Synthetic demo dataset must provide 168 valid hourly counts for tests.');
  }
  validForecastRequest.forecastStartTimestamp = demoHistory.forecastStartTimestamp;
  validForecastRequest.historicalRequestCounts = demoHistory.historicalRequestCounts;
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
  it('returns a clear unavailable history response when the recorded date range is too short', async () => {
    const now = new Date('2026-11-07T17:45:00.000Z');
    await addDispatchRequestAt(new Date('2026-11-03T10:34:00.000Z'));

    const history = await getRecentDemandHistory(now);

    expect(history.available).toBe(false);
    expect(history.requiredHistoryHours).toBe(168);
    expect(history.availableHistoryHours).toBeLessThan(168);
    expect(history.historicalRequestCounts).toBeNull();
    expect(history.source).toBe('DispatchRequest.createdAt');
  });

  it('returns 168 UTC hourly counts with zero-filled hours only when coverage is complete', async () => {
    const forecastStart = new Date('2026-11-07T17:00:00.000Z');
    const historyStart = new Date(forecastStart.getTime() - 168 * 60 * 60 * 1_000);
    await addDispatchRequestAt(new Date(historyStart.getTime() - 60_000));
    await addDispatchRequestAt(new Date(historyStart.getTime() + 60_000));
    await addDispatchRequestAt(new Date(historyStart.getTime() + 60 * 60 * 1_000 + 60_000));

    const history = await getRecentDemandHistory(new Date('2026-11-07T17:45:00.000Z'));

    expect(history.available).toBe(true);
    expect(history.forecastStartTimestamp).toBe(forecastStart.toISOString());
    expect(history.historyStartTimestamp).toBe(historyStart.toISOString());
    expect(history.historicalRequestCounts).toHaveLength(168);
    expect(history.historicalRequestCounts?.slice(0, 3)).toEqual([1, 1, 0]);
    expect(history.historicalRequestCounts?.reduce((sum, value) => sum + value, 0)).toBe(2);
  });

  it('protects the read-only hourly history endpoint for Admin users', async () => {
    await request(app).get('/api/demand-forecasting/history?mode=real').expect(401);
    await request(app)
      .get('/api/demand-forecasting/history?mode=real')
      .set('Cookie', operatorCookie)
      .expect(403);
    const response = await request(app)
      .get('/api/demand-forecasting/history?mode=real')
      .set('Cookie', adminCookie)
      .expect(200);

    expect(response.body.data.history).toMatchObject({
      available: false,
      mode: 'real',
      requiredHistoryHours: 168,
      historicalRequestCounts: null,
      source: 'DispatchRequest.createdAt',
    });
    expect(response.body.data.history).not.toHaveProperty('customer');
  });

  it('provides exactly 168 continuous synthetic demo hours with clear provenance', async () => {
    const beforeCount = await DispatchRequest.countDocuments();
    const history = await getDemandHistory('synthetic_demo');
    const afterCount = await DispatchRequest.countDocuments();

    expect(history).toMatchObject({
      available: true,
      mode: 'synthetic_demo',
      requiredHistoryHours: 168,
      availableHistoryHours: 168,
      source: 'synthetic_hourly_demand.csv',
    });
    expect(history.provenance).toContain('does not represent actual SWERV demand');
    expect(history.historicalRequestCounts).toHaveLength(168);
    expect(history.historicalRequestCounts?.every((count) => Number.isSafeInteger(count) && count >= 0)).toBe(true);
    expect(Date.parse(history.forecastStartTimestamp) - Date.parse(history.historyStartTimestamp)).toBe(168 * 60 * 60 * 1000);
    expect(afterCount).toBe(beforeCount);
  });

  it('labels the synthetic demo history in the Admin API response', async () => {
    const response = await request(app)
      .get('/api/demand-forecasting/history?mode=synthetic_demo')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(response.body.data.history).toMatchObject({
      available: true,
      mode: 'synthetic_demo',
      source: 'synthetic_hourly_demand.csv',
    });
    expect(response.body.data.history.provenance).toContain('does not represent actual SWERV demand');
  });

  it('forwards validated UTC history and returns forecast model metadata', async () => {
    const response = await forecast().expect(200);
    const upstreamCall = vi.mocked(fetch).mock.calls[0];
    const upstreamInput = JSON.parse(String(upstreamCall?.[1]?.body)) as Record<string, unknown>;

    expect(upstreamCall?.[0]).toBe('http://127.0.0.1:8004/predict');
    expect(upstreamInput).toEqual({
      forecast_start_timestamp: validForecastRequest.forecastStartTimestamp,
      forecast_periods: validForecastRequest.forecastPeriods,
      historical_request_counts: validForecastRequest.historicalRequestCounts,
    });
    expect(response.body.data.forecast).toMatchObject({
      mode: 'synthetic_demo',
      historySource: 'synthetic_hourly_demand.csv',
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

  it('keeps real mode blocked and does not silently fall back to synthetic history', async () => {
    const beforeCount = await DispatchRequest.countDocuments();
    const response = await request(app)
      .post('/api/demand-forecasting/forecast')
      .set('Cookie', adminCookie)
      .send({ ...validForecastRequest, mode: 'real' })
      .expect(409);
    const afterCount = await DispatchRequest.countDocuments();
    expect(response.body.message).toContain('No recorded dispatch history');
    expect(fetch).not.toHaveBeenCalled();
    expect(afterCount).toBe(beforeCount);
  });

  it('requires authentication and restricts forecasts to Admin users', async () => {
    await request(app).post('/api/demand-forecasting/forecast').send(validForecastRequest).expect(401);
    await forecast(operatorCookie).expect(403);
    await forecast(adminCookie).expect(200);
  });

  it('rejects non-UTC or unaligned timestamps, invalid horizons, and invalid history', async () => {
    const invalidRequests = [
      { ...validForecastRequest, forecastStartTimestamp: '2026-11-08T00:00:00' },
      { ...validForecastRequest, forecastStartTimestamp: '2026-11-08T00:30:00Z' },
      { ...validForecastRequest, forecastStartTimestamp: '2026-11-08T03:00:00+03:00' },
      { ...validForecastRequest, forecastPeriods: 0 },
      { ...validForecastRequest, forecastPeriods: 169 },
      { ...validForecastRequest, historicalRequestCounts: Array(167).fill(1) },
      { ...validForecastRequest, historicalRequestCounts: [-1, ...Array(167).fill(1)] },
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
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private connection detail'); }));

    const response = await forecast().expect(503);
    expect(response.body.message).toContain('unavailable or timed out');
    expect(response.body.message).not.toContain('private connection detail');
  });

  it('reports an unavailable upstream model without returning its internal detail', async () => {
    mockPythonService({ detail: 'private model path' }, 503);

    const response = await forecast().expect(503);
    expect(response.body.message).toContain('model is currently unavailable');
    expect(response.body.message).not.toContain('private model path');
  });

  it('reports upstream validation errors as an integration error', async () => {
    mockPythonService({ detail: 'internal request details' }, 422);

    const response = await forecast().expect(502);
    expect(response.body.message).toContain('rejected the validated request');
    expect(response.body.message).not.toContain('internal request details');
  });

  it('rejects invalid prediction rows or non-synthetic model metadata', async () => {
    const invalidMetadata = makePythonResponse({
      forecast_start_timestamp: validForecastRequest.forecastStartTimestamp,
      forecast_periods: validForecastRequest.forecastPeriods,
    }, { training_source: 'real' });
    mockPythonService(invalidMetadata);
    await forecast().expect(502);

    const invalidPrediction = makePythonResponse({
      forecast_start_timestamp: validForecastRequest.forecastStartTimestamp,
      forecast_periods: validForecastRequest.forecastPeriods,
    });
    (invalidPrediction.predictions[0] as { request_count: number }).request_count = -1;
    mockPythonService(invalidPrediction);
    await forecast().expect(502);
  });
});

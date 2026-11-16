import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { AnomalyAlert, AnomalyDemoAlert } from '../src/models/AnomalyAlert.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { Notification } from '../src/models/Notification.js';
import { User } from '../src/models/User.js';
import { createAccessToken } from '../src/utils/jwt.js';

let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';

const serviceApiKey = 'test-anomaly-service-secret-at-least-32-characters';
const generatedAt = '2026-11-16T12:00:00.000Z';
const liveServiceUrl = process.env.SWERV_ANOMALY_E2E_URL;
const liveServiceApiKey = process.env.SWERV_ANOMALY_E2E_API_KEY;

function makeCookie(userId: string): string {
  return `swerv_access=${createAccessToken(userId)}`;
}

function demoResponse(scenarioCategory = 'gps_coordinate_jump', emptyResults = false) {
  const results = Array.from({ length: emptyResults ? 0 : 30 }, (_, scenarioIndex) => ({
    scenario_index: scenarioIndex,
    scenario_id: `demo-backend-${String(scenarioIndex).padStart(4, '0')}`,
    anomaly_score: 0.92,
    is_anomaly: true,
    decision_threshold: 0.1,
    severity: 'critical',
    scenario_category: scenarioCategory,
    scenario_category_source: 'generated_demo_label',
    scenario_category_is_model_prediction: false,
    explanation: 'Isolation Forest score exceeds threshold; generated category is context only.',
    timestamp: generatedAt,
  }));
  return {
    detection_mode: 'synthetic_demo',
    results,
    scenario_count: 30,
    candidate_count: results.length,
    model_name: 'isolation_forest',
    model_version: 'isolation_forest-synthetic-backend-test',
    training_data_source: 'synthetic',
    demonstration_provenance: 'Generated demo scenarios; not operational incidents.',
    generated_at: generatedAt,
  };
}

function stubPythonService(status = 200, scenarioCategory = 'gps_coordinate_jump', emptyResults = false) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => status >= 200 && status < 300
      ? demoResponse(scenarioCategory, emptyResults)
      : { detail: 'Private upstream error detail.' },
  }) as Response));
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-anomaly-tests-secret-0123456789-abcdefghij';
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.ANOMALY_DETECTION_SERVICE_URL = liveServiceUrl ?? 'http://127.0.0.1:8005';
  process.env.ANOMALY_DETECTION_API_KEY = liveServiceApiKey ?? serviceApiKey;
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.ANOMALY_DETECTION_API_KEY = liveServiceApiKey ?? serviceApiKey;
  stubPythonService();
  await Promise.all([
    User.deleteMany({}),
    AnomalyAlert.deleteMany({}),
    AnomalyDemoAlert.deleteMany({}),
    Notification.deleteMany({}),
    DispatchRequest.deleteMany({}),
    DispatchRequestActivity.deleteMany({}),
  ]);
  const [admin, operator] = await User.create([
    { name: 'Anomaly Admin', email: 'anomaly-admin@example.com', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Anomaly Operator', email: 'anomaly-operator@example.com', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  adminCookie = makeCookie(admin.id);
  operatorCookie = makeCookie(operator.id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('Admin anomaly APIs', () => {
  it.skipIf(!liveServiceUrl || !liveServiceApiKey)('runs an opt-in live backend-to-FastAPI integration', async () => {
    vi.unstubAllGlobals();
    const nativeFetch = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      upstreamCalls += 1;
      return nativeFetch(...args);
    }) as typeof fetch;

    const demo = await request(app)
      .post('/api/anomaly-detection/detect')
      .set('Cookie', adminCookie)
      .send({ mode: 'synthetic_demo' })
      .expect(200);
    expect(demo.body.data.detectionSource).toBe('machine_learning_demo');
    expect(demo.body.data.scenarioCount).toBe(30);
    expect(upstreamCalls).toBe(1);
    const demoCount = await AnomalyDemoAlert.countDocuments();
    expect(demoCount).toBe(demo.body.data.savedAlerts);
    expect(await AnomalyAlert.countDocuments()).toBe(0);

    const reviewedAlert = await AnomalyDemoAlert.findOne();
    expect(reviewedAlert).toBeTruthy();
    await request(app)
      .patch(`/api/anomaly-detection/alerts/${reviewedAlert?.id}/review?mode=synthetic_demo`)
      .set('Cookie', adminCookie)
      .send({ reviewStatus: 'under_review' })
      .expect(200);

    const dispatch = await DispatchRequest.create({
      pickup: { address: 'A', city: 'A', region: 'A', postalCode: '1', country: 'A' },
      delivery: { address: 'B', city: 'B', region: 'B', postalCode: '2', country: 'B' },
      package: { description: 'Test parcel', category: 'parcel', weightKg: 1, quantity: 1 },
      priority: 'standard',
      status: 'delivered',
    });
    const admin = await User.findOne({ role: 'admin' });
    await DispatchRequestActivity.create({
      dispatchRequestId: dispatch._id,
      eventType: 'status_changed',
      description: 'Integration rule fixture',
      performedBy: admin?._id,
      previousValue: { status: 'pending' },
      newValue: { status: 'delivered' },
    });
    const callsBeforeRealMode = upstreamCalls;
    const real = await request(app)
      .post('/api/anomaly-detection/detect')
      .set('Cookie', adminCookie)
      .send({ mode: 'real' })
      .expect(200);
    expect(real.body.data.detectionSource).toBe('backend_rule_based');
    expect(real.body.data.candidateCount).toBe(1);
    expect(upstreamCalls).toBe(callsBeforeRealMode);
    expect(await AnomalyAlert.countDocuments({ anomalyType: 'invalid_status_transition' })).toBe(1);
    expect(await AnomalyDemoAlert.countDocuments()).toBe(demoCount);
  });

  it('calls only /analyze-demo with Bearer auth and no request body', async () => {
    const dispatchFind = vi.spyOn(DispatchRequest, 'find');
    const activityFind = vi.spyOn(DispatchRequestActivity, 'find');

    await request(app)
      .post('/api/anomaly-detection/detect')
      .set('Cookie', adminCookie)
      .send({ mode: 'synthetic_demo' })
      .expect(200);

    const [url, options] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8005/analyze-demo');
    expect((options?.headers as Record<string, string>)?.authorization).toBe(`Bearer ${serviceApiKey}`);
    expect(options?.body).toBeUndefined();
    expect(dispatchFind).not.toHaveBeenCalled();
    expect(activityFind).not.toHaveBeenCalled();
  });

  it('fails safely without a configured ML API key and does not call upstream', async () => {
    delete process.env.ANOMALY_DETECTION_API_KEY;
    const response = await request(app)
      .post('/api/anomaly-detection/detect')
      .set('Cookie', adminCookie)
      .send({ mode: 'synthetic_demo' })
      .expect(503);

    expect(response.body.message).toContain('not configured');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires an authenticated Admin for detection and alert history', async () => {
    await request(app).post('/api/anomaly-detection/detect').send({ mode: 'synthetic_demo' }).expect(401);
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', operatorCookie).send({ mode: 'synthetic_demo' }).expect(403);
    await request(app).get('/api/anomaly-detection/alerts').set('Cookie', operatorCookie).expect(403);
  });

  it('stores demo candidates separately and deduplicates concurrent analyses', async () => {
    const [first, second] = await Promise.all([
      request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }),
      request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data.mode).toBe('synthetic_demo');
    expect(first.body.data.detectionSource).toBe('machine_learning_demo');
    expect(first.body.data.modelVersion).toBe('isolation_forest-synthetic-backend-test');
    expect(first.body.data.scenarioCount).toBe(30);

    const demoCount = await AnomalyDemoAlert.countDocuments();
    expect(demoCount).toBe(30);
    expect(await AnomalyAlert.countDocuments()).toBe(0);
    expect(await Notification.countDocuments({ eventType: 'anomaly_detected' })).toBe(0);
    const modelAlert = await AnomalyDemoAlert.findOne().lean();
    expect(modelAlert?.anomalyType).toBe('unsupervised_outlier');
    expect(modelAlert?.detectionMethod).toBe('machine_learning');
    expect(modelAlert?.modelProvenance).toContain('Generated demo scenarios');
    expect(modelAlert?.evidence).toMatchObject({
      scenarioCategoryIsModelPrediction: false,
      scenarioCategorySource: 'generated_demo_label',
    });
    expect(first.body.data.savedAlerts + second.body.data.savedAlerts).toBe(demoCount);
    expect(first.body.data.duplicateAlertsSkipped + second.body.data.duplicateAlertsSkipped).toBe(30);
    expect(await AnomalyDemoAlert.countDocuments()).toBe(demoCount);
  });

  it('keeps generated category labels as evidence, not as predicted anomaly types', async () => {
    stubPythonService(200, 'route_deviation');
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(200);

    const alert = await AnomalyDemoAlert.findOne().lean();
    expect(alert?.anomalyType).toBe('unsupervised_outlier');
    expect(alert?.evidence).toMatchObject({
      scenarioCategory: 'route_deviation',
      scenarioCategoryIsModelPrediction: false,
    });
    expect(await AnomalyAlert.countDocuments()).toBe(0);
  });

  it('rejects invalid upstream categories and empty result sets without saving alerts', async () => {
    stubPythonService(200, 'unrecognized_category');
    const unknownCategory = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(502);
    expect(unknownCategory.body.message).toContain('invalid results');
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);

    stubPythonService(200, 'gps_coordinate_jump', true);
    const emptyResult = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(502);
    expect(emptyResult.body.message).toContain('invalid results');
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
  });

  it('rejects invalid mode and runs real mode locally without the ML API key', async () => {
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'demo' }).expect(400);
    delete process.env.ANOMALY_DETECTION_API_KEY;
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'real' }).expect(200);

    expect(response.body.data.detectionSource).toBe('backend_rule_based');
    expect(response.body.data.candidateCount).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
    expect(await AnomalyAlert.countDocuments()).toBe(0);
  });

  it('saves local rule findings only to real alerts and never sends operational records upstream', async () => {
    const dispatch = await DispatchRequest.create({
      customer: { name: 'Private Fixture', email: 'private-fixture@example.test', phone: '+1 555 222 3333' },
      pickup: { address: 'Private pickup address', city: 'Example', region: 'Region', postalCode: '00000', country: 'Example' },
      delivery: { address: 'Private delivery address', city: 'Example', region: 'Region', postalCode: '00001', country: 'Example' },
      package: { description: 'Private package description', category: 'parcel', weightKg: 1, quantity: 1 },
      priority: 'standard', status: 'delivered',
    });
    const admin = await User.findOne({ role: 'admin' });
    await DispatchRequestActivity.create({
      dispatchRequestId: dispatch._id,
      eventType: 'status_changed',
      description: 'Fixture invalid transition',
      performedBy: admin?._id,
      previousValue: { status: 'pending' },
      newValue: { status: 'delivered' },
    });
    delete process.env.ANOMALY_DETECTION_API_KEY;
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'real' }).expect(200);

    expect(response.body.data.detectionSource).toBe('backend_rule_based');
    expect(response.body.data.modelName).toBe('Backend rule checks');
    expect(response.body.data.candidateCount).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(await AnomalyAlert.countDocuments({ dataSource: 'real' })).toBe(1);
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
    const ruleAlert = await AnomalyAlert.findOne().lean();
    expect(ruleAlert?.anomalyType).toBe('invalid_status_transition');
    expect(ruleAlert?.detectionMethod).toBe('documented_status_transition_table');
    expect(ruleAlert?.modelName).toBeNull();
    expect(await Notification.countDocuments({ recipientType: 'user', recipientId: admin?._id, eventType: 'anomaly_detected' })).toBeGreaterThan(0);
    expect(await Notification.countDocuments({ recipientType: 'user', recipientId: (await User.findOne({ role: 'operator' }))?._id, eventType: 'anomaly_detected' })).toBe(0);

    const notificationCount = await Notification.countDocuments({ eventType: 'anomaly_detected' });
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'real' }).expect(200);
    expect(await Notification.countDocuments({ eventType: 'anomaly_detected' })).toBe(notificationCount);
  });

  it('validates alert filters, IDs, and review statuses', async () => {
    await request(app).get('/api/anomaly-detection/alerts?mode=real&severity=extreme').set('Cookie', adminCookie).expect(400);
    await request(app).get('/api/anomaly-detection/alerts?mode=real&anomalyType=unknown').set('Cookie', adminCookie).expect(400);
    await request(app).get('/api/anomaly-detection/alerts/not-an-id?mode=real').set('Cookie', adminCookie).expect(400);
    await request(app).patch('/api/anomaly-detection/alerts/507f1f77bcf86cd799439011/review?mode=real').set('Cookie', adminCookie).send({ reviewStatus: 'new' }).expect(400);
    await request(app).patch('/api/anomaly-detection/alerts/507f1f77bcf86cd799439011/review?mode=real').set('Cookie', adminCookie).send({ reviewNotes: '   ' }).expect(400);
  });

  it('preserves separate summaries, filters, pagination, details, and review actions', async () => {
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(200);
    const summary = await request(app).get('/api/anomaly-detection/summary?mode=synthetic_demo').set('Cookie', adminCookie).expect(200);
    expect(summary.body.data.total).toBe(30);
    expect((await request(app).get('/api/anomaly-detection/summary?mode=real').set('Cookie', adminCookie)).body.data.total).toBe(0);
    const list = await request(app).get('/api/anomaly-detection/alerts?mode=synthetic_demo&severity=critical&page=1&limit=2').set('Cookie', adminCookie).expect(200);
    expect(list.body.data.alerts).toHaveLength(2);
    expect(list.body.data.pagination.total).toBe(30);
    const alertId = list.body.data.alerts[0]._id as string;
    const detail = await request(app).get(`/api/anomaly-detection/alerts/${alertId}?mode=synthetic_demo`).set('Cookie', adminCookie).expect(200);
    expect(detail.body.data.alert.detectionMode).toBe('synthetic_demo');
    const noteOnly = await request(app).patch(`/api/anomaly-detection/alerts/${alertId}/review?mode=synthetic_demo`).set('Cookie', adminCookie).send({ reviewNotes: 'Saved without changing status.' }).expect(200);
    expect(noteOnly.body.data.alert.reviewStatus).toBe('new');
    expect(noteOnly.body.data.alert.reviewNotes).toBe('Saved without changing status.');
    const refreshed = await request(app).get(`/api/anomaly-detection/alerts/${alertId}?mode=synthetic_demo`).set('Cookie', adminCookie).expect(200);
    expect(refreshed.body.data.alert.reviewNotes).toBe('Saved without changing status.');
    const review = await request(app).patch(`/api/anomaly-detection/alerts/${alertId}/review?mode=synthetic_demo`).set('Cookie', adminCookie).send({ reviewStatus: 'under_review', reviewNotes: 'Reviewing generated example.' }).expect(200);
    expect(review.body.data.alert.reviewStatus).toBe('under_review');
    expect(review.body.data.alert.reviewNotes).toBe('Reviewing generated example.');
  });

  it('maps ML service timeouts to a safe 503 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const error = new Error('private timeout detail');
      error.name = 'TimeoutError';
      throw error;
    }));
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(503);
    expect(response.body.message).toContain('unavailable or timed out');
    expect(response.body.message).not.toContain('private timeout detail');
  });

  it.each([[502, 503], [503, 503]])('handles upstream HTTP %i with backend status %i', async (upstreamStatus, backendStatus) => {
    stubPythonService(upstreamStatus);
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(backendStatus);
    expect(response.body.message).toMatch(/unavailable|could not process/i);
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
  });

  it('reports an unavailable Python model without creating alerts', async () => {
    stubPythonService(503);
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(503);
    expect(response.body.message).toContain('model is unavailable');
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
  });
});
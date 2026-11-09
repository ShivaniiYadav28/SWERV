import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { resolve } from 'node:path';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { AnomalyAlert, AnomalyDemoAlert } from '../src/models/AnomalyAlert.js';
import { Notification } from '../src/models/Notification.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { User } from '../src/models/User.js';
import { createAccessToken } from '../src/utils/jwt.js';
import { getSyntheticScenarios } from '../src/services/anomalyDetectionService.js';

let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';

function makeCookie(userId: string) { return `swerv_access=${createAccessToken(userId)}`; }

function stubPythonService(status = 200, predictedCategory = 'gps_implausible_jump', emptyResults = false) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    const input = JSON.parse(String(options?.body)) as { detection_mode: string; scenarios: unknown[] };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => status >= 200 && status < 300 ? {
        detection_mode: input.detection_mode,
        results: emptyResults ? [] : input.scenarios.map(() => ({
          scenario_index: 0, is_anomaly_candidate: true, anomaly_score: 0.92,
          predicted_category: predictedCategory, model_name: 'random_forest',
          model_version: 'random_forest-synthetic-backend-test', detection_method: 'machine_learning',
          detection_mode: input.detection_mode, model_type: 'supervised', input_data_source: input.detection_mode,
          training_data_source: 'synthetic', synthetic_provenance: 'Synthetic test model; not operational evidence.', data_quality_notes: [],
        })),
        rule_based_findings: [], rule_based_limitations: ['Test limitation.'],
        model_name: 'random_forest', model_version: 'random_forest-synthetic-backend-test',
        training_data_source: 'synthetic', synthetic_provenance: 'Synthetic test model; not operational evidence.',
      } : { detail: 'Unavailable' },
    } as Response;
  }));
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-anomaly-tests-secret-0123456789-abcdefghij';
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.ANOMALY_DETECTION_SERVICE_URL = 'http://127.0.0.1:8005';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  stubPythonService();
  await Promise.all([User.deleteMany({}), AnomalyAlert.deleteMany({}), AnomalyDemoAlert.deleteMany({}), Notification.deleteMany({})]);
  const [admin, operator] = await User.create([
    { name: 'Anomaly Admin', email: 'anomaly-admin@example.com', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Anomaly Operator', email: 'anomaly-operator@example.com', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  adminCookie = makeCookie(admin.id);
  operatorCookie = makeCookie(operator.id);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('Admin anomaly APIs', () => {
  it('loads only unique scenarios labelled as the synthetic demo split', async () => {
    const demo = await getSyntheticScenarios();

    expect(demo.rows.length).toBeGreaterThan(0);
    expect(demo.rows.every((row) => row.data_source === 'synthetic' && row.dataset_split === 'demo')).toBe(true);
    expect(demo.scenarios).toHaveLength(demo.rows.length > 30 ? 30 : demo.rows.length);
  });

  it('returns a clear unavailable error when the demo dataset is missing', async () => {
    await expect(getSyntheticScenarios(
      resolve('missing-anomaly-demo.csv'),
      resolve('missing-anomaly-demo-metadata.json'),
    )).rejects.toThrow('Synthetic demo dataset is unavailable.');
  });

  it('requires an authenticated Admin for detection and alert history', async () => {
    await request(app).post('/api/anomaly-detection/detect').send({ mode: 'synthetic_demo' }).expect(401);
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', operatorCookie).send({ mode: 'synthetic_demo' }).expect(403);
    await request(app).get('/api/anomaly-detection/alerts').set('Cookie', operatorCookie).expect(403);
  });

  it('stores demo findings separately and deduplicates concurrent synthetic runs', async () => {
    const [first, second] = await Promise.all([
      request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }),
      request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data.mode).toBe('synthetic_demo');
    expect(first.body.data.modelVersion).toContain('synthetic');
    const demoCount = await AnomalyDemoAlert.countDocuments();
    expect(demoCount).toBeGreaterThan(0);
    expect(await AnomalyAlert.countDocuments()).toBe(0);
    expect(await Notification.countDocuments({ eventType: 'anomaly_detected' })).toBe(0);
    const modelAlert = await AnomalyDemoAlert.findOne().lean();
    expect(modelAlert?.detectionMethod).toBe('machine_learning');
    expect(modelAlert?.modelProvenance).toContain('Synthetic test model');

    expect(first.body.data.savedAlerts + second.body.data.savedAlerts).toBe(demoCount);
    expect(first.body.data.savedAlerts + second.body.data.savedAlerts).toBeGreaterThan(0);
    expect(first.body.data.duplicateAlertsSkipped + second.body.data.duplicateAlertsSkipped).toBeGreaterThan(0);
    expect(await AnomalyDemoAlert.countDocuments()).toBe(demoCount);
  });

  it('accepts the trained model category gps_stale_update and saves it only as a demo alert', async () => {
    stubPythonService(200, 'gps_stale_update');
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(200);

    expect(response.body.data.mode).toBe('synthetic_demo');
    expect(await AnomalyDemoAlert.countDocuments({ anomalyType: 'gps_stale_update' })).toBeGreaterThan(0);
    expect(await AnomalyAlert.countDocuments()).toBe(0);
  });

  it('rejects a genuinely unknown model category without persisting it', async () => {
    stubPythonService(200, 'unknown_synthetic_category');
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(502);

    expect(response.body.message).toContain('invalid results');
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
  });

  it('handles an empty prediction list as an invalid upstream response without saving alerts', async () => {
    stubPythonService(200, 'gps_implausible_jump', true);
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(502);

    expect(response.body.message).toContain('invalid results');
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
  });

  it('rejects invalid mode and reports insufficient real data without switching to demo', async () => {
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'demo' }).expect(400);
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'real' }).expect(409);
    expect(response.body.message).toMatch(/dispatch/i);
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
    expect(await AnomalyAlert.countDocuments()).toBe(0);
    expect(await DispatchRequest.countDocuments()).toBe(0);
  });

  it('uses sanitized real records and keeps real alerts out of the demo collection', async () => {
    await DispatchRequest.create({
      customer: { name: 'Private Fixture', email: 'private-fixture@example.test', phone: '+1 555 222 3333' },
      pickup: { address: 'Private pickup address', city: 'Example', region: 'Region', postalCode: '00000', country: 'Example' },
      delivery: { address: 'Private delivery address', city: 'Example', region: 'Region', postalCode: '00001', country: 'Example' },
      package: { description: 'Private package description', category: 'parcel', weightKg: 1, quantity: 1 },
      priority: 'standard', status: 'pending',
    });
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'real' }).expect(200);

    const calls = vi.mocked(fetch).mock.calls;
    const payload = String(calls[0]?.[1]?.body);
    expect(payload).toContain('dispatch_activities');
    expect(payload).not.toContain('private-fixture@example.test');
    expect(payload).not.toContain('+1 555 222 3333');
    expect(payload).not.toContain('Private pickup address');
    expect(payload).not.toContain('Private package description');
    expect(await AnomalyAlert.countDocuments({ dataSource: 'real' })).toBeGreaterThan(0);
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
    expect(await Notification.countDocuments({ recipientType: 'user', recipientId: (await User.findOne({ role: 'admin' }))?._id, eventType: 'anomaly_detected' })).toBeGreaterThan(0);
    expect(await Notification.countDocuments({ recipientType: 'user', recipientId: (await User.findOne({ role: 'operator' }))?._id, eventType: 'anomaly_detected' })).toBe(0);

    const previousNotificationCount = await Notification.countDocuments({ eventType: 'anomaly_detected' });
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'real' }).expect(200);
    expect(await Notification.countDocuments({ eventType: 'anomaly_detected' })).toBe(previousNotificationCount);
  });

  it('validates alert filters, IDs, and review statuses', async () => {
    await request(app).get('/api/anomaly-detection/alerts?mode=real&severity=extreme').set('Cookie', adminCookie).expect(400);
    await request(app).get('/api/anomaly-detection/alerts?mode=real&anomalyType=unknown').set('Cookie', adminCookie).expect(400);
    await request(app).get('/api/anomaly-detection/alerts/not-an-id?mode=real').set('Cookie', adminCookie).expect(400);
    await request(app).patch('/api/anomaly-detection/alerts/507f1f77bcf86cd799439011/review?mode=real').set('Cookie', adminCookie).send({ reviewStatus: 'new' }).expect(400);
    await request(app).patch('/api/anomaly-detection/alerts/507f1f77bcf86cd799439011/review?mode=real').set('Cookie', adminCookie).send({ reviewNotes: '   ' }).expect(400);
  });

  it('supports isolated summaries, filters, pagination, details, and persistent review notes', async () => {
    await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(200);
    const summary = await request(app).get('/api/anomaly-detection/summary?mode=synthetic_demo').set('Cookie', adminCookie).expect(200);
    expect(summary.body.data.total).toBeGreaterThan(0);
    expect((await request(app).get('/api/anomaly-detection/summary?mode=real').set('Cookie', adminCookie)).body.data.total).toBe(0);
    const list = await request(app).get('/api/anomaly-detection/alerts?mode=synthetic_demo&severity=medium&page=1&limit=2').set('Cookie', adminCookie).expect(200);
    expect(list.body.data.alerts).toHaveLength(2);
    expect(list.body.data.pagination.total).toBeGreaterThanOrEqual(2);
    const alertId = list.body.data.alerts[0]._id as string;
    const detail = await request(app).get(`/api/anomaly-detection/alerts/${alertId}?mode=synthetic_demo`).set('Cookie', adminCookie).expect(200);
    expect(detail.body.data.alert.detectionMode).toBe('synthetic_demo');
    const noteOnly = await request(app).patch(`/api/anomaly-detection/alerts/${alertId}/review?mode=synthetic_demo`).set('Cookie', adminCookie).send({ reviewNotes: 'Saved without changing status.' }).expect(200);
    expect(noteOnly.body.data.alert.reviewStatus).toBe('new');
    expect(noteOnly.body.data.alert.reviewNotes).toBe('Saved without changing status.');
    const refreshed = await request(app).get(`/api/anomaly-detection/alerts/${alertId}?mode=synthetic_demo`).set('Cookie', adminCookie).expect(200);
    expect(refreshed.body.data.alert.reviewNotes).toBe('Saved without changing status.');
    const review = await request(app).patch(`/api/anomaly-detection/alerts/${alertId}/review?mode=synthetic_demo`).set('Cookie', adminCookie).send({ reviewStatus: 'under_review', reviewNotes: 'Reviewing synthetic example.' }).expect(200);
    expect(review.body.data.alert.reviewStatus).toBe('under_review');
    expect(review.body.data.alert.reviewNotes).toBe('Reviewing synthetic example.');
  });

  it('returns a safe response when the Python service is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private connection detail'); }));
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(503);
    expect(response.body.message).toContain('unavailable');
    expect(response.body.message).not.toContain('private connection detail');
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
  });

  it('reports a missing Python model without creating alerts', async () => {
    stubPythonService(503);
    const response = await request(app).post('/api/anomaly-detection/detect').set('Cookie', adminCookie).send({ mode: 'synthetic_demo' }).expect(503);
    expect(response.body.message).toContain('model is unavailable');
    expect(await AnomalyDemoAlert.countDocuments()).toBe(0);
  });
});

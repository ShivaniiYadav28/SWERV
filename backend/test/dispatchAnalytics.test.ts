import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { DispatchRequest, type DispatchRequestStatus, type DispatchPriority } from '../src/models/DispatchRequest.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { User } from '../src/models/User.js';
import { createAccessToken } from '../src/utils/jwt.js';

let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';
let adminId = '';
let operatorId = '';

const validRequest = {
  customer: { name: 'Alex Customer', email: 'alex@example.com', phone: '+1 555 234 5678' },
  pickup: { address: '10 North Street', city: 'Portland', region: 'Oregon', postalCode: '97201', country: 'United States' },
  delivery: { address: '25 River Road', city: 'Portland', region: 'Oregon', postalCode: '97202', country: 'United States' },
  package: { description: 'Small boxed item', category: 'parcel', weightKg: 2.5, quantity: 1 },
};

function cookie(userId: string) {
  return `swerv_access=${createAccessToken(userId)}`;
}

async function addRequest(status: DispatchRequestStatus, priority: DispatchPriority) {
  return DispatchRequest.create({ ...validRequest, status, priority });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-analytics-tests-secret-0123456789-abcdefghij';
  process.env.JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([DispatchRequest.init(), DispatchRequestActivity.init()]);
});

beforeEach(async () => {
  await Promise.all([
    DispatchRequest.deleteMany({}),
    DispatchRequestActivity.deleteMany({}),
    User.deleteMany({}),
  ]);
  const [admin, operator] = await User.create([
    { name: 'Admin User', email: 'admin@example.com', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Operator User', email: 'operator@example.com', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  adminId = admin.id;
  operatorId = operator.id;
  adminCookie = cookie(admin.id);
  operatorCookie = cookie(operator.id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('dispatch analytics', () => {
  it('returns global status and priority counts and calculates active deliveries', async () => {
    const requests: [DispatchRequestStatus, DispatchPriority][] = [
      ['pending', 'standard'],
      ['assigned', 'express'],
      ['picked_up', 'urgent'],
      ['in_transit', 'standard'],
      ['delivered', 'express'],
      ['failed', 'urgent'],
      ['cancelled', 'standard'],
    ];
    await Promise.all(requests.map(([status, priority]) => addRequest(status, priority)));

    const response = await request(app)
      .get('/api/dispatch-analytics?startDate=2025-04-01&endDate=2025-04-03')
      .set('Cookie', adminCookie)
      .expect(200);

    expect(response.body.data.counts).toEqual({
      total: 7,
      pending: 1,
      assigned: 1,
      picked_up: 1,
      in_transit: 1,
      activeDeliveries: 2,
      delivered: 1,
      failed: 1,
      cancelled: 1,
    });
    expect(response.body.data.priorityDistribution).toEqual({ standard: 3, express: 2, urgent: 2 });
  });

  it('counts delivered status transitions within inclusive UTC date boundaries and fills missing dates', async () => {
    const dispatchRequest = await addRequest('in_transit', 'standard');
    const performedBy = new mongoose.Types.ObjectId(adminId);
    const records = [
      { eventType: 'status_changed', newValue: { status: 'delivered' }, createdAt: new Date('2025-04-01T00:00:00.000Z') },
      { eventType: 'status_changed', newValue: { status: 'delivered' }, createdAt: new Date('2025-04-03T23:59:59.999Z') },
      { eventType: 'status_changed', newValue: { status: 'delivered' }, createdAt: new Date('2025-04-04T00:00:00.000Z') },
      { eventType: 'status_changed', newValue: { status: 'failed' }, createdAt: new Date('2025-04-02T12:00:00.000Z') },
      { eventType: 'request_created', newValue: { status: 'delivered' }, createdAt: new Date('2025-04-02T12:00:00.000Z') },
    ];
    await DispatchRequestActivity.collection.insertMany(records.map((record) => ({
      ...record,
      dispatchRequestId: dispatchRequest._id,
      performedBy,
      description: 'Analytics test event',
    })));

    const response = await request(app)
      .get('/api/dispatch-analytics?startDate=2025-04-01&endDate=2025-04-03')
      .set('Cookie', operatorCookie)
      .expect(200);

    expect(response.body.data.deliveryTrend).toEqual({
      startDate: '2025-04-01',
      endDate: '2025-04-03',
      timezone: 'UTC',
      daily: [
        { date: '2025-04-01', delivered: 1 },
        { date: '2025-04-02', delivered: 0 },
        { date: '2025-04-03', delivered: 1 },
      ],
    });
  });

  it('returns zero counts and seven UTC dates when the database is empty', async () => {
    const response = await request(app)
      .get('/api/dispatch-analytics')
      .set('Cookie', operatorCookie)
      .expect(200);

    expect(response.body.data.counts).toEqual({
      total: 0,
      pending: 0,
      assigned: 0,
      picked_up: 0,
      in_transit: 0,
      activeDeliveries: 0,
      delivered: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(response.body.data.priorityDistribution).toEqual({ standard: 0, express: 0, urgent: 0 });
    expect(response.body.data.deliveryTrend.daily).toHaveLength(7);
    expect(response.body.data.deliveryTrend.daily.every((day: { delivered: number }) => day.delivered === 0)).toBe(true);
  });

  it('requires authentication and permits both Admin and Operator roles', async () => {
    await request(app).get('/api/dispatch-analytics').expect(401);
    await request(app).get('/api/dispatch-analytics').set('Cookie', operatorCookie).expect(200);
    await request(app).get('/api/dispatch-analytics').set('Cookie', adminCookie).expect(200);
  });

  it('rejects incomplete, reversed, and excessively long date ranges', async () => {
    const invalidRanges = [
      '?startDate=2025-04-01',
      '?startDate=2025-04-03&endDate=2025-04-01',
      '?startDate=2024-01-01&endDate=2025-01-02',
      '?startDate=2025-02-30&endDate=2025-03-01',
    ];
    for (const query of invalidRanges) {
      await request(app)
        .get(`/api/dispatch-analytics${query}`)
        .set('Cookie', adminCookie)
        .expect(400);
    }
  });
});

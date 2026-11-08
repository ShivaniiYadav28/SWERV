import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { AgentLocation } from '../src/models/AgentLocation.js';
import { DeliveryTracking } from '../src/models/DeliveryTracking.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { User } from '../src/models/User.js';
import { ensureDeliveryTrackingCollections } from '../src/services/deliveryTrackingService.js';
import { ensureDispatchRequestCollections } from '../src/services/dispatchRequestService.js';
import { createAccessToken } from '../src/utils/jwt.js';
import { publicTrackingRateLimit } from '../src/routes/publicTrackingRoutes.js';

const testSecret = 'swerv-delivery-tracking-tests-secret-0123456789';
let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';
let adminId = '';
let operatorId = '';

const requestDetails = {
  customer: { name: 'Morgan Customer', email: 'morgan.private@example.com', phone: '+1 555 555 1212' },
  pickup: {
    address: '10 North Street', addressLine2: 'Suite 4', city: 'Portland', region: 'Oregon',
    postalCode: '97201', country: 'United States', instructions: 'Private pickup note',
  },
  delivery: {
    address: '25 River Road', city: 'Portland', region: 'Oregon', postalCode: '97202',
    country: 'United States', instructions: 'Private delivery note',
  },
  package: { description: 'Small boxed item', category: 'parcel', weightKg: 2, quantity: 1 },
  priority: 'express',
};

function userCookie(userId: string) {
  return `swerv_access=${createAccessToken(userId)}`;
}

async function createAgent() {
  return Agent.create({
    agentCode: `AGT-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
    name: 'Casey Driver',
    email: `casey-${new mongoose.Types.ObjectId()}@example.com`,
    phone: '+1 555 111 2222',
    vehicle: { vehicleType: 'van', registrationNumber: `SW-${new mongoose.Types.ObjectId().toString().slice(-6)}`, manufacturer: 'Ford', model: 'Transit' },
    capacity: { maxOrders: 4 },
    capabilities: ['parcel_delivery'],
  });
}

async function createDispatchRequest(status = 'assigned', agentId?: string) {
  const dispatchRequest = await DispatchRequest.create({
    ...requestDetails,
    status,
    assignedAgent: agentId ?? null,
  });
  await DispatchRequestActivity.create({
    dispatchRequestId: dispatchRequest.id,
    eventType: 'request_created',
    description: 'Internal text must not appear publicly.',
    actorType: 'user',
    performedBy: adminId,
    newValue: { status: 'pending' },
  });
  await DispatchRequestActivity.create({
    dispatchRequestId: dispatchRequest.id,
    eventType: 'status_changed',
    description: 'Admin-only operational note.',
    actorType: 'user',
    performedBy: operatorId,
    newValue: { status },
  });
  return dispatchRequest;
}

function createTrackingLink(dispatchRequestId: string, cookie = adminCookie) {
  return request(app)
    .post(`/api/dispatch-requests/${dispatchRequestId}/tracking-link`)
    .set('Cookie', cookie);
}

function publicTracking(token: string) {
  return request(app).get(`/api/public/tracking/${token}`);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = testSecret;
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.CLIENT_URL = 'http://localhost:5173';
  delete process.env.DELIVERY_TRACKING_TTL_DAYS;
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    ensureDispatchRequestCollections(),
    ensureDeliveryTrackingCollections(),
    Agent.init(),
    AgentLocation.init(),
    User.init(),
  ]);
});

beforeEach(async () => {
  await Promise.all([
    Agent.deleteMany({}),
    AgentLocation.deleteMany({}),
    DeliveryTracking.deleteMany({}),
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
  adminCookie = userCookie(admin.id);
  operatorCookie = userCookie(operator.id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('customer delivery tracking API', () => {
  it('lets an Admin create a one-time tracking token and stores only its hash', async () => {
    const dispatchRequest = await createDispatchRequest();
    const response = await createTrackingLink(dispatchRequest.id).expect(201);
    const { token, trackingUrl, expiresAt } = response.body.data;

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(trackingUrl).toBe(`http://localhost:5173/track/${token}`);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(response.body.data).not.toHaveProperty('tokenHash');

    const savedLink = await DeliveryTracking.findOne({ dispatchRequestId: dispatchRequest.id }).select('+tokenHash');
    expect(savedLink?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(savedLink?.tokenHash).not.toBe(token);
    expect(savedLink?.createdBy.toString()).toBe(adminId);

    const status = await request(app)
      .get(`/api/dispatch-requests/${dispatchRequest.id}/tracking-link`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(status.body.data.trackingLink.status).toBe('active');
    expect(JSON.stringify(status.body)).not.toContain(token);
    expect(JSON.stringify(status.body)).not.toContain(savedLink?.tokenHash);
  });

  it('allows Operators to create links when they have dispatch permissions', async () => {
    const dispatchRequest = await createDispatchRequest();
    await createTrackingLink(dispatchRequest.id, operatorCookie).expect(201);
  });

  it('requires Admin or Operator authentication to manage links', async () => {
    const dispatchRequest = await createDispatchRequest();
    await request(app).post(`/api/dispatch-requests/${dispatchRequest.id}/tracking-link`).expect(401);
    await request(app).delete(`/api/dispatch-requests/${dispatchRequest.id}/tracking-link`).expect(401);
    await request(app).get(`/api/dispatch-requests/${dispatchRequest.id}/tracking-link`).expect(401);
  });

  it('rejects invalid request IDs and reports missing tracking links without secrets', async () => {
    await request(app).post('/api/dispatch-requests/not-an-id/tracking-link').set('Cookie', adminCookie).expect(400);
    const dispatchRequest = await createDispatchRequest();
    const response = await request(app)
      .get(`/api/dispatch-requests/${dispatchRequest.id}/tracking-link`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(response.body.data.trackingLink).toMatchObject({ exists: false, status: 'not_created' });
    await request(app).post(`/api/dispatch-requests/${new mongoose.Types.ObjectId()}/tracking-link`).set('Cookie', adminCookie).expect(404);
  });

  it('does not create a second active link, and allows a new link after revocation', async () => {
    const dispatchRequest = await createDispatchRequest();
    const firstLink = await createTrackingLink(dispatchRequest.id).expect(201);
    await createTrackingLink(dispatchRequest.id).expect(409);
    await request(app)
      .delete(`/api/dispatch-requests/${dispatchRequest.id}/tracking-link`)
      .set('Cookie', operatorCookie)
      .expect(200);
    await createTrackingLink(dispatchRequest.id).expect(201);
    await publicTracking(firstLink.body.data.token).expect(404);
  });

  it('serves only customer-safe delivery details and status timeline for a valid link', async () => {
    const dispatchRequest = await createDispatchRequest('in_transit');
    const agent = await createAgent();
    await DispatchRequest.updateOne({ _id: dispatchRequest.id }, { $set: { assignedAgent: agent.id } });
    const link = await createTrackingLink(dispatchRequest.id).expect(201);
    await AgentLocation.create({
      agentId: agent.id,
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 8,
      recordedAt: new Date(),
      receivedAt: new Date(),
    });

    const response = await publicTracking(link.body.data.token).expect(200);
    const tracking = response.body.data.tracking;
    expect(tracking).toMatchObject({
      status: 'in_transit',
      package: { description: requestDetails.package.description, category: 'parcel' },
      pickup: { address: '10 North Street', city: 'Portland', postalCode: '97201' },
      destination: { address: '25 River Road', city: 'Portland', postalCode: '97202' },
      priority: 'express',
      location: { latitude: 37.7749, longitude: -122.4194 },
      estimatedArrival: null,
    });
    expect(tracking.pickup).not.toHaveProperty('coordinates');
    expect(tracking.destination).not.toHaveProperty('coordinates');
    expect(tracking.timeline).toHaveLength(2);
    expect(tracking.timeline[0]).toMatchObject({ status: 'pending', description: 'Your delivery request has been received.' });
    expect(tracking.timeline[1]).toMatchObject({ status: 'in_transit', description: 'Your package is on the way.' });
    expect(tracking.lastLocationUpdate).toBeTruthy();
    const bodyText = JSON.stringify(tracking);
    for (const privateValue of [dispatchRequest.id, agent.id, requestDetails.customer.email, requestDetails.customer.phone, 'Casey Driver', 'Private pickup note', 'Private delivery note', 'Admin-only operational note', 'performedBy', 'tokenHash']) {
      expect(bodyText).not.toContain(privateValue);
    }
  });

  it('returns stored pickup and destination coordinates without internal or customer identifiers', async () => {
    const dispatchRequest = await createDispatchRequest('assigned');
    await DispatchRequest.updateOne(
      { _id: dispatchRequest.id },
      {
        $set: {
          'pickup.latitude': 45.5231,
          'pickup.longitude': -122.6765,
          'delivery.latitude': 45.5152,
          'delivery.longitude': -122.6784,
        },
      },
    );
    const link = await createTrackingLink(dispatchRequest.id).expect(201);
    const response = await publicTracking(link.body.data.token).expect(200);
    const tracking = response.body.data.tracking;

    expect(tracking.pickup.coordinates).toEqual({ latitude: 45.5231, longitude: -122.6765 });
    expect(tracking.destination.coordinates).toEqual({ latitude: 45.5152, longitude: -122.6784 });
    expect(JSON.stringify(tracking)).not.toContain(dispatchRequest.id);
    expect(JSON.stringify(tracking)).not.toContain(requestDetails.customer.email);
    expect(JSON.stringify(tracking)).not.toContain(requestDetails.customer.phone);
  });

  it('rejects invalid and malformed public tokens without exposing delivery data', async () => {
    await publicTracking('not-a-valid-token').expect(404);
    await publicTracking('A'.repeat(43)).expect(404);
  });

  it('rejects expired links', async () => {
    const dispatchRequest = await createDispatchRequest();
    const link = await createTrackingLink(dispatchRequest.id).expect(201);
    await DeliveryTracking.updateOne(
      { dispatchRequestId: dispatchRequest.id },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );
    await publicTracking(link.body.data.token).expect(404);
    const status = await request(app)
      .get(`/api/dispatch-requests/${dispatchRequest.id}/tracking-link`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(status.body.data.trackingLink.status).toBe('expired');
  });

  it('rejects revoked links immediately and reports their status', async () => {
    const dispatchRequest = await createDispatchRequest();
    const link = await createTrackingLink(dispatchRequest.id).expect(201);
    await request(app)
      .delete(`/api/dispatch-requests/${dispatchRequest.id}/tracking-link`)
      .set('Cookie', adminCookie)
      .expect(200);
    await publicTracking(link.body.data.token).expect(404);
    const status = await request(app)
      .get(`/api/dispatch-requests/${dispatchRequest.id}/tracking-link`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(status.body.data.trackingLink.status).toBe('revoked');
  });

  it('keeps GPS hidden before pickup', async () => {
    const agent = await createAgent();
    const dispatchRequest = await createDispatchRequest('assigned', agent.id);
    await AgentLocation.create({ agentId: agent.id, latitude: 37, longitude: -122, recordedAt: new Date(), receivedAt: new Date() });
    const link = await createTrackingLink(dispatchRequest.id).expect(201);
    const response = await publicTracking(link.body.data.token).expect(200);
    expect(response.body.data.tracking.location).toBeNull();
    expect(response.body.data.tracking.lastLocationUpdate).toBeNull();
  });

  it('shows fresh GPS after pickup', async () => {
    const agent = await createAgent();
    const dispatchRequest = await createDispatchRequest('picked_up', agent.id);
    await AgentLocation.create({ agentId: agent.id, latitude: 37, longitude: -122, recordedAt: new Date(), receivedAt: new Date() });
    const link = await createTrackingLink(dispatchRequest.id).expect(201);
    const response = await publicTracking(link.body.data.token).expect(200);
    expect(response.body.data.tracking.location).toMatchObject({ latitude: 37, longitude: -122 });
  });

  it('hides GPS after delivery and does not expose another agent location', async () => {
    const assignedAgent = await createAgent();
    const otherAgent = await createAgent();
    const deliveredRequest = await createDispatchRequest('delivered', assignedAgent.id);
    await AgentLocation.create({ agentId: assignedAgent.id, latitude: 37, longitude: -122, recordedAt: new Date(), receivedAt: new Date() });
    const deliveredLink = await createTrackingLink(deliveredRequest.id).expect(201);
    const delivered = await publicTracking(deliveredLink.body.data.token).expect(200);
    expect(delivered.body.data.tracking.location).toBeNull();

    const transitRequest = await createDispatchRequest('in_transit', otherAgent.id);
    const transitLink = await createTrackingLink(transitRequest.id).expect(201);
    const transit = await publicTracking(transitLink.body.data.token).expect(200);
    expect(transit.body.data.tracking.location).toBeNull();
  });

  it('hides old GPS points and rate limits token guessing', async () => {
    const agent = await createAgent();
    const dispatchRequest = await createDispatchRequest('in_transit', agent.id);
    await AgentLocation.create({
      agentId: agent.id,
      latitude: 37,
      longitude: -122,
      recordedAt: new Date(Date.now() - 16 * 60 * 1_000),
      receivedAt: new Date(Date.now() - 16 * 60 * 1_000),
    });
    const link = await createTrackingLink(dispatchRequest.id).expect(201);
    const response = await publicTracking(link.body.data.token).expect(200);
    expect(response.body.data.tracking.location).toBeNull();

    publicTrackingRateLimit.resetKey('::ffff:127.0.0.1');
    const attempts = await Promise.all(
      Array.from({ length: 35 }, (_, index) => publicTracking(`invalid-token-${index}`)),
    );
    expect(attempts.some((attempt) => attempt.status === 429)).toBe(true);
  });
});

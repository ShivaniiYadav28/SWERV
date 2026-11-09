import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { AgentLocation } from '../src/models/AgentLocation.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { RoutePlan, ensureRoutePlanIndexes } from '../src/models/RoutePlan.js';
import { User } from '../src/models/User.js';
import { ensureAgentCollections } from '../src/services/agentService.js';
import { ensureAgentLocationCollections } from '../src/services/agentLocationService.js';
import { ensureDispatchRequestCollections } from '../src/services/dispatchRequestService.js';
import { createBaselineOrder, optimizeStopOrder, validateStopSequence } from '../src/services/routeOptimizer.js';
import { createAccessToken } from '../src/utils/jwt.js';
import type { RouteStop } from '../src/services/routeOptimizer.js';

const testSecret = 'swerv-route-optimization-secret-0123456789';
const originalFetch = globalThis.fetch;
let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';
let agentId = '';

function createRoadResponse(url: URL): Response {
  if (url.pathname.includes('/table/')) {
    const coordinatePath = url.pathname.split('/driving/')[1];
    const size = coordinatePath.split(';').length;
    const durations = Array.from({ length: size }, (_row, row) =>
      Array.from({ length: size }, (_cell, column) => row === column ? 0 : Math.abs(row - column) * 80 + column));
    const distances = Array.from({ length: size }, (_row, row) =>
      Array.from({ length: size }, (_cell, column) => row === column ? 0 : Math.abs(row - column) * 500 + column));
    return Response.json({ code: 'Ok', durations, distances });
  }
  if (url.pathname.includes('/route/')) {
    const coordinatePath = url.pathname.split('/driving/')[1].split('?')[0];
    const coordinates = coordinatePath.split(';').map((pair) => pair.split(',').map(Number));
    return Response.json({ code: 'Ok', routes: [{ distance: 4_200, duration: 810, geometry: { coordinates } }] });
  }
  return Response.json({ code: 'NotFound' }, { status: 404 });
}

async function createAgent() {
  return Agent.create({
    agentCode: `AGT-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
    name: 'Route Test Agent', email: 'route-agent@example.com', phone: '+1 555 555 1212',
    vehicle: { vehicleType: 'van', registrationNumber: `RT-${new mongoose.Types.ObjectId().toString().slice(-6)}`, manufacturer: 'Ford', model: 'Transit' },
    capacity: { maxOrders: 5 }, capabilities: ['parcel_delivery'], status: 'available',
  });
}

async function createDispatch(overrides: Record<string, unknown> = {}) {
  return DispatchRequest.create({
    customer: { name: 'Route Customer', email: `${new mongoose.Types.ObjectId()}@example.com`, phone: '+1 555 111 2222' },
    pickup: { address: 'Pickup', city: 'Bengaluru', region: 'KA', postalCode: '560001', country: 'India', latitude: 12.9716, longitude: 77.5946 },
    delivery: { address: 'Destination', city: 'Bengaluru', region: 'KA', postalCode: '560002', country: 'India', latitude: 12.9816, longitude: 77.6046 },
    package: { description: 'Route test package', category: 'parcel', weightKg: 1, quantity: 1 },
    assignedAgent: agentId,
    status: 'assigned',
    ...overrides,
  });
}

function adminUserCookie(id: string) { return `swerv_access=${createAccessToken(id)}`; }

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = testSecret;
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.ROUTING_SERVICE_BASE_URL = 'https://routing.test';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    ensureAgentCollections(), ensureAgentLocationCollections(),
    ensureDispatchRequestCollections(), ensureRoutePlanIndexes(),
  ]);
});

beforeEach(async () => {
  globalThis.fetch = vi.fn(async (input) => createRoadResponse(new URL(String(input)))) as typeof fetch;
  await Promise.all([Agent.deleteMany({}), AgentLocation.deleteMany({}), DispatchRequest.deleteMany({}), RoutePlan.deleteMany({}), User.deleteMany({})]);
  const [admin, operator] = await User.create([
    { name: 'Route Admin', email: 'route-admin@example.com', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Route Operator', email: 'route-operator@example.com', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  adminCookie = adminUserCookie(admin.id);
  operatorCookie = adminUserCookie(operator.id);
  const agent = await createAgent();
  agentId = agent.id;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('route stop optimization', () => {
  it('uses the closest eligible stop and keeps each pickup before its delivery', () => {
    const stops: RouteStop[] = [
      { dispatchRequestId: 'dispatch-a', stopType: 'pickup', latitude: 1, longitude: 1 },
      { dispatchRequestId: 'dispatch-a', stopType: 'delivery', latitude: 1, longitude: 2 },
      { dispatchRequestId: 'dispatch-b', stopType: 'pickup', latitude: 2, longitude: 1 },
      { dispatchRequestId: 'dispatch-b', stopType: 'delivery', latitude: 2, longitude: 2 },
    ];
    const durations = [
      [0, 90, 10, 80, 70], [90, 0, 60, 50, 40], [10, 60, 0, 80, 70],
      [80, 50, 80, 0, 5], [70, 40, 70, 5, 0],
    ];
    const order = optimizeStopOrder(stops, durations, durations);
    const pickupA = order.findIndex((stop) => stop.dispatchRequestId === 'dispatch-a' && stop.stopType === 'pickup');
    const deliveryA = order.findIndex((stop) => stop.dispatchRequestId === 'dispatch-a' && stop.stopType === 'delivery');
    const pickupB = order.findIndex((stop) => stop.dispatchRequestId === 'dispatch-b' && stop.stopType === 'pickup');
    const deliveryB = order.findIndex((stop) => stop.dispatchRequestId === 'dispatch-b' && stop.stopType === 'delivery');
    expect(order[0].dispatchRequestId).toBe('dispatch-b');
    expect(pickupA).toBeLessThan(deliveryA);
    expect(pickupB).toBeLessThan(deliveryB);
  });

  it('keeps pickup precedence when building an existing route baseline', () => {
    const stops: RouteStop[] = [
      { dispatchRequestId: 'dispatch-a', stopType: 'pickup', latitude: 1, longitude: 1 },
      { dispatchRequestId: 'dispatch-a', stopType: 'delivery', latitude: 1, longitude: 2 },
    ];
    const order = createBaselineOrder(stops, [
      { dispatchRequestId: 'dispatch-a', stopType: 'delivery' },
      { dispatchRequestId: 'dispatch-a', stopType: 'pickup' },
    ]);
    expect(order.map((stop) => stop.stopType)).toEqual(['pickup', 'delivery']);
    expect(validateStopSequence(stops, order)).toBe(true);
    expect(validateStopSequence(stops, [...order].reverse())).toBe(false);
  });
});

describe('route optimization API', () => {
  it('allows Admin and Operator sessions to view eligible deliveries', async () => {
    await createDispatch();
    const adminResponse = await request(app)
      .get(`/api/route-optimization/agents/${agentId}/deliveries`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(adminResponse.body.data.deliveries).toHaveLength(1);
    expect(adminResponse.body.data.deliveries[0].missingCoordinates).toEqual([]);
    expect(adminResponse.body.data.deliveries[0]).not.toHaveProperty('customer');
    await request(app)
      .get(`/api/route-optimization/agents/${agentId}/deliveries`)
      .set('Cookie', operatorCookie)
      .expect(200);
    await request(app).get(`/api/route-optimization/agents/${agentId}/deliveries`).expect(401);
  });

  it('returns provider-based road routes and saves only a confirmed valid stop sequence', async () => {
    const first = await createDispatch();
    const second = await createDispatch({
      pickup: { address: 'Pickup 2', city: 'Bengaluru', region: 'KA', postalCode: '560003', country: 'India', latitude: 12.955, longitude: 77.58 },
      delivery: { address: 'Destination 2', city: 'Bengaluru', region: 'KA', postalCode: '560004', country: 'India', latitude: 12.965, longitude: 77.59 },
    });
    const preview = await request(app)
      .post('/api/route-optimization/preview')
      .set('Cookie', adminCookie)
      .send({ agentId, dispatchRequestIds: [first.id, second.id] })
      .expect(200);
    expect(preview.body.data.preview).toMatchObject({ routingProvider: 'OSRM', baseline: { distanceMeters: 4_200 }, optimized: { durationSeconds: 810 } });
    expect(preview.body.data.preview.optimized.stops).toHaveLength(4);

    const applyResponse = await request(app)
      .post('/api/route-optimization/apply')
      .set('Cookie', adminCookie)
      .send({
        agentId,
        dispatchRequestIds: [first.id, second.id],
        stopSequence: preview.body.data.preview.optimized.stops.map(({ dispatchRequestId, stopType }: { dispatchRequestId: string; stopType: 'pickup' | 'delivery' }) => ({ dispatchRequestId, stopType })),
      });
    expect(applyResponse.status, applyResponse.text).toBe(200);
    const savedPlan = await request(app)
      .get(`/api/route-optimization/agents/${agentId}/plan`)
      .set('Cookie', operatorCookie)
      .expect(200);
    expect(savedPlan.body.data.routePlan.stopSequence).toHaveLength(4);
    expect((await DispatchRequest.findById(first.id))?.status).toBe('assigned');
    expect((await DispatchRequest.findById(second.id))?.status).toBe('assigned');
  });

  it('rejects missing coordinates and deliveries that are not assigned and active', async () => {
    const missingCoordinates = await createDispatch({ pickup: { address: 'No map point', city: 'Bengaluru', region: 'KA', postalCode: '560001', country: 'India' } });
    await request(app)
      .post('/api/route-optimization/preview')
      .set('Cookie', adminCookie)
      .send({ agentId, dispatchRequestIds: [missingCoordinates.id] })
      .expect(409);

    const pending = await createDispatch({ status: 'pending', assignedAgent: null });
    await request(app)
      .post('/api/route-optimization/preview')
      .set('Cookie', adminCookie)
      .send({ agentId, dispatchRequestIds: [pending.id] })
      .expect(409);
  });

  it('returns a clear provider error and rejects an invalid saved stop order', async () => {
    const first = await createDispatch();
    const second = await createDispatch();
    const wrongOrder = [
      { dispatchRequestId: first.id, stopType: 'delivery' },
      { dispatchRequestId: first.id, stopType: 'pickup' },
      { dispatchRequestId: second.id, stopType: 'pickup' },
      { dispatchRequestId: second.id, stopType: 'delivery' },
    ];
    await request(app)
      .post('/api/route-optimization/apply')
      .set('Cookie', adminCookie)
      .send({ agentId, dispatchRequestIds: [first.id, second.id], stopSequence: wrongOrder })
      .expect(400);
    expect(await RoutePlan.countDocuments()).toBe(0);

    globalThis.fetch = vi.fn(async () => Response.json({ code: 'NoRoute' })) as typeof fetch;
    await request(app)
      .post('/api/route-optimization/preview')
      .set('Cookie', adminCookie)
      .send({ agentId, dispatchRequestIds: [first.id, second.id] })
      .expect(503);
  });

  it('rejects invalid request data and reports an empty delivery list', async () => {
    await request(app)
      .post('/api/route-optimization/preview')
      .set('Cookie', adminCookie)
      .send({ agentId: 'bad-id', dispatchRequestIds: [] })
      .expect(400);
    const response = await request(app)
      .get(`/api/route-optimization/agents/${agentId}/deliveries`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(response.body.data.deliveries).toEqual([]);
  });
});

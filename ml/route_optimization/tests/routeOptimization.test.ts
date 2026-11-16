import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { optimizeStopOrder } from '../src/services/routeOptimizer.js';
import type { RouteStop } from '../src/types/routeOptimization.js';

const testApiKey = 'route-optimization-test-token';
const originalApiKey = process.env.ROUTE_OPTIMIZATION_API_KEY;
const originalRoutingUrl = process.env.ROUTING_SERVICE_BASE_URL;

type TestDelivery = {
  dispatchRequestId: string;
  status: 'assigned' | 'picked_up' | 'in_transit';
  pickup?: { latitude: number; longitude: number };
  delivery: { latitude: number; longitude: number };
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createRequest(deliveries: TestDelivery[] = [
  {
    dispatchRequestId: 'dispatch-a',
    status: 'assigned',
    pickup: { latitude: 12.955, longitude: 77.58 },
    delivery: { latitude: 12.965, longitude: 77.59 },
  },
  {
    dispatchRequestId: 'dispatch-b',
    status: 'assigned',
    pickup: { latitude: 12.971, longitude: 77.595 },
    delivery: { latitude: 12.9816, longitude: 77.6046 },
  },
]) {
  return {
    agent: { agentId: 'agent-test-1', latitude: 12.9716, longitude: 77.5946 },
    deliveries,
  };
}

function mockOsrm() {
  const routeMetrics = [
    { distance: 5_000, duration: 1_000 },
    { distance: 4_200, duration: 810 },
  ];
  let routeRequestIndex = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/table/')) {
      const path = url.pathname.split('/driving/')[1];
      const size = path.split(';').length;
      const durations = Array.from({ length: size }, (_row, row) =>
        Array.from({ length: size }, (_cell, column) => row === column ? 0 : Math.abs(row - column) * 80 + column));
      const distances = Array.from({ length: size }, (_row, row) =>
        Array.from({ length: size }, (_cell, column) => row === column ? 0 : Math.abs(row - column) * 500 + column));
      return jsonResponse({ code: 'Ok', durations, distances });
    }
    if (url.pathname.includes('/route/')) {
      const coordinatesPath = url.pathname.split('/driving/')[1].split('?')[0];
      const coordinates = coordinatesPath.split(';').map((pair) => pair.split(',').map(Number));
      const metrics = routeMetrics[routeRequestIndex++];
      return jsonResponse({
        code: 'Ok',
        routes: [{
          ...metrics,
          geometry: { coordinates },
        }],
      });
    }
    return jsonResponse({ code: 'NotFound' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.ROUTE_OPTIMIZATION_API_KEY = testApiKey;
  process.env.ROUTING_SERVICE_BASE_URL = 'https://routing.test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.ROUTE_OPTIMIZATION_API_KEY;
  else process.env.ROUTE_OPTIMIZATION_API_KEY = originalApiKey;
  if (originalRoutingUrl === undefined) delete process.env.ROUTING_SERVICE_BASE_URL;
  else process.env.ROUTING_SERVICE_BASE_URL = originalRoutingUrl;
});

describe('standalone route optimization API', () => {
  it('keeps the health endpoint public', async () => {
    delete process.env.ROUTE_OPTIMIZATION_API_KEY;
    await request(app).get('/health').expect(200, { status: 'ok' });
  });

  it('rejects missing and invalid Bearer tokens', async () => {
    await request(app).post('/optimize').send(createRequest()).expect(401);
    await request(app)
      .post('/optimize')
      .set('Authorization', 'Bearer invalid-token')
      .send(createRequest())
      .expect(401);
  });

  it('fails safely when the server API key is not configured', async () => {
    delete process.env.ROUTE_OPTIMIZATION_API_KEY;
    const response = await request(app)
      .post('/optimize')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send(createRequest())
      .expect(503);
    expect(response.body.message).toContain('not configured');
  });

  it('returns baseline and optimized road estimates with stop IDs and geometry', async () => {
    mockOsrm();
    const response = await request(app)
      .post('/optimize')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send(createRequest())
      .expect(200);

    const preview = response.body.data.preview;
    expect(preview).toMatchObject({
      agentId: 'agent-test-1',
      routingProvider: 'OSRM',
      baselineLabel: 'Provided delivery order',
      baseline: { distanceMeters: 5_000, durationSeconds: 1_000 },
      optimized: { distanceMeters: 4_200, durationSeconds: 810 },
      improvement: { distancePercent: 16, durationPercent: 19 },
    });
    expect(preview.optimized.stops).toHaveLength(4);
    expect(preview.optimized.stops.map((stop: RouteStop) => stop.dispatchRequestId))
      .toEqual(expect.arrayContaining(['dispatch-a', 'dispatch-b']));
    expect(preview.optimized.stops[0]).toHaveProperty('stopType');
    expect(preview.optimized.geometry[0]).toEqual([12.9716, 77.5946]);
    for (const dispatchRequestId of ['dispatch-a', 'dispatch-b']) {
      const pickupIndex = preview.optimized.stops.findIndex(
        (stop: RouteStop) => stop.dispatchRequestId === dispatchRequestId && stop.stopType === 'pickup',
      );
      const deliveryIndex = preview.optimized.stops.findIndex(
        (stop: RouteStop) => stop.dispatchRequestId === dispatchRequestId && stop.stopType === 'delivery',
      );
      expect(pickupIndex).toBeLessThan(deliveryIndex);
    }
  });

  it('uses only a delivery stop for deliveries that have already been picked up', async () => {
    mockOsrm();
    const response = await request(app)
      .post('/optimize')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send(createRequest([
        {
          dispatchRequestId: 'dispatch-assigned',
          status: 'assigned',
          pickup: { latitude: 12.955, longitude: 77.58 },
          delivery: { latitude: 12.965, longitude: 77.59 },
        },
        {
          dispatchRequestId: 'dispatch-picked-up',
          status: 'picked_up',
          delivery: { latitude: 12.9816, longitude: 77.6046 },
        },
      ]))
      .expect(200);

    const stops = response.body.data.preview.optimized.stops as RouteStop[];
    expect(stops.filter((stop) => stop.dispatchRequestId === 'dispatch-picked-up')).toEqual([
      expect.objectContaining({ stopType: 'delivery' }),
    ]);
  });

  it('rejects invalid coordinates, duplicate IDs, and more than 12 deliveries', async () => {
    const invalidCoordinates = createRequest();
    invalidCoordinates.agent.latitude = 91;
    await request(app)
      .post('/optimize')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send(invalidCoordinates)
      .expect(400);

    const duplicateIds = createRequest();
    duplicateIds.deliveries[1].dispatchRequestId = duplicateIds.deliveries[0].dispatchRequestId;
    await request(app)
      .post('/optimize')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send(duplicateIds)
      .expect(400);

    const tooManyDeliveries = createRequest(Array.from({ length: 13 }, (_delivery, index) => ({
      dispatchRequestId: `dispatch-${index}`,
      status: 'in_transit' as const,
      delivery: { latitude: 12.9, longitude: 77.5 },
    })));
    await request(app)
      .post('/optimize')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send(tooManyDeliveries)
      .expect(400);
  });

  it('returns a service-unavailable response when OSRM cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network unavailable');
    }));
    const response = await request(app)
      .post('/optimize')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send(createRequest())
      .expect(503);
    expect(response.body.message).toContain('temporarily unavailable');
  });
});

describe('existing stop-ordering behavior', () => {
  it('uses duration first, distance to break ties, and never delivers before pickup', () => {
    const stops: RouteStop[] = [
      { dispatchRequestId: 'dispatch-a', stopType: 'pickup', latitude: 1, longitude: 1 },
      { dispatchRequestId: 'dispatch-a', stopType: 'delivery', latitude: 1, longitude: 2 },
      { dispatchRequestId: 'dispatch-b', stopType: 'pickup', latitude: 2, longitude: 1 },
      { dispatchRequestId: 'dispatch-b', stopType: 'delivery', latitude: 2, longitude: 2 },
    ];
    const durations = [
      [0, 5, 1, 5, 1],
      [5, 0, 4, 5, 1],
      [1, 4, 0, 4, 1],
      [5, 2, 1, 0, 10],
      [1, 4, 1, 10, 0],
    ];
    const distances = [
      [0, 80, 5, 20, 1],
      [80, 0, 5, 20, 1],
      [5, 5, 0, 5, 1],
      [20, 20, 1, 0, 10],
      [1, 1, 1, 10, 0],
    ];

    const order = optimizeStopOrder(stops, durations, distances);
    expect(order[0]).toMatchObject({ dispatchRequestId: 'dispatch-b', stopType: 'pickup' });
    for (const dispatchRequestId of ['dispatch-a', 'dispatch-b']) {
      const pickupIndex = order.findIndex(
        (stop) => stop.dispatchRequestId === dispatchRequestId && stop.stopType === 'pickup',
      );
      const deliveryIndex = order.findIndex(
        (stop) => stop.dispatchRequestId === dispatchRequestId && stop.stopType === 'delivery',
      );
      expect(pickupIndex).toBeLessThan(deliveryIndex);
    }
  });
});

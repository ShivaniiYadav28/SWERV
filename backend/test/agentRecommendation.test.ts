import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { AgentLocation } from '../src/models/AgentLocation.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { User } from '../src/models/User.js';
import { ensureDispatchRequestCollections } from '../src/services/dispatchRequestService.js';
import { createAccessToken } from '../src/utils/jwt.js';

let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';

function cookie(userId: string) {
  return `swerv_access=${createAccessToken(userId)}`;
}

async function createDispatchRequest(overrides: Record<string, unknown> = {}) {
  return DispatchRequest.create({
    pickup: {
      address: '10 North Street', city: 'Portland', region: 'Oregon',
      postalCode: '97201', country: 'United States', latitude: 45.523, longitude: -122.676,
    },
    delivery: {
      address: '25 River Road', city: 'Portland', region: 'Oregon',
      postalCode: '97202', country: 'United States', latitude: 45.51, longitude: -122.65,
    },
    package: { description: 'Small boxed item', category: 'parcel', weightKg: 2, quantity: 1 },
    priority: 'standard',
    ...overrides,
  });
}

async function createAgent(overrides: Record<string, unknown> = {}) {
  const unique = new mongoose.Types.ObjectId().toString();
  return Agent.create({
    agentCode: `AGT-${unique.slice(-8)}`,
    name: 'Taylor Driver',
    email: `driver-${unique}@example.com`,
    phone: '+1 555 111 2222',
    vehicle: {
      vehicleType: 'van', registrationNumber: `SW-${unique.slice(-6)}`,
      manufacturer: 'Ford', model: 'Transit',
    },
    capacity: { maxOrders: 4 },
    capabilities: ['parcel_delivery'],
    ...overrides,
  });
}

function recommend(id: string, cookieValue = adminCookie) {
  return request(app)
    .get(`/api/dispatch-requests/${id}/agent-recommendations`)
    .set('Cookie', cookieValue);
}

function mockMlService(
  durationFor: (candidate: Record<string, unknown>) => number = (candidate) =>
    30 + Number(candidate.active_workload) * 10
      + (typeof candidate.agent_to_pickup_km === 'number' ? candidate.agent_to_pickup_km : 15),
) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const requestBody = JSON.parse(String(init?.body)) as {
      dispatch_request_id: string;
      candidates: Record<string, unknown>[];
    };
    const predictions = requestBody.candidates.map((candidate) => ({
      agent_id: candidate.agent_id,
      agent_code: candidate.agent_code,
      predicted_duration_minutes: durationFor(candidate),
    })).sort((first, second) => first.predicted_duration_minutes - second.predicted_duration_minutes)
      .map((item, index) => ({ ...item, rank: index + 1 }));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        dispatch_request_id: requestBody.dispatch_request_id,
        prediction_status: 'available',
        model_version: 'gradient_boosting-synthetic-test',
        training_source: 'synthetic',
        predictions,
      }),
    } as Response;
  }));
}

async function addHistoricalDelivery(agentId: mongoose.Types.ObjectId, durationMinutes: number) {
  const deliveredAt = new Date(Date.now() - 60_000);
  const assignedAt = new Date(deliveredAt.getTime() - durationMinutes * 60_000);
  const delivery = await createDispatchRequest({ status: 'delivered', assignedAgent: agentId });
  await DispatchRequestActivity.create([
    {
      dispatchRequestId: delivery._id, eventType: 'assignment_changed',
      description: 'Agent assigned.', actorType: 'user', performedBy: new mongoose.Types.ObjectId(),
      newValue: { agentId: agentId.toString() }, createdAt: assignedAt,
    },
    {
      dispatchRequestId: delivery._id, eventType: 'status_changed',
      description: 'Delivery completed.', actorType: 'user', performedBy: new mongoose.Types.ObjectId(),
      newValue: { status: 'delivered' }, createdAt: deliveredAt,
    },
  ]);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-agent-recommendation-tests-secret-012345';
  process.env.JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await ensureDispatchRequestCollections();
  await Promise.all([Agent.init(), AgentLocation.init(), User.init()]);
});

beforeEach(async () => {
  mockMlService();
  await Promise.all([
    DispatchRequest.deleteMany({}), DispatchRequestActivity.deleteMany({}),
    AgentLocation.deleteMany({}), Agent.deleteMany({}), User.deleteMany({}),
  ]);
  const [admin, operator] = await User.create([
    { name: 'Admin User', email: 'recommend-admin@example.com', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Operator User', email: 'recommend-operator@example.com', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  adminCookie = cookie(admin.id);
  operatorCookie = cookie(operator.id);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('agent recommendation endpoint', () => {
  it('returns only eligible agents ranked by ML and explains missing GPS/history', async () => {
    const dispatch = await createDispatchRequest({
      package: {
        description: 'Multi-item parcel', category: 'parcel', weightKg: 7.25, quantity: 3,
      },
    });
    const busy = await createAgent({ name: 'Busy Driver', activeDispatchCount: 3 });
    const available = await createAgent({ name: 'Free Driver', activeDispatchCount: 0 });
    await createAgent({ name: 'On Duty', status: 'on_duty' });
    await createAgent({ name: 'No Parcel Capability', capabilities: ['food_delivery'] });
    await createAgent({ name: 'Full Capacity', activeDispatchCount: 4 });

    const response = await recommend(dispatch.id, operatorCookie).expect(200);
    expect(response.body.data.recommendations.map((item: { agent: { id: string } }) => item.agent.id))
      .toEqual([available.id, busy.id]);
    expect(response.body.data.recommendations[0]).toMatchObject({
      rank: 1, agent: { name: 'Free Driver', vehicleType: 'van' },
      predictedDurationMinutes: 45,
      distanceKm: null, historicalMedianDurationMinutes: null,
    });
    expect(response.body.data.recommendations[0].explanation.join(' ')).toContain('fresh agent GPS is unavailable');
    expect(response.body.data.recommendations[0].explanation.join(' ')).toContain('fewer than 10');
    expect(response.body.data).toMatchObject({
      dispatchRequestId: dispatch.id,
      predictionStatus: 'available',
      modelVersion: 'gradient_boosting-synthetic-test',
      trainingSource: 'synthetic',
    });
    const fetchOptions = vi.mocked(fetch).mock.calls[0]?.[1];
    const mlRequest = JSON.parse(String(fetchOptions?.body)) as {
      candidates: Array<Record<string, unknown>>;
      dispatch: Record<string, unknown>;
    };
    expect(mlRequest.dispatch).toMatchObject({
      package_category: 'parcel',
      weight_kg: 7.25,
      quantity: 3,
    });
    expect(mlRequest.candidates.map((candidate) => candidate.agent_id).sort())
      .toEqual([available.id, busy.id].sort());
    expect(mlRequest.candidates[0]).not.toHaveProperty('email');
    expect(mlRequest.candidates[0]).not.toHaveProperty('phone');
    expect(mlRequest.dispatch).not.toHaveProperty('address');
  });

  it('uses fresh GPS distance and ignores missing, stale, or future-received locations', async () => {
    const dispatch = await createDispatchRequest();
    const near = await createAgent({ name: 'Near Driver' });
    const far = await createAgent({ name: 'Far Driver' });
    const stale = await createAgent({ name: 'Stale Driver' });
    const futureReceived = await createAgent({ name: 'Future GPS Driver' });
    const now = new Date();
    await AgentLocation.create([
      { agentId: near._id, latitude: 45.524, longitude: -122.676, recordedAt: now, receivedAt: now },
      { agentId: far._id, latitude: 46, longitude: -122.676, recordedAt: now, receivedAt: now },
      { agentId: stale._id, latitude: 45.523, longitude: -122.676,
        recordedAt: new Date(now.getTime() - 16 * 60_000), receivedAt: new Date(now.getTime() - 16 * 60_000) },
      { agentId: futureReceived._id, latitude: 45.523, longitude: -122.676,
        recordedAt: now, receivedAt: new Date(now.getTime() + 60_000) },
    ]);
    const response = await recommend(dispatch.id).expect(200);
    const entries = response.body.data.recommendations;
    expect(entries[0].agent.id).toBe(near.id);
    expect(entries.find((item: { agent: { id: string } }) => item.agent.id === far.id).distanceKm).toBeGreaterThan(50);
    expect(entries.find((item: { agent: { id: string } }) => item.agent.id === stale.id).distanceKm).toBeNull();
    expect(entries.find((item: { agent: { id: string } }) => item.agent.id === futureReceived.id).distanceKm).toBeNull();
    expect(response.body.data.rankingData.agentsWithFreshGps).toBe(2);
  });

  it('scores historical performance only after ten valid completed deliveries', async () => {
    const dispatch = await createDispatchRequest();
    const agent = await createAgent();
    for (let index = 0; index < 10; index += 1) await addHistoricalDelivery(agent._id, 20 + index);

    const response = await recommend(dispatch.id).expect(200);
    expect(response.body.data.recommendations[0]).toMatchObject({
      historicalCompletedDeliveries: 10,
      historicalMedianDurationMinutes: 24.5,
    });
    expect(response.body.data.recommendations[0].predictedDurationMinutes).toBeGreaterThan(0);
    expect(response.body.data.rankingData.historicalPerformanceAvailable).toBe(true);
  });

  it('does not treat an earlier matching assignment as valid after a later reassignment', async () => {
    const dispatch = await createDispatchRequest();
    const agent = await createAgent();
    const otherAgent = await createAgent();
    for (let index = 0; index < 10; index += 1) await addHistoricalDelivery(agent._id, 25);
    const invalidHistory = await createDispatchRequest({ status: 'delivered', assignedAgent: agent._id });
    const now = new Date();
    await DispatchRequestActivity.create([
      { dispatchRequestId: invalidHistory._id, eventType: 'assignment_changed', description: 'Assigned.', actorType: 'user', performedBy: new mongoose.Types.ObjectId(), newValue: { agentId: agent.id }, createdAt: new Date(now.getTime() - 120_000) },
      { dispatchRequestId: invalidHistory._id, eventType: 'assignment_changed', description: 'Reassigned.', actorType: 'user', performedBy: new mongoose.Types.ObjectId(), newValue: { agentId: otherAgent.id }, createdAt: new Date(now.getTime() - 60_000) },
      { dispatchRequestId: invalidHistory._id, eventType: 'status_changed', description: 'Delivered.', actorType: 'user', performedBy: new mongoose.Types.ObjectId(), newValue: { status: 'delivered' }, createdAt: now },
    ]);
    const response = await recommend(dispatch.id).expect(200);
    const agentRecommendation = response.body.data.recommendations.find(
      (item: { agent: { id: string } }) => item.agent.id === agent.id,
    );
    expect(agentRecommendation.historicalCompletedDeliveries).toBe(10);
    expect(agentRecommendation.historicalMedianDurationMinutes).toBe(25);
  });

  it('returns no recommendations for an ineligible request and rejects terminal requests', async () => {
    const noAgents = await createDispatchRequest();
    const emptyResponse = await recommend(noAgents.id).expect(200);
    expect(emptyResponse.body.data.recommendations).toEqual([]);
    expect(emptyResponse.body.data.predictionStatus).toBe('no_eligible_candidates');
    expect(emptyResponse.body.message).toContain('No eligible agents');

    const delivered = await createDispatchRequest({ status: 'delivered' });
    const rejected = await recommend(delivered.id).expect(409);
    expect(rejected.body.message).toContain('pending or assigned');
  });

  it('returns an honest service-unavailable error when the ML service is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ detail: 'model unavailable' }),
    }) as Response));
    const dispatch = await createDispatchRequest();
    await createAgent();
    const response = await recommend(dispatch.id).expect(503);
    expect(response.body.message).toContain('model is unavailable');
  });

  it('requires an Admin or Operator and leaves dispatch and agent records unchanged', async () => {
    const dispatch = await createDispatchRequest();
    const agent = await createAgent();
    const beforeDispatch = await DispatchRequest.findById(dispatch.id).lean();
    const beforeAgent = await Agent.findById(agent.id).lean();

    await request(app).get(`/api/dispatch-requests/${dispatch.id}/agent-recommendations`).expect(401);
    const response = await recommend(dispatch.id).expect(200);
    expect(response.body.success).toBe(true);
    expect(await DispatchRequest.findById(dispatch.id).lean()).toMatchObject({
      status: beforeDispatch?.status,
      assignedAgent: beforeDispatch?.assignedAgent,
      updatedAt: beforeDispatch?.updatedAt,
    });
    expect(await Agent.findById(agent.id).lean()).toMatchObject({
      activeDispatchCount: beforeAgent?.activeDispatchCount,
      status: beforeAgent?.status,
      updatedAt: beforeAgent?.updatedAt,
    });
  });
});

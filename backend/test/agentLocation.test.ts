import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { AgentActivity } from '../src/models/AgentActivity.js';
import { AgentDeviceCredential } from '../src/models/AgentDeviceCredential.js';
import { AgentLocation } from '../src/models/AgentLocation.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { User } from '../src/models/User.js';
import { ensureAgentCollections } from '../src/services/agentService.js';
import { ensureAgentLocationCollections } from '../src/services/agentLocationService.js';
import { ensureDispatchRequestCollections } from '../src/services/dispatchRequestService.js';
import { createAccessToken } from '../src/utils/jwt.js';
import { createAgentAccessToken } from '../src/utils/agentJwt.js';
import { createHash } from 'node:crypto';

const testSecret = 'swerv-agent-location-tests-secret-0123456789';
const agentInput = {
  name: 'Riley Driver', email: 'riley@example.com', phone: '+1 555 321 9876',
  vehicle: { vehicleType: 'van', registrationNumber: 'GPS-1001', manufacturer: 'Ford', model: 'Transit' },
  capacity: { maxOrders: 5 }, capabilities: ['parcel_delivery'],
};
let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';

function userCookie(id: string) {
  return `swerv_access=${createAccessToken(id)}`;
}

async function createAgent(overrides: Record<string, unknown> = {}) {
  return Agent.create({ ...agentInput, status: 'on_duty', ...overrides, agentCode: `AGT-${new mongoose.Types.ObjectId().toString().slice(-8)}` });
}

async function generateCredential(agentId: string) {
  const response = await request(app)
    .post(`/api/agents/${agentId}/device-credential`)
    .set('Cookie', adminCookie)
    .expect(201);
  return response.body.data.credential as string;
}

function locationInput(overrides: Record<string, unknown> = {}) {
  return {
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 8.5,
    speed: 12,
    heading: 90,
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function createActiveDispatch(agentId: string) {
  return DispatchRequest.create({
    customer: { name: 'Test Customer', email: 'test@example.com', phone: '+1 555 222 3333' },
    pickup: { address: '10 North Street', city: 'Oakland', region: 'CA', postalCode: '94607', country: 'USA' },
    delivery: { address: '20 South Street', city: 'Berkeley', region: 'CA', postalCode: '94704', country: 'USA' },
    package: { description: 'Small parcel', category: 'parcel', weightKg: 2, quantity: 1 },
    assignedAgent: agentId,
    status: 'assigned',
  });
}

function submitLocation(token: string, body = locationInput()) {
  return request(app)
    .post('/api/agent-locations')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = testSecret;
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.AGENT_JWT_SECRET = 'swerv-agent-location-auth-secret-0123456789';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await ensureAgentCollections();
  await ensureAgentLocationCollections();
  await ensureDispatchRequestCollections();
});

beforeEach(async () => {
  await Promise.all([
    Agent.deleteMany({}), AgentActivity.deleteMany({}),
    AgentDeviceCredential.deleteMany({}), AgentLocation.deleteMany({}), User.deleteMany({}),
  ]);
  const [admin, operator] = await User.create([
    { name: 'Admin User', email: 'admin@example.com', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Operator User', email: 'operator@example.com', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  adminCookie = userCookie(admin.id);
  operatorCookie = userCookie(operator.id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('agent location API', () => {
  it('generates a one-time device credential for Admins and stores only its hash', async () => {
    const agent = await createAgent();
    await request(app).post(`/api/agents/${agent.id}/device-credential`).set('Cookie', operatorCookie).expect(403);
    const response = await request(app)
      .post(`/api/agents/${agent.id}/device-credential`)
      .set('Cookie', adminCookie)
      .expect(201);
    const credential = response.body.data.credential as string;
    expect(credential).toMatch(/^swerv_agent_[\w-]+$/);
    expect(response.body.data).not.toHaveProperty('tokenHash');
    const storedCredential = await AgentDeviceCredential.findOne({ agentId: agent.id }).select('+tokenHash');
    expect(storedCredential?.tokenHash).not.toBe(credential);
    expect(storedCredential?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts a valid GPS update and exposes its latest location to Admins and Operators', async () => {
    const agent = await createAgent({ status: 'on_duty' });
    const credential = await generateCredential(agent.id);
    const submitted = await submitLocation(credential).expect(201);
    expect(submitted.body.data.location).toMatchObject({
      agentId: agent.id,
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 8.5,
      speed: 12,
      heading: 90,
    });
    expect(submitted.body.data.location.receivedAt).toBeTruthy();
    expect(await AgentLocation.countDocuments({ agentId: agent.id })).toBe(1);

    const adminLocations = await request(app).get('/api/agent-locations').set('Cookie', adminCookie).expect(200);
    const operatorLocations = await request(app).get('/api/agent-locations').set('Cookie', operatorCookie).expect(200);
    expect(adminLocations.body.data.locations).toHaveLength(1);
    expect(adminLocations.body.data.locations[0].agent).toMatchObject({ _id: agent.id, name: agentInput.name });
    expect(operatorLocations.body.data.locations[0].agentId).toBe(agent.id);
  });

  it('uses an HttpOnly GPS-only cookie for browser location updates and revokes it on stop', async () => {
    const agent = await createAgent({ status: 'on_duty' });
    await createActiveDispatch(agent.id);
    const session = await request(app)
      .post('/api/agent-locations/browser-session')
      .set('Cookie', `swerv_agent_access=${createAgentAccessToken(agent.id)}`)
      .expect(200);

    expect(session.body.data).not.toHaveProperty('credential');
    const setCookie = session.headers['set-cookie'][0] as string;
    expect(setCookie).toContain('swerv_agent_gps=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api/agent-locations');
    const gpsCookie = setCookie.split(';')[0];
    const token = gpsCookie.slice(gpsCookie.indexOf('=') + 1);
    const credential = await AgentDeviceCredential.findOne({ agentId: agent.id, credentialType: 'browser' }).select('+tokenHash');
    expect(credential?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(credential?.expiresAt).toBeInstanceOf(Date);

    await request(app).post('/api/agent-locations/browser').set('Cookie', gpsCookie).send(locationInput()).expect(201);
    await request(app).post('/api/agent-locations/browser').set('Cookie', gpsCookie).send(locationInput()).expect(429);
    await request(app)
      .post('/api/agent-locations/browser')
      .set('Cookie', gpsCookie)
      .send(locationInput({ recordedAt: new Date(Date.now() - 3 * 60_000).toISOString() }))
      .expect(400);
    expect(await AgentLocation.countDocuments({ agentId: agent.id })).toBe(1);
    await request(app).delete('/api/agent-locations/browser-session').set('Cookie', gpsCookie).expect(200);
    expect((await AgentDeviceCredential.findById(credential?._id))?.revokedAt).toBeTruthy();
    await request(app).post('/api/agent-locations/browser').set('Cookie', gpsCookie).send(locationInput()).expect(401);
  });

  it('does not create browser GPS credentials for an off-duty agent without a delivery', async () => {
    const agent = await createAgent({ status: 'available' });
    await request(app)
      .post('/api/agent-locations/browser-session')
      .set('Cookie', `swerv_agent_access=${createAgentAccessToken(agent.id)}`)
      .expect(403);
    expect(await AgentDeviceCredential.countDocuments({ agentId: agent.id, credentialType: 'browser' })).toBe(0);
  });

  it('does not create browser GPS credentials for an on-duty agent without an active delivery', async () => {
    const agent = await createAgent({ status: 'on_duty' });
    await request(app)
      .post('/api/agent-locations/browser-session')
      .set('Cookie', `swerv_agent_access=${createAgentAccessToken(agent.id)}`)
      .expect(403);
  });

  it('invalidates the browser GPS session when an Admin rotates device credentials', async () => {
    const agent = await createAgent({ status: 'on_duty' });
    await createActiveDispatch(agent.id);
    const session = await request(app)
      .post('/api/agent-locations/browser-session')
      .set('Cookie', `swerv_agent_access=${createAgentAccessToken(agent.id)}`)
      .expect(200);
    const gpsCookie = (session.headers['set-cookie'][0] as string).split(';')[0];

    await generateCredential(agent.id);
    await request(app)
      .post('/api/agent-locations/browser')
      .set('Cookie', gpsCookie)
      .send(locationInput())
      .expect(401);
  });

  it('rejects GPS updates when the active agent is off duty and has no active delivery', async () => {
    const agent = await createAgent({ status: 'available' });
    const credential = await generateCredential(agent.id);
    await submitLocation(credential).expect(403);
    expect(await AgentLocation.countDocuments({ agentId: agent.id })).toBe(0);
  });

  it('accepts GPS updates for an available agent with an active assigned delivery', async () => {
    const agent = await createAgent({ status: 'available' });
    await DispatchRequest.create({
      customer: { name: 'Alex Customer', email: 'alex@example.com', phone: '+1 555 222 3333' },
      pickup: { address: '10 North Street', city: 'Oakland', region: 'CA', postalCode: '94607', country: 'USA' },
      delivery: { address: '20 South Street', city: 'Berkeley', region: 'CA', postalCode: '94704', country: 'USA' },
      package: { description: 'Small parcel', category: 'parcel', weightKg: 2, quantity: 1 },
      assignedAgent: agent.id,
      status: 'assigned',
    });
    const credential = await generateCredential(agent.id);
    await submitLocation(credential).expect(201);
  });

  it('rejects missing and invalid Bearer credentials', async () => {
    await createAgent();
    await request(app).get('/api/agent-locations').expect(401);
    await request(app).post('/api/agent-locations').send(locationInput()).expect(401);
    await request(app).post('/api/agent-locations').set('Authorization', 'Bearer not-a-valid-device-key').send(locationInput()).expect(401);
    await request(app).post('/api/agent-locations').set('Authorization', 'Basic something').send(locationInput()).expect(401);
  });

  it('rejects invalid coordinates and optional measurement values', async () => {
    const agent = await createAgent();
    const credential = await generateCredential(agent.id);
    await submitLocation(credential, locationInput({ latitude: 90.01 })).then((response) => expect(response.status).toBe(400));
    await submitLocation(credential, locationInput({ longitude: -181 })).then((response) => expect(response.status).toBe(400));
    await submitLocation(credential, locationInput({ accuracy: -1 })).then((response) => expect(response.status).toBe(400));
    await submitLocation(credential, locationInput({ speed: 1_001 })).then((response) => expect(response.status).toBe(400));
    await submitLocation(credential, locationInput({ heading: 361 })).then((response) => expect(response.status).toBe(400));
    await submitLocation(credential, locationInput({ recordedAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString() })).then((response) => expect(response.status).toBe(400));
    await submitLocation(credential, locationInput({ unexpected: true })).then((response) => expect(response.status).toBe(400));
    expect(await AgentLocation.countDocuments()).toBe(0);
  });

  it('revokes device credentials and rejects them afterward', async () => {
    const agent = await createAgent();
    const credential = await generateCredential(agent.id);
    await request(app).delete(`/api/agents/${agent.id}/device-credential`).set('Cookie', adminCookie).expect(200);
    await submitLocation(credential).expect(401);
    expect((await AgentDeviceCredential.findOne({ agentId: agent.id }))?.revokedAt).toBeTruthy();
  });

  it('rejects credentials for archived agents', async () => {
    const agent = await createAgent();
    const credential = await generateCredential(agent.id);
    await request(app).patch(`/api/agents/${agent.id}/archive`).set('Cookie', adminCookie).expect(200);
    await submitLocation(credential).expect(401);
  });

  it('returns paginated history only to authenticated Admins and Operators', async () => {
    const agent = await createAgent();
    await AgentLocation.insertMany([1, 2, 3].map((day) => ({
      agentId: agent.id,
      latitude: 37 + day / 100,
      longitude: -122.4194,
      recordedAt: new Date(Date.UTC(2026, 0, day)),
      receivedAt: new Date(Date.UTC(2026, 0, day)),
    })));

    const firstPage = await request(app)
      .get(`/api/agent-locations/${agent.id}/history?page=1&limit=2`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(firstPage.body.data.locations).toHaveLength(2);
    expect(firstPage.body.data.pagination).toMatchObject({ page: 1, limit: 2, total: 3, pages: 2 });
    const secondPage = await request(app)
      .get(`/api/agent-locations/${agent.id}/history?page=2&limit=2`)
      .set('Cookie', operatorCookie)
      .expect(200);
    expect(secondPage.body.data.locations).toHaveLength(1);
    await request(app).get(`/api/agent-locations/${agent.id}/history`).expect(401);
    await request(app).get(`/api/agent-locations/not-an-id/history`).set('Cookie', adminCookie).expect(400);
    await request(app).get(`/api/agent-locations/${agent.id}/history?page=1002&limit=100`).set('Cookie', adminCookie).expect(400);
  });

  it('does not expose the latest location for archived agents', async () => {
    const agent = await createAgent();
    const credential = await generateCredential(agent.id);
    await submitLocation(credential).expect(201);
    await request(app).patch(`/api/agents/${agent.id}/archive`).set('Cookie', adminCookie).expect(200);
    const response = await request(app).get('/api/agent-locations').set('Cookie', operatorCookie).expect(200);
    expect(response.body.data.locations).toHaveLength(0);
  });
});

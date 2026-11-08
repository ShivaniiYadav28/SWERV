import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { AgentActivity } from '../src/models/AgentActivity.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { User } from '../src/models/User.js';
import { ensureAgentCollections } from '../src/services/agentService.js';
import { ensureDispatchRequestCollections } from '../src/services/dispatchRequestService.js';
import { createAccessToken } from '../src/utils/jwt.js';

const agentInput = {
  name: 'Morgan Driver', email: 'morgan@example.com', phone: '+1 555 123 4567',
  vehicle: { vehicleType: 'van', registrationNumber: 'DLV-1001', manufacturer: 'Ford', model: 'Transit' },
  capacity: { maxOrders: 5 }, capabilities: ['parcel_delivery'],
};
const deliveryInput = {
  customer: { name: 'Alex Customer', email: 'alex@example.com', phone: '+1 555 222 3333' },
  pickup: { address: '10 North Street', city: 'Oakland', region: 'CA', postalCode: '94607', country: 'USA' },
  delivery: { address: '20 South Street', city: 'Berkeley', region: 'CA', postalCode: '94704', country: 'USA' },
  package: { description: 'Small parcel', category: 'parcel', weightKg: 2, quantity: 1 },
};
const agentPassword = 'SafeDeliveryPass123!';
let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';
let adminId = '';

function userCookie(id: string) { return `swerv_access=${createAccessToken(id)}`; }
async function createAgent(overrides: Record<string, unknown> = {}) {
  return Agent.create({ ...agentInput, ...overrides, agentCode: `AGT-${new mongoose.Types.ObjectId().toString().slice(-8)}` });
}
async function createDelivery(agentId: string, email = 'alex@example.com') {
  const created = await request(app).post('/api/dispatch-requests').set('Cookie', adminCookie)
    .send({ ...deliveryInput, customer: { ...deliveryInput.customer, email } }).expect(201);
  const id = created.body.data.dispatchRequest._id as string;
  await request(app).patch(`/api/dispatch-requests/${id}/assignment`).set('Cookie', adminCookie)
    .send({ agentId }).expect(200);
  return id;
}
function login(email = agentInput.email, password = agentPassword) {
  return request(app).post('/api/agent/auth/login').send({ email, password });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-delivery-user-secret-0123456789-abcdefgh';
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.AGENT_JWT_SECRET = 'swerv-delivery-agent-secret-0123456789-abcdef';
  process.env.AGENT_JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([ensureAgentCollections(), ensureDispatchRequestCollections()]);
});

beforeEach(async () => {
  await Promise.all([Agent.deleteMany({}), AgentActivity.deleteMany({}), DispatchRequest.deleteMany({}), DispatchRequestActivity.deleteMany({}), User.deleteMany({})]);
  const [admin, operator] = await User.create([
    { name: 'Admin User', email: 'admin@example.com', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Operator User', email: 'operator@example.com', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  adminId = admin.id;
  adminCookie = userCookie(admin.id);
  operatorCookie = userCookie(operator.id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('agent delivery API', () => {
  it('allows agent login with an admin-provisioned password and rejects invalid credentials', async () => {
    const agent = await createAgent();
    await request(app).put(`/api/agents/${agent.id}/password`).set('Cookie', adminCookie).send({ password: agentPassword }).expect(200);
    const response = await login().expect(200);
    expect(response.body.data.agent).toMatchObject({ id: agent.id, email: agentInput.email });
    expect(response.body.data.agent).not.toHaveProperty('passwordHash');
    expect(response.headers['set-cookie'][0]).toContain('swerv_agent_access=');
    await login(agentInput.email, 'WrongPassword123!').expect(401);
    await login('missing@example.com', agentPassword).expect(401);
  });

  it('rejects inactive or archived agents and protects the separate session endpoints', async () => {
    const inactive = await createAgent({ isActive: false });
    await request(app).put(`/api/agents/${inactive.id}/password`).set('Cookie', adminCookie).send({ password: agentPassword }).expect(200);
    await login(inactive.email).expect(401);
    const agent = await createAgent({ email: 'active@example.com', vehicle: { ...agentInput.vehicle, registrationNumber: 'DLV-1002' } });
    await request(app).put(`/api/agents/${agent.id}/password`).set('Cookie', adminCookie).send({ password: agentPassword }).expect(200);
    const session = await login('active@example.com').expect(200);
    const cookie = session.headers['set-cookie'][0].split(';')[0];
    const profile = await request(app).get('/api/agent/auth/me').set('Cookie', cookie).expect(200);
    expect(profile.body.data.agent).toMatchObject({ id: agent.id, name: agent.name });
    await request(app).post('/api/agent/auth/logout').set('Cookie', cookie).expect(200);
    await request(app).get('/api/agent/auth/me').expect(401);
    await request(app).patch(`/api/agents/${agent.id}/archive`).set('Cookie', adminCookie).expect(200);
    await request(app).get('/api/agent/auth/me').set('Cookie', cookie).expect(401);
  });

  it('returns only the signed-in agent deliveries and hides other agents requests', async () => {
    const firstAgent = await createAgent();
    const secondAgent = await createAgent({ email: 'second@example.com', vehicle: { ...agentInput.vehicle, registrationNumber: 'DLV-2002' } });
    const ownId = await createDelivery(firstAgent.id);
    await createDelivery(secondAgent.id, 'other@example.com');
    await request(app).put(`/api/agents/${firstAgent.id}/password`).set('Cookie', adminCookie).send({ password: agentPassword }).expect(200);
    const session = await login().expect(200);
    const cookie = session.headers['set-cookie'][0].split(';')[0];
    const list = await request(app).get('/api/agent/deliveries').set('Cookie', cookie).expect(200);
    expect(list.body.data.deliveries.map((delivery: { _id: string }) => delivery._id)).toEqual([ownId]);
    expect(list.body.data.deliveries[0].pickup.address).toBe(deliveryInput.pickup.address);
    await request(app).get(`/api/agent/deliveries/${ownId}`).set('Cookie', cookie).expect(200);
    const otherId = (await DispatchRequest.findOne({ assignedAgent: secondAgent.id }))!.id;
    await request(app).get(`/api/agent/deliveries/${otherId}`).set('Cookie', cookie).expect(404);
  });

  it('allows only the assigned agent to progress through permitted delivery states', async () => {
    const firstAgent = await createAgent();
    const secondAgent = await createAgent({ email: 'second@example.com', vehicle: { ...agentInput.vehicle, registrationNumber: 'DLV-3003' } });
    const id = await createDelivery(firstAgent.id);
    await request(app).put(`/api/agents/${firstAgent.id}/password`).set('Cookie', adminCookie).send({ password: agentPassword }).expect(200);
    await request(app).put(`/api/agents/${secondAgent.id}/password`).set('Cookie', adminCookie).send({ password: agentPassword }).expect(200);
    const firstCookie = (await login()).headers['set-cookie'][0].split(';')[0];
    const secondCookie = (await login('second@example.com')).headers['set-cookie'][0].split(';')[0];
    await request(app).patch(`/api/agent/deliveries/${id}/status`).set('Cookie', secondCookie).send({ status: 'picked_up' }).expect(404);
    await request(app).patch(`/api/agent/deliveries/${id}/status`).set('Cookie', firstCookie).send({ status: 'delivered' }).expect(400);
    await request(app).patch(`/api/agent/deliveries/${id}/status`).set('Cookie', firstCookie).send({ status: 'cancelled' }).expect(400);
    await request(app).patch(`/api/agent/deliveries/${id}/status`).set('Cookie', firstCookie).send({ status: 'picked_up' }).expect(200);
    await request(app).patch(`/api/agent/deliveries/${id}/status`).set('Cookie', firstCookie).send({ status: 'in_transit' }).expect(200);
    await request(app).patch(`/api/agent/deliveries/${id}/status`).set('Cookie', firstCookie).send({ status: 'delivered' }).expect(200);
    await request(app).patch(`/api/agent/deliveries/${id}/status`).set('Cookie', firstCookie).send({ status: 'in_transit' }).expect(400);
    expect(await DispatchRequestActivity.countDocuments({ dispatchRequestId: id, actorType: 'agent', performedByAgent: firstAgent.id })).toBe(3);
    const history = await request(app).get('/api/agent/deliveries/history').set('Cookie', firstCookie).expect(200);
    expect(history.body.data.deliveries.map((delivery: { _id: string }) => delivery._id)).toEqual([id]);
    expect((await Agent.findById(firstAgent.id))?.activeDispatchCount).toBe(0);
  });

  it('keeps admin and operator dispatch access while requiring an agent session for agent routes', async () => {
    await request(app).get('/api/agent/deliveries').expect(401);
    await request(app).get('/api/dispatch-requests').set('Cookie', adminCookie).expect(200);
    await request(app).get('/api/dispatch-requests').set('Cookie', operatorCookie).expect(200);
    await request(app).put('/api/agents/not-an-id/password').set('Cookie', operatorCookie).send({ password: agentPassword }).expect(403);
    expect(adminId).toBeTruthy();
  });
});

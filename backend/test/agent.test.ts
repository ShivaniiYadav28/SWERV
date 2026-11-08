import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { AgentActivity } from '../src/models/AgentActivity.js';
import { User } from '../src/models/User.js';
import { ensureAgentCollections } from '../src/services/agentService.js';
import { createAccessToken } from '../src/utils/jwt.js';

let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';
let adminId = '';
let operatorId = '';
const sample = {
  name: 'Morgan Lee', email: 'morgan@example.com', phone: '+1 555 123 4567',
  vehicle: { vehicleType: 'van', registrationNumber: 'SW-1234', manufacturer: 'Ford', model: 'Transit' },
  capacity: { maxOrders: 12 }, capabilities: ['parcel_delivery', 'express_delivery'],
};

function cookie(id: string) { return `swerv_access=${createAccessToken(id)}`; }
async function createSample(overrides: Record<string, unknown> = {}) {
  const response = await request(app).post('/api/agents').set('Cookie', adminCookie).send({ ...sample, ...overrides });
  return response;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-agent-tests-secret-0123456789-abcdefghijkl';
  process.env.JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await ensureAgentCollections();
});

beforeEach(async () => {
  await Promise.all([Agent.deleteMany({}), AgentActivity.deleteMany({}), User.deleteMany({})]);
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

describe('fleet agent API', () => {
  it('keeps the existing health endpoint available', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.success).toBe(true);
  });

  it('allows an admin to create an agent and generates the agent code', async () => {
    const response = await createSample();
    expect(response.status).toBe(201);
    expect(response.body.data.agent.agentCode).toMatch(/^AGT-[A-F0-9]+$/);
    expect(response.body.data.agent.status).toBe('available');
  });
  it('prevents an operator from creating agents', async () => {
    await request(app).post('/api/agents').set('Cookie', operatorCookie).send(sample).expect(403);
  });
  it('requires authentication to view agents', async () => {
    await request(app).get('/api/agents').expect(401);
  });
  it('lists agents for an operator', async () => {
    await createSample();
    const response = await request(app).get('/api/agents').set('Cookie', operatorCookie).expect(200);
    expect(response.body.data.agents).toHaveLength(1);
  });
  it('paginates results with a bounded page size', async () => {
    await createSample();
    await createSample({ email: 'second@example.com', vehicle: { ...sample.vehicle, registrationNumber: 'SW-2234' } });
    const response = await request(app).get('/api/agents?page=1&limit=1').set('Cookie', adminCookie).expect(200);
    expect(response.body.data.agents).toHaveLength(1);
    expect(response.body.data.pagination).toMatchObject({ page: 1, limit: 1, total: 2, pages: 2 });
  });
  it('searches by name, email, or generated code', async () => {
    const created = await createSample();
    const code = created.body.data.agent.agentCode;
    const response = await request(app).get(`/api/agents?search=${code}`).set('Cookie', adminCookie).expect(200);
    expect(response.body.data.agents).toHaveLength(1);
  });
  it('filters agents by operational status', async () => {
    await createSample();
    const response = await request(app).get('/api/agents?status=available').set('Cookie', adminCookie).expect(200);
    expect(response.body.data.agents).toHaveLength(1);
  });
  it('filters agents by capability', async () => {
    await createSample();
    const response = await request(app).get('/api/agents?capability=express_delivery').set('Cookie', adminCookie).expect(200);
    expect(response.body.data.agents).toHaveLength(1);
  });
  it('filters agents by vehicle type', async () => {
    await createSample();
    const response = await request(app).get('/api/agents?vehicleType=van').set('Cookie', adminCookie).expect(200);
    expect(response.body.data.agents).toHaveLength(1);
  });
  it('returns one agent with recent activity', async () => {
    const created = await createSample();
    const id = created.body.data.agent._id;
    const response = await request(app).get(`/api/agents/${id}`).set('Cookie', operatorCookie).expect(200);
    expect(response.body.data.agent._id).toBe(id);
    expect(response.body.data.activity[0].eventType).toBe('agent_created');
  });
  it('updates agent information as an admin', async () => {
    const created = await createSample();
    const response = await request(app).patch(`/api/agents/${created.body.data.agent._id}`).set('Cookie', adminCookie).send({ phone: '+1 555 888 9999' }).expect(200);
    expect(response.body.data.agent.phone).toBe('+1 555 888 9999');
  });
  it('rejects protected fields on ordinary updates', async () => {
    const created = await createSample();
    await request(app).patch(`/api/agents/${created.body.data.agent._id}`).set('Cookie', adminCookie).send({ isActive: false }).expect(400);
  });
  it('prevents operators from editing agent details', async () => {
    const created = await createSample();
    await request(app).patch(`/api/agents/${created.body.data.agent._id}`).set('Cookie', operatorCookie).send({ phone: '+1 555 888 9999' }).expect(403);
  });
  it('allows an operator to change an available agent to on duty', async () => {
    const created = await createSample();
    const response = await request(app).patch(`/api/agents/${created.body.data.agent._id}/status`).set('Cookie', operatorCookie).send({ status: 'on_duty' }).expect(200);
    expect(response.body.data.agent.status).toBe('on_duty');
  });
  it('allows an operator to mark an on-duty agent available and records the change', async () => {
    const created = await createSample();
    const id = created.body.data.agent._id;
    await request(app)
      .patch(`/api/agents/${id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'on_duty' })
      .expect(200);

    const response = await request(app)
      .patch(`/api/agents/${id}/status`)
      .set('Cookie', operatorCookie)
      .send({ status: 'available' })
      .expect(200);

    expect(response.body.data.agent.status).toBe('available');
    const event = await AgentActivity.findOne({
      agentId: id,
      eventType: 'status_changed',
      'newValue.status': 'available',
    });
    expect(event?.previousValue).toMatchObject({ status: 'on_duty' });
    expect(event?.performedBy.toString()).toBe(operatorId);
  });
  it('rejects an invalid status transition', async () => {
    const created = await createSample();
    await request(app).patch(`/api/agents/${created.body.data.agent._id}/status`).set('Cookie', operatorCookie).send({ status: 'available' }).expect(400);
  });
  it('does not allow a suspended agent to become available directly', async () => {
    const created = await createSample();
    const id = created.body.data.agent._id;
    await request(app)
      .patch(`/api/agents/${id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'suspended' })
      .expect(200);

    await request(app)
      .patch(`/api/agents/${id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'available' })
      .expect(400);
  });
  it('does not allow status changes for archived agents', async () => {
    const created = await createSample();
    const id = created.body.data.agent._id;
    await request(app)
      .patch(`/api/agents/${id}/archive`)
      .set('Cookie', adminCookie)
      .expect(200);

    await request(app)
      .patch(`/api/agents/${id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'available' })
      .expect(404);
  });
  it('prevents operators from suspending an agent', async () => {
    const created = await createSample();
    await request(app).patch(`/api/agents/${created.body.data.agent._id}/status`).set('Cookie', operatorCookie).send({ status: 'suspended' }).expect(403);
  });
  it('archives an agent and records the event', async () => {
    const created = await createSample();
    const id = created.body.data.agent._id;
    await request(app).patch(`/api/agents/${id}/archive`).set('Cookie', adminCookie).expect(200);
    expect(await AgentActivity.countDocuments({ agentId: id, eventType: 'agent_archived' })).toBe(1);
  });
  it('restores an archived agent and records the authenticated admin', async () => {
    const created = await createSample();
    const id = created.body.data.agent._id;
    await request(app).patch(`/api/agents/${id}/archive`).set('Cookie', adminCookie).expect(200);

    const response = await request(app)
      .patch(`/api/agents/${id}/restore`)
      .set('Cookie', adminCookie)
      .expect(200);

    expect(response.body.data.agent.isActive).toBe(true);
    const activity = await AgentActivity.findOne({ agentId: id, eventType: 'agent_restored' });
    expect(activity?.performedBy.toString()).toBe(adminId);
  });
  it('prevents operators from restoring archived agents', async () => {
    const created = await createSample();
    const id = created.body.data.agent._id;
    await request(app).patch(`/api/agents/${id}/archive`).set('Cookie', adminCookie).expect(200);
    await request(app).patch(`/api/agents/${id}/restore`).set('Cookie', operatorCookie).expect(403);
  });
  it('requires authentication to restore an agent', async () => {
    await request(app).patch(`/api/agents/${new mongoose.Types.ObjectId()}/restore`).expect(401);
  });
  it('rejects invalid and missing IDs when restoring an agent', async () => {
    await request(app).patch('/api/agents/not-an-object-id/restore').set('Cookie', adminCookie).expect(400);
    await request(app).patch(`/api/agents/${new mongoose.Types.ObjectId()}/restore`).set('Cookie', adminCookie).expect(404);
  });
  it('rejects restoring an agent that is already active', async () => {
    const created = await createSample();
    await request(app)
      .patch(`/api/agents/${created.body.data.agent._id}/restore`)
      .set('Cookie', adminCookie)
      .expect(409);
  });
  it('omits archived agents from the default list and includes them on request', async () => {
    const created = await createSample();
    await request(app).patch(`/api/agents/${created.body.data.agent._id}/archive`).set('Cookie', adminCookie).expect(200);
    const active = await request(app).get('/api/agents').set('Cookie', adminCookie).expect(200);
    const archived = await request(app).get('/api/agents?isActive=false').set('Cookie', adminCookie).expect(200);
    expect(active.body.data.agents).toHaveLength(0);
    expect(archived.body.data.agents).toHaveLength(1);
  });
  it('rejects duplicate email addresses', async () => {
    expect((await createSample()).status).toBe(201);
    expect((await createSample({ vehicle: { ...sample.vehicle, registrationNumber: 'SW-2234' } })).status).toBe(409);
  });
  it('rejects duplicate vehicle registrations', async () => {
    expect((await createSample()).status).toBe(201);
    expect((await createSample({ email: 'other@example.com' })).status).toBe(409);
  });
  it('returns a client error for an invalid MongoDB ID', async () => {
    await request(app).get('/api/agents/not-an-object-id').set('Cookie', adminCookie).expect(400);
  });
  it('records the authenticated user for create, update, and status history', async () => {
    const created = await createSample();
    const id = created.body.data.agent._id;
    await request(app).patch(`/api/agents/${id}`).set('Cookie', adminCookie).send({ phone: '+1 555 888 9999' }).expect(200);
    await request(app).patch(`/api/agents/${id}/status`).set('Cookie', operatorCookie).send({ status: 'on_duty' }).expect(200);
    const events = await AgentActivity.find({ agentId: id }).sort({ createdAt: 1 });
    expect(events.map((event) => event.eventType)).toEqual(['agent_created', 'agent_updated', 'status_changed']);
    expect(events[2].performedBy.toString()).not.toBe(events[0].performedBy.toString());
  });
});

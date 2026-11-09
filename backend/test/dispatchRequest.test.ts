import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { User } from '../src/models/User.js';
import {
  canTransitionDispatchStatus,
  ensureDispatchRequestCollections,
} from '../src/services/dispatchRequestService.js';
import { createAccessToken } from '../src/utils/jwt.js';

let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';
let adminId = '';
let operatorId = '';

const validRequest = {
  customer: {
    name: 'Alex Customer',
    email: 'ALEX@example.com',
    phone: '+1 555 234 5678',
  },
  pickup: {
    address: '10 North Street',
    city: 'Portland',
    region: 'Oregon',
    postalCode: '97201',
    country: 'United States',
    instructions: 'Use the side entrance.',
  },
  delivery: {
    address: '25 River Road',
    city: 'Portland',
    region: 'Oregon',
    postalCode: '97202',
    country: 'United States',
  },
  package: {
    description: 'Small boxed item',
    category: 'parcel',
    weightKg: 2.5,
    quantity: 1,
  },
};

function cookie(userId: string) {
  return `swerv_access=${createAccessToken(userId)}`;
}

async function createRequest(input: Record<string, unknown> = {}) {
  const response = await request(app)
    .post('/api/dispatch-requests')
    .set('Cookie', adminCookie)
    .send({ ...validRequest, ...input })
    .expect(201);
  return response.body.data.dispatchRequest;
}

async function createAgent(overrides: Record<string, unknown> = {}) {
  return Agent.create({
    agentCode: `AGT-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
    name: 'Taylor Driver',
    email: `driver-${new mongoose.Types.ObjectId()}@example.com`,
    phone: '+1 555 111 2222',
    vehicle: {
      vehicleType: 'van',
      registrationNumber: `SW-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      manufacturer: 'Ford',
      model: 'Transit',
    },
    capacity: { maxOrders: 4 },
    capabilities: ['parcel_delivery', 'express_delivery'],
    ...overrides,
  });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-dispatch-tests-secret-0123456789-abcdefghijkl';
  process.env.JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await ensureDispatchRequestCollections();
});

beforeEach(async () => {
  await Promise.all([
    DispatchRequest.deleteMany({}),
    DispatchRequestActivity.deleteMany({}),
    Agent.deleteMany({}),
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

describe('dispatch request foundation', () => {
  it('validates required model fields and applies lifecycle defaults', async () => {
    const dispatchRequest = new DispatchRequest(validRequest);
    await expect(dispatchRequest.validate()).resolves.toBeUndefined();
    expect(dispatchRequest.status).toBe('pending');
    expect(dispatchRequest.priority).toBe('standard');
    expect(dispatchRequest.assignedAgent).toBeNull();
  });

  it('rejects an invalid model status', async () => {
    const dispatchRequest = new DispatchRequest(validRequest);
    dispatchRequest.set('status', 'queued');
    await expect(dispatchRequest.validate()).rejects.toHaveProperty('errors.status');
  });

  it('rejects incomplete customer and package details', async () => {
    const dispatchRequest = new DispatchRequest({
      ...validRequest,
      customer: { name: 'Alex Customer' },
      package: { description: 'Parcel', category: 'unknown', weightKg: 0 },
    });
    await expect(dispatchRequest.validate()).rejects.toBeTruthy();
  });

  it('rejects requests that omit required customer, location, or package fields', async () => {
    const incompleteRequests = [
      { ...validRequest, customer: undefined },
      { ...validRequest, pickup: { ...validRequest.pickup, address: undefined } },
      { ...validRequest, package: { ...validRequest.package, quantity: undefined } },
    ];

    for (const body of incompleteRequests) {
      await request(app)
        .post('/api/dispatch-requests')
        .set('Cookie', adminCookie)
        .send(body)
        .expect(400);
    }
  });

  it('stores valid pickup and delivery coordinates while keeping them optional', async () => {
    const requestWithCoordinates = await createRequest({
      pickup: { ...validRequest.pickup, latitude: 45.5231, longitude: -122.6765 },
      delivery: { ...validRequest.delivery, latitude: 45.5152, longitude: -122.6784 },
    });
    expect(requestWithCoordinates.pickup).toMatchObject({ latitude: 45.5231, longitude: -122.6765 });
    expect(requestWithCoordinates.delivery).toMatchObject({ latitude: 45.5152, longitude: -122.6784 });

    const requestWithoutCoordinates = await createRequest({
      customer: { ...validRequest.customer, email: 'legacy-request@example.com' },
    });
    expect(requestWithoutCoordinates.pickup.latitude).toBeUndefined();
    expect(requestWithoutCoordinates.delivery.longitude).toBeUndefined();
  });

  it('rejects out-of-range or incomplete coordinate pairs', async () => {
    const invalidRequests = [
      { ...validRequest, pickup: { ...validRequest.pickup, latitude: 90.1, longitude: 0 } },
      { ...validRequest, delivery: { ...validRequest.delivery, latitude: 0, longitude: -180.1 } },
      { ...validRequest, pickup: { ...validRequest.pickup, latitude: 45 } },
    ];
    for (const body of invalidRequests) {
      await request(app)
        .post('/api/dispatch-requests')
        .set('Cookie', adminCookie)
        .send(body)
        .expect(400);
    }
  });

  it('lets Admins and Operators update map coordinates before pickup and clear a point', async () => {
    const dispatchRequest = await createRequest();
    const updated = await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/coordinates`)
      .set('Cookie', operatorCookie)
      .send({
        pickup: { latitude: 45.5231, longitude: -122.6765 },
        delivery: { latitude: 45.5152, longitude: -122.6784 },
      })
      .expect(200);
    expect(updated.body.data.dispatchRequest.pickup).toMatchObject({ latitude: 45.5231, longitude: -122.6765 });
    expect(updated.body.data.dispatchRequest.delivery).toMatchObject({ latitude: 45.5152, longitude: -122.6784 });

    const cleared = await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/coordinates`)
      .set('Cookie', adminCookie)
      .send({ pickup: { latitude: null, longitude: null } })
      .expect(200);
    expect(cleared.body.data.dispatchRequest.pickup.latitude).toBeNull();
    expect(cleared.body.data.dispatchRequest.delivery.latitude).toBe(45.5152);
  });

  it('requires authentication and only permits coordinate edits before pickup', async () => {
    const dispatchRequest = await createRequest();
    const update = { pickup: { latitude: 45, longitude: -122 } };
    await request(app).patch(`/api/dispatch-requests/${dispatchRequest._id}/coordinates`).send(update).expect(401);
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/coordinates`)
      .set('Cookie', adminCookie)
      .send({ pickup: { latitude: 91, longitude: -122 } })
      .expect(400);
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'cancelled' })
      .expect(200);
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/coordinates`)
      .set('Cookie', adminCookie)
      .send(update)
      .expect(409);
  });

  it('rejects invalid package weights and quantities', async () => {
    const invalidPackages = [
      { ...validRequest.package, weightKg: 0 },
      { ...validRequest.package, weightKg: '2.5' },
      { ...validRequest.package, quantity: 1.5 },
    ];

    for (const packageDetails of invalidPackages) {
      await request(app)
        .post('/api/dispatch-requests')
        .set('Cookie', adminCookie)
        .send({ ...validRequest, package: packageDetails })
        .expect(400);
    }
  });

  it('rejects priority values outside the supported set', async () => {
    await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send({ ...validRequest, priority: 'high' })
      .expect(400);
  });

  it('rejects unexpected location and request fields', async () => {
    await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send({
        ...validRequest,
        pickup: { ...validRequest.pickup, addressLine1: 'Unexpected alias' },
      })
      .expect(400);
    await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send({ ...validRequest, assignedAgent: new mongoose.Types.ObjectId() })
      .expect(400);
  });

  it('allows only valid lifecycle transitions and leaves terminal statuses closed', () => {
    expect(canTransitionDispatchStatus('pending', 'assigned')).toBe(true);
    expect(canTransitionDispatchStatus('pending', 'delivered')).toBe(false);
    expect(canTransitionDispatchStatus('in_transit', 'delivered')).toBe(true);
    expect(canTransitionDispatchStatus('delivered', 'cancelled')).toBe(false);
  });

  it('creates a request with normalized customer email and default values', async () => {
    const response = await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send(validRequest)
      .expect(201);

    expect(response.body.data.dispatchRequest).toMatchObject({
      customer: { email: 'alex@example.com' },
      status: 'pending',
      priority: 'standard',
      assignedAgent: null,
    });
    const activity = await DispatchRequestActivity.findOne({
      dispatchRequestId: response.body.data.dispatchRequest._id,
      eventType: 'request_created',
    });
    expect(activity).toMatchObject({
      description: 'Dispatch request created.',
      performedBy: new mongoose.Types.ObjectId(adminId),
      previousValue: null,
      newValue: { status: 'pending' },
    });
    expect(activity?.createdAt).toBeInstanceOf(Date);
  });

  it('creates a request using an explicitly supported priority', async () => {
    const response = await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send({ ...validRequest, priority: 'urgent' })
      .expect(201);

    expect(response.body.data.dispatchRequest.priority).toBe('urgent');
    expect(response.body.data.dispatchRequest.pickup.address).toBe('10 North Street');
  });

  it('accepts a validated priority and returns the created request by ID', async () => {
    const created = await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', operatorCookie)
      .send({ ...validRequest, priority: 'express' })
      .expect(201);
    const id = created.body.data.dispatchRequest._id;

    const response = await request(app)
      .get(`/api/dispatch-requests/${id}`)
      .set('Cookie', operatorCookie)
      .expect(200);

    expect(response.body.data.dispatchRequest).toMatchObject({
      _id: id,
      priority: 'express',
      customer: { name: 'Alex Customer' },
    });
    expect(response.body.data.activity).toHaveLength(1);
    expect(response.body.data.activity[0]).toMatchObject({
      eventType: 'request_created',
      performedBy: {
        _id: operatorId,
        name: 'Operator User',
        email: 'operator@example.com',
      },
    });
  });

  it('returns recent assignment and status activity with actor details', async () => {
    const dispatchRequest = await createRequest();
    const agent = await createAgent();
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: agent.id })
      .expect(200);
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/status`)
      .set('Cookie', operatorCookie)
      .send({ status: 'picked_up' })
      .expect(200);

    const response = await request(app)
      .get(`/api/dispatch-requests/${dispatchRequest._id}`)
      .set('Cookie', adminCookie)
      .expect(200);
    const { dispatchRequest: returnedRequest, activity } = response.body.data;
    const pickedUpEvent = activity.find(
      (event: { eventType: string; newValue?: { status?: string } }) =>
        event.eventType === 'status_changed' && event.newValue?.status === 'picked_up',
    );

    expect(returnedRequest.assignedAgent).toMatchObject({
      _id: agent.id,
      agentCode: agent.agentCode,
    });
    expect(activity).toHaveLength(4);
    expect(pickedUpEvent).toMatchObject({
      eventType: 'status_changed',
      description: 'Status changed from assigned to picked_up.',
      performedBy: {
        _id: operatorId,
        name: 'Operator User',
        email: 'operator@example.com',
      },
      previousValue: { status: 'assigned' },
      newValue: { status: 'picked_up' },
    });
    expect(pickedUpEvent.createdAt).toBeTruthy();
  });

  it('lists dispatch requests with bounded pagination and filters', async () => {
    await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send(validRequest)
      .expect(201);
    await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send({ ...validRequest, customer: { ...validRequest.customer, email: 'other@example.com' }, priority: 'urgent' })
      .expect(201);

    const response = await request(app)
      .get('/api/dispatch-requests?page=1&limit=1&priority=urgent')
      .set('Cookie', adminCookie)
      .expect(200);

    expect(response.body.data.dispatchRequests).toHaveLength(1);
    expect(response.body.data.dispatchRequests[0].priority).toBe('urgent');
    expect(response.body.data.pagination).toMatchObject({ page: 1, limit: 1, total: 1, pages: 1 });
  });

  it('rejects unauthenticated create and list requests', async () => {
    await request(app).post('/api/dispatch-requests').send(validRequest).expect(401);
    await request(app).get('/api/dispatch-requests').expect(401);
  });

  it('allows both application roles to retrieve requests', async () => {
    const created = await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send(validRequest)
      .expect(201);
    const id = created.body.data.dispatchRequest._id;

    await request(app).get(`/api/dispatch-requests/${id}`).set('Cookie', adminCookie).expect(200);
    await request(app).get(`/api/dispatch-requests/${id}`).set('Cookie', operatorCookie).expect(200);
  });

  it('returns 400 for an invalid ID and 404 for a missing request', async () => {
    await request(app)
      .get('/api/dispatch-requests/not-an-object-id')
      .set('Cookie', adminCookie)
      .expect(400);
    await request(app)
      .get(`/api/dispatch-requests/${new mongoose.Types.ObjectId()}`)
      .set('Cookie', adminCookie)
      .expect(404);
  });

  it('rejects unknown request fields and invalid values', async () => {
    await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send({ ...validRequest, assignedAgent: new mongoose.Types.ObjectId() })
      .expect(400);
    await request(app)
      .post('/api/dispatch-requests')
      .set('Cookie', adminCookie)
      .send({ ...validRequest, priority: 'immediate' })
      .expect(400);
  });

  it('allows an admin to assign an eligible agent and records both events', async () => {
    const dispatchRequest = await createRequest();
    const agent = await createAgent();

    const response = await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: agent.id })
      .expect(200);

    expect(response.body.data.dispatchRequest).toMatchObject({
      status: 'assigned',
      assignedAgent: agent.id,
    });
    const events = await DispatchRequestActivity.find({
      dispatchRequestId: dispatchRequest._id,
    }).sort({ createdAt: 1 });
    expect(events.map((event) => event.eventType)).toEqual([
      'request_created',
      'assignment_changed',
      'status_changed',
    ]);
    expect(events.every((event) => event.performedBy.toString() === adminId)).toBe(true);
  });

  it('stores an immutable snapshot of request coordinates on assignment', async () => {
    const dispatchRequest = await createRequest({
      pickup: { ...validRequest.pickup, latitude: 45.523, longitude: -122.676 },
      delivery: { ...validRequest.delivery, latitude: 45.51, longitude: -122.65 },
    });
    const agent = await createAgent();
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: agent.id })
      .expect(200);

    const assignmentEvent = await DispatchRequestActivity.findOne({
      dispatchRequestId: dispatchRequest._id,
      eventType: 'assignment_changed',
    });
    expect(assignmentEvent?.newValue).toMatchObject({
      agentId: agent.id,
      coordinates: {
        pickup: { latitude: 45.523, longitude: -122.676 },
        destination: { latitude: 45.51, longitude: -122.65 },
      },
    });

    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/coordinates`)
      .set('Cookie', adminCookie)
      .send({
        pickup: { latitude: 44.0, longitude: -121.0 },
        delivery: { latitude: 44.1, longitude: -121.1 },
      })
      .expect(200);

    const unchangedEvent = await DispatchRequestActivity.findById(assignmentEvent?._id);
    expect(unchangedEvent?.newValue).toMatchObject({
      coordinates: {
        pickup: { latitude: 45.523, longitude: -122.676 },
        destination: { latitude: 45.51, longitude: -122.65 },
      },
    });
  });

  it('allows an operator to assign a request', async () => {
    const dispatchRequest = await createRequest();
    const agent = await createAgent();

    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', operatorCookie)
      .send({ agentId: agent.id })
      .expect(200);
    const event = await DispatchRequestActivity.findOne({
      dispatchRequestId: dispatchRequest._id,
      eventType: 'assignment_changed',
    });
    expect(event?.performedBy.toString()).toBe(operatorId);
  });

  it('requires authentication to assign an agent', async () => {
    const dispatchRequest = await createRequest();
    const agent = await createAgent();

    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .send({ agentId: agent.id })
      .expect(401);
  });

  it('rejects an unknown agent ID and a malformed assignment body', async () => {
    const dispatchRequest = await createRequest();

    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: new mongoose.Types.ObjectId() })
      .expect(404);
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: 'bad-id' })
      .expect(400);
  });

  it('rejects assignments to inactive or unavailable agents', async () => {
    const dispatchRequest = await createRequest();
    const inactiveAgent = await createAgent({ isActive: false });
    const busyAgent = await createAgent({ status: 'on_duty' });

    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: inactiveAgent.id })
      .expect(409);
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: busyAgent.id })
      .expect(409);
  });

  it('requires capabilities for the package category and priority', async () => {
    const dispatchRequest = await createRequest({
      package: { ...validRequest.package, category: 'food' },
      priority: 'express',
    });
    const agent = await createAgent({ capabilities: ['parcel_delivery'] });

    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: agent.id })
      .expect(400);
  });

  it('enforces the agent order capacity', async () => {
    const agent = await createAgent({ capacity: { maxOrders: 1 } });
    const first = await createRequest();
    const second = await createRequest({
      customer: { ...validRequest.customer, email: 'second-customer@example.com' },
    });

    await request(app)
      .patch(`/api/dispatch-requests/${first._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: agent.id })
      .expect(200);
    await request(app)
      .patch(`/api/dispatch-requests/${second._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: agent.id })
      .expect(409);
    const updatedAgent = await Agent.findById(agent.id);
    expect(updatedAgent?.activeDispatchCount).toBe(1);
  });

  it('reassigns a request and releases capacity on the previous agent', async () => {
    const dispatchRequest = await createRequest();
    const originalAgent = await createAgent({ capacity: { maxOrders: 1 } });
    const replacementAgent = await createAgent({ capacity: { maxOrders: 1 } });

    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: originalAgent.id })
      .expect(200);
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', operatorCookie)
      .send({ agentId: replacementAgent.id })
      .expect(200);

    const [updatedOriginal, updatedReplacement] = await Promise.all([
      Agent.findById(originalAgent.id),
      Agent.findById(replacementAgent.id),
    ]);
    expect(updatedOriginal?.activeDispatchCount).toBe(0);
    expect(updatedReplacement?.activeDispatchCount).toBe(1);
    const reassignment = await DispatchRequestActivity.findOne({
      dispatchRequestId: dispatchRequest._id,
      eventType: 'assignment_changed',
    }).sort({ createdAt: -1 });
    expect(reassignment?.previousValue).toMatchObject({ agentId: originalAgent.id });
    expect(reassignment?.newValue).toMatchObject({ agentId: replacementAgent.id });
  });

  it('does not allow assigning a terminal request', async () => {
    const dispatchRequest = await createRequest();
    const agent = await createAgent();
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'cancelled' })
      .expect(200);

    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: agent.id })
      .expect(409);
  });

  it('lets operators make a valid status change and records the actor', async () => {
    const dispatchRequest = await createRequest();
    const agent = await createAgent();
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: agent.id })
      .expect(200);

    const response = await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/status`)
      .set('Cookie', operatorCookie)
      .send({ status: 'picked_up' })
      .expect(200);

    expect(response.body.data.dispatchRequest.status).toBe('picked_up');
    const event = await DispatchRequestActivity.findOne({
      dispatchRequestId: dispatchRequest._id,
      eventType: 'status_changed',
    }).sort({ createdAt: -1 });
    expect(event?.performedBy.toString()).toBe(operatorId);
  });

  it('rejects invalid transitions and direct assignment status changes', async () => {
    const dispatchRequest = await createRequest();
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'delivered' })
      .expect(409);
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'assigned' })
      .expect(400);
  });

  it('requires authentication to change status', async () => {
    const dispatchRequest = await createRequest();
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/status`)
      .send({ status: 'cancelled' })
      .expect(401);
  });

  it('releases assigned capacity when a request reaches a terminal state', async () => {
    const dispatchRequest = await createRequest();
    const agent = await createAgent({ capacity: { maxOrders: 1 } });
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/assignment`)
      .set('Cookie', adminCookie)
      .send({ agentId: agent.id })
      .expect(200);
    await request(app)
      .patch(`/api/dispatch-requests/${dispatchRequest._id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'cancelled' })
      .expect(200);

    const updatedAgent = await Agent.findById(agent.id);
    expect(updatedAgent?.activeDispatchCount).toBe(0);
  });

  it('allows only one concurrent assignment to consume the final capacity slot', async () => {
    const agent = await createAgent({ capacity: { maxOrders: 1 } });
    const first = await createRequest();
    const second = await createRequest({
      customer: { ...validRequest.customer, email: 'parallel-customer@example.com' },
    });
    const assignments = await Promise.all([
      request(app)
        .patch(`/api/dispatch-requests/${first._id}/assignment`)
        .set('Cookie', adminCookie)
        .send({ agentId: agent.id }),
      request(app)
        .patch(`/api/dispatch-requests/${second._id}/assignment`)
        .set('Cookie', adminCookie)
        .send({ agentId: agent.id }),
    ]);

    expect(assignments.map((response) => response.status).sort()).toEqual([200, 409]);
    const updatedAgent = await Agent.findById(agent.id);
    expect(updatedAgent?.activeDispatchCount).toBe(1);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { Notification } from '../src/models/Notification.js';
import { ProofOfDeliveryDraft } from '../src/models/ProofOfDelivery.js';
import { User } from '../src/models/User.js';
import { createUserNotifications } from '../src/services/notificationService.js';
import { submitProofOfDelivery } from '../src/services/proofOfDeliveryService.js';
import { createAccessToken } from '../src/utils/jwt.js';
import { createAgentAccessToken } from '../src/utils/agentJwt.js';

let mongo: MongoMemoryReplSet;
let adminId = '';
let operatorId = '';
let agentId = '';
let secondAgentId = '';
let adminCookie = '';
let operatorCookie = '';
let agentCookie = '';

function userCookie(userId: string) { return `swerv_access=${createAccessToken(userId)}`; }
function agentAuthCookie(agent: string) { return `swerv_agent_access=${createAgentAccessToken(agent)}`; }

const dispatchInput = {
  customer: { name: 'Test Customer', email: 'test-customer@example.test', phone: '+1 555 333 4444' },
  pickup: { address: 'Pickup point', city: 'Bengaluru', region: 'KA', postalCode: '560001', country: 'India' },
  delivery: { address: 'Delivery point', city: 'Bengaluru', region: 'KA', postalCode: '560002', country: 'India' },
  package: { description: 'Test parcel', category: 'parcel', weightKg: 1, quantity: 1 },
  priority: 'standard',
};

async function createAgent(agentCode: string) {
  return Agent.create({
    agentCode,
    name: `Agent ${agentCode}`,
    email: `${agentCode.toLowerCase()}@example.test`,
    phone: '+1 555 555 0101',
    vehicle: { vehicleType: 'van', registrationNumber: `${agentCode.slice(-4)}-100`, manufacturer: 'Ford', model: 'Transit' },
    capacity: { maxOrders: 4 },
    capabilities: ['parcel_delivery'],
    status: 'available',
  });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-notification-tests-secret-0123456789';
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.AGENT_JWT_SECRET = 'swerv-notification-agent-secret-0123456789';
  process.env.AGENT_JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Notification.init();
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Agent.deleteMany({}), DispatchRequest.deleteMany({}),
    DispatchRequestActivity.deleteMany({}), Notification.deleteMany({}), ProofOfDeliveryDraft.deleteMany({}),
  ]);
  const [admin, operator] = await User.create([
    { name: 'Notification Admin', email: 'notify-admin@example.test', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Notification Operator', email: 'notify-operator@example.test', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  const agent = await createAgent('AGT-NOTIFY-01');
  const secondAgent = await createAgent('AGT-NOTIFY-02');
  adminId = admin.id;
  operatorId = operator.id;
  agentId = agent.id;
  secondAgentId = secondAgent.id;
  adminCookie = userCookie(adminId);
  operatorCookie = userCookie(operatorId);
  agentCookie = agentAuthCookie(agentId);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('Notification APIs', () => {
  it('allows Admins and Operators to list only their own notifications with pagination and unread counts', async () => {
    const [adminNotification, _adminReadNotification, operatorNotification] = await Notification.create([
      { recipientType: 'user', recipientId: adminId, eventType: 'new_dispatch', title: 'Admin one', message: 'Message one.' },
      { recipientType: 'user', recipientId: adminId, eventType: 'new_dispatch', title: 'Admin two', message: 'Message two.', readAt: new Date() },
      { recipientType: 'user', recipientId: operatorId, eventType: 'new_dispatch', title: 'Operator only', message: 'Private message.' },
    ]);
    const adminPage = await request(app).get('/api/notifications?page=1&limit=1').set('Cookie', adminCookie).expect(200);
    expect(adminPage.body.data.notifications).toHaveLength(1);
    expect(adminPage.body.data.pagination.total).toBe(2);
    expect(adminPage.body.data.pagination.pages).toBe(2);
    expect((await request(app).get('/api/notifications/unread-count').set('Cookie', adminCookie)).body.data.count).toBe(1);
    expect((await request(app).get('/api/notifications').set('Cookie', operatorCookie)).body.data.notifications[0].id).toBe(operatorNotification.id);
    expect(adminPage.body.data.notifications[0].id).not.toBe(operatorNotification.id);
    expect(adminNotification.recipientId.toString()).toBe(adminId);
  });

  it('rejects missing authentication, invalid pagination, and invalid notification IDs', async () => {
    await request(app).get('/api/notifications').expect(401);
    await request(app).get('/api/agent/notifications').expect(401);
    await request(app).get('/api/agent/notifications').set('Cookie', adminCookie).expect(401);
    await request(app).get('/api/notifications').set('Cookie', agentCookie).expect(401);
    await request(app).get('/api/notifications?page=0').set('Cookie', adminCookie).expect(400);
    await request(app).patch('/api/notifications/not-an-id/read').set('Cookie', adminCookie).expect(400);
  });

  it('lets an agent read and update only their own notifications', async () => {
    const own = await Notification.create({ recipientType: 'agent', recipientId: agentId, eventType: 'dispatch_assigned', title: 'Assigned', message: 'A delivery was assigned.' });
    await Notification.create({ recipientType: 'agent', recipientId: secondAgentId, eventType: 'dispatch_assigned', title: 'Private', message: 'For another agent.' });
    await Notification.create({ recipientType: 'user', recipientId: adminId, eventType: 'new_dispatch', title: 'Admin', message: 'For an Admin.' });

    const list = await request(app).get('/api/agent/notifications').set('Cookie', agentCookie).expect(200);
    expect(list.body.data.notifications).toHaveLength(1);
    expect(list.body.data.notifications[0].id).toBe(own.id);
    const updated = await request(app).patch(`/api/agent/notifications/${own.id}/read`).set('Cookie', agentCookie).send({}).expect(200);
    expect(updated.body.data.notification.readAt).toBeTruthy();
    await request(app).patch(`/api/agent/notifications/${String((await Notification.findOne({ recipientId: secondAgentId }))?._id)}/read`).set('Cookie', agentCookie).send({}).expect(404);
    expect((await request(app).get('/api/agent/notifications/unread-count').set('Cookie', agentCookie)).body.data.count).toBe(0);
  });

  it('marks one or all notifications read without changing another recipient', async () => {
    const own = await Notification.create({ recipientType: 'user', recipientId: adminId, eventType: 'new_dispatch', title: 'One', message: 'First.' });
    await Notification.create({ recipientType: 'user', recipientId: adminId, eventType: 'new_dispatch', title: 'Two', message: 'Second.' });
    const other = await Notification.create({ recipientType: 'user', recipientId: operatorId, eventType: 'new_dispatch', title: 'Other', message: 'Not yours.' });
    await request(app).patch(`/api/notifications/${other.id}/read`).set('Cookie', adminCookie).send({}).expect(404);
    await request(app).patch(`/api/notifications/${own.id}/read`).set('Cookie', adminCookie).send({}).expect(200);
    await request(app).patch('/api/notifications/read-all').set('Cookie', adminCookie).send({}).expect(200);
    expect(await Notification.countDocuments({ recipientType: 'user', recipientId: adminId, readAt: null })).toBe(0);
    expect(await Notification.countDocuments({ recipientType: 'user', recipientId: operatorId, readAt: null })).toBe(1);
  });
});

describe('notification business triggers', () => {
  it('notifies operations on creation and the new and previous agents on assignment changes', async () => {
    const created = await request(app).post('/api/dispatch-requests').set('Cookie', adminCookie).send(dispatchInput).expect(201);
    const dispatchId = created.body.data.dispatchRequest._id as string;
    expect(await Notification.countDocuments({ eventType: 'new_dispatch', recipientType: 'user' })).toBe(2);

    await request(app).patch(`/api/dispatch-requests/${dispatchId}/assignment`).set('Cookie', adminCookie).send({ agentId }).expect(200);
    await request(app).patch(`/api/dispatch-requests/${dispatchId}/assignment`).set('Cookie', adminCookie).send({ agentId: secondAgentId }).expect(200);
    await request(app).patch(`/api/dispatch-requests/${dispatchId}/assignment`).set('Cookie', adminCookie).send({ agentId: secondAgentId }).expect(409);

    expect(await Notification.countDocuments({ eventType: 'dispatch_assigned' })).toBe(3);
    expect(await Notification.countDocuments({ eventType: 'dispatch_reassigned' })).toBe(4);
    expect(await Notification.countDocuments({ recipientType: 'agent', recipientId: agentId, eventType: 'dispatch_reassigned' })).toBe(1);
    expect(await Notification.countDocuments({ recipientType: 'agent', recipientId: secondAgentId, eventType: 'dispatch_reassigned' })).toBe(1);
  });

  it('notifies operations about agent status and active-delivery progress changes', async () => {
    const dispatch = await DispatchRequest.create({ ...dispatchInput, status: 'assigned', assignedAgent: agentId });
    await request(app).patch(`/api/agents/${agentId}/status`).set('Cookie', operatorCookie).send({ status: 'unavailable' }).expect(200);
    await request(app).patch(`/api/dispatch-requests/${dispatch.id}/status`).set('Cookie', adminCookie).send({ status: 'picked_up' }).expect(200);
    expect(await Notification.countDocuments({ eventType: 'agent_status_changed', recipientType: 'user' })).toBe(2);
    expect(await Notification.countDocuments({ eventType: 'dispatch_status_changed', recipientType: 'agent', recipientId: agentId })).toBe(1);
    await request(app).patch(`/api/agents/${agentId}/archive`).set('Cookie', adminCookie).send({}).expect(200);
    await request(app).patch(`/api/agents/${agentId}/restore`).set('Cookie', adminCookie).send({}).expect(200);
    expect(await Notification.countDocuments({ eventType: 'agent_status_changed', recipientType: 'user' })).toBe(6);
  });

  it('creates one delivery-completed notification with the POD transaction', async () => {
    const dispatch = await DispatchRequest.create({ ...dispatchInput, status: 'in_transit', assignedAgent: agentId });
    await ProofOfDeliveryDraft.create({
      dispatchRequestId: dispatch._id,
      agentId,
      photo: { storageKey: 'test-photo', contentType: 'image/jpeg', fileName: 'photo.jpg' },
      signature: { storageKey: 'test-signature', contentType: 'image/png', fileName: 'signature.png' },
      otpVerifiedAt: new Date(),
    });
    const result = await submitProofOfDelivery(agentId, dispatch.id, { locationUnavailableReason: 'not_available' });
    result.notifications.forEach((notification) => expect(notification.eventType).toBe('delivery_completed'));
    expect(await Notification.countDocuments({ eventType: 'delivery_completed', relatedEntityId: dispatch._id })).toBe(2);
    await expect(submitProofOfDelivery(agentId, dispatch.id, { locationUnavailableReason: 'not_available' })).rejects.toThrow();
    expect(await Notification.countDocuments({ eventType: 'delivery_completed', relatedEntityId: dispatch._id })).toBe(2);
  });

  it('rolls notifications back when the owning transaction fails', async () => {
    const session = await mongoose.startSession();
    try {
      await expect(session.withTransaction(async () => {
        await createUserNotifications(session, ['admin', 'operator'], {
          eventType: 'new_dispatch', title: 'Temporary event', message: 'This transaction will roll back.',
        });
        throw new Error('force transaction rollback');
      })).rejects.toThrow('force transaction rollback');
    } finally {
      await session.endSession();
    }
    expect(await Notification.countDocuments()).toBe(0);
  });
});

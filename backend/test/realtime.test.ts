import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { io as createClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { AgentLocation } from '../src/models/AgentLocation.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { User } from '../src/models/User.js';
import { attachSocketServer, closeSocketServer, fleetRoom, publishDispatchUpdate, publishNotification } from '../src/realtime/socketServer.js';
import { getAllowedClientOrigins } from '../src/config/clientOrigins.js';
import { createAccessToken } from '../src/utils/jwt.js';
import { createAgentAccessToken } from '../src/utils/agentJwt.js';
import { generateAgentDeviceCredential } from '../src/services/agentLocationService.js';

const testSecret = 'swerv-realtime-test-secret-0123456789';
const httpServer = createServer(app);
let mongo: MongoMemoryReplSet;
let baseUrl = '';
let adminId = '';
let agentId = '';
const clients: Socket[] = [];
let socketServer: ReturnType<typeof attachSocketServer>;

function connectWithCookie(
  cookie?: string,
  reconnect = false,
  origin = 'https://swerv-jet.vercel.app',
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(baseUrl, {
      autoConnect: false,
      reconnection: reconnect,
      reconnectionDelay: 50,
      extraHeaders: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    clients.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => reject(error));
    socket.connect();
  });
}

function forceReconnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('connect', handleReconnect);
      reject(new Error('Socket did not reconnect.'));
    }, 5_000);
    const handleReconnect = () => {
      clearTimeout(timeout);
      resolve();
    };
    socket.once('connect', handleReconnect);
    socket.io.engine.close();
  });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = testSecret;
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.AGENT_JWT_SECRET = 'swerv-realtime-agent-secret-0123456789';
  process.env.AGENT_JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  const admin = await User.create({ name: 'Realtime Admin', email: 'realtime-admin@example.com', password: 'CorrectHorse9!', role: 'admin' });
  const agent = await Agent.create({
    agentCode: 'AGT-REALTIME', name: 'Realtime Agent', email: 'realtime-agent@example.com', phone: '+1 555 333 4444',
    vehicle: { vehicleType: 'van', registrationNumber: 'RT-1001', manufacturer: 'Ford', model: 'Transit' },
    capacity: { maxOrders: 5 }, capabilities: ['parcel_delivery'], status: 'on_duty',
  });
  adminId = admin.id;
  agentId = agent.id;
  socketServer = attachSocketServer(
    httpServer,
    getAllowedClientOrigins('https://swerv-jet.vercel.app'),
  );
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Realtime test server did not start.');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const client of clients) client.disconnect();
  await closeSocketServer();
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('realtime socket authentication and rooms', () => {
  it('allows the configured frontend origin and rejects untrusted origins', async () => {
    const adminCookie = `swerv_access=${createAccessToken(adminId)}`;

    await expect(
      connectWithCookie(adminCookie, false, 'https://untrusted.example'),
    ).rejects.toThrow();

    await expect(connectWithCookie(adminCookie)).resolves.toMatchObject({
      connected: true,
    });
  });

  it('authenticates cookies, assigns only server-controlled rooms, and delivers dispatch updates', async () => {
    await expect(connectWithCookie()).rejects.toThrow();

    const admin = await connectWithCookie(`swerv_access=${createAccessToken(adminId)}`, true);
    const agent = await connectWithCookie(`swerv_agent_access=${createAgentAccessToken(agentId)}`);
    const adminSocket = socketServer.sockets.sockets.get(admin.id);
    const agentSocket = socketServer.sockets.sockets.get(agent.id);
    expect(adminSocket?.rooms.has(fleetRoom)).toBe(true);
    expect(adminSocket?.rooms.has(`user:${adminId}`)).toBe(true);
    expect(adminSocket?.rooms.has(`agent:${agentId}`)).toBe(false);
    expect(agentSocket?.rooms.has(`agent:${agentId}`)).toBe(true);
    expect(agentSocket?.rooms.has(`user:${adminId}`)).toBe(false);

    agent.emit('room:join', fleetRoom);
    admin.emit('room:join', 'user:someone-else');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agentSocket?.rooms.has(fleetRoom)).toBe(false);
    expect(adminSocket?.rooms.has('user:someone-else')).toBe(false);

    const receivedUpdate = new Promise<{ dispatchId: string }>((resolve) => admin.once('dispatch:updated', resolve));
    publishDispatchUpdate({ dispatchId: 'dispatch-example', status: 'assigned', assignedAgentId: agentId });
    await expect(receivedUpdate).resolves.toMatchObject({ dispatchId: 'dispatch-example' });

    const userNotification = new Promise<{ id: string; recipientId: string }>((resolve) => admin.once('notification:new', resolve));
    let agentReceivedUserNotification = false;
    agent.once('notification:new', () => { agentReceivedUserNotification = true; });
    publishNotification({
      id: 'notification-admin', recipientType: 'user', recipientId: adminId,
      eventType: 'new_dispatch', title: 'New dispatch', message: 'A new dispatch is ready.',
      relatedEntityType: 'dispatch', relatedEntityId: 'dispatch-example',
      createdAt: new Date().toISOString(), readAt: null,
    });
    await expect(userNotification).resolves.toMatchObject({ id: 'notification-admin', recipientId: adminId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agentReceivedUserNotification).toBe(false);

    const agentNotification = new Promise<{ id: string; recipientId: string }>((resolve) => agent.once('notification:new', resolve));
    let adminReceivedAgentNotification = false;
    admin.once('notification:new', () => { adminReceivedAgentNotification = true; });
    publishNotification({
      id: 'notification-agent', recipientType: 'agent', recipientId: agentId,
      eventType: 'dispatch_assigned', title: 'Delivery assigned', message: 'A delivery is assigned to you.',
      relatedEntityType: 'dispatch', relatedEntityId: 'dispatch-example',
      createdAt: new Date().toISOString(), readAt: null,
    });
    await expect(agentNotification).resolves.toMatchObject({ id: 'notification-agent', recipientId: agentId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adminReceivedAgentNotification).toBe(false);

    const receivedLocation = new Promise<{ agentId: string; latitude: number }>((resolve) => admin.once('fleet:location', resolve));
    const credential = await generateAgentDeviceCredential(agentId);
    await request(app)
      .post('/api/agent-locations')
      .set('Authorization', `Bearer ${credential.token}`)
      .send({ latitude: 37.7749, longitude: -122.4194, accuracy: 8, recordedAt: new Date().toISOString() })
      .expect(201);
    await expect(receivedLocation).resolves.toMatchObject({ agentId, latitude: 37.7749 });
    await request(app)
      .post('/api/agent-locations')
      .set('Authorization', `Bearer ${credential.token}`)
      .send({ latitude: 37.7749, longitude: -122.4194, accuracy: 8, recordedAt: new Date().toISOString() })
      .expect(429);
    await request(app)
      .post('/api/agent-locations')
      .set('Authorization', `Bearer ${credential.token}`)
      .send({ latitude: 37.7749, longitude: -122.4194, accuracy: 8, recordedAt: new Date(Date.now() - 3 * 60_000).toISOString() })
      .expect(400);
    expect(await AgentLocation.countDocuments({ agentId })).toBe(1);

    const dispatch = await DispatchRequest.create({
      customer: { name: 'Test Customer', email: 'test@example.com', phone: '+1 555 222 3333' },
      pickup: { address: '10 North Street', city: 'Oakland', region: 'CA', postalCode: '94607', country: 'USA' },
      delivery: { address: '20 South Street', city: 'Berkeley', region: 'CA', postalCode: '94704', country: 'USA' },
      package: { description: 'Small parcel', category: 'parcel', weightKg: 2, quantity: 1 },
      assignedAgent: agentId,
      status: 'picked_up',
    });
    const agentDispatchUpdate = new Promise<{ dispatchId: string; status: string }>((resolve) => agent.once('dispatch:updated', resolve));
    await request(app)
      .patch(`/api/agent/deliveries/${dispatch.id}/status`)
      .set('Cookie', `swerv_agent_access=${createAgentAccessToken(agentId)}`)
      .send({ status: 'in_transit' })
      .expect(200);
    await expect(agentDispatchUpdate).resolves.toMatchObject({ dispatchId: dispatch.id, status: 'in_transit' });

    await expect(forceReconnect(admin)).resolves.toBeUndefined();
  });
});

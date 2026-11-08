import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';
import app from '../src/app.js';
import { AuthBootstrap } from '../src/models/AuthBootstrap.js';
import { User } from '../src/models/User.js';
import { ensureAuthCollections } from '../src/services/authService.js';

const testSecret = 'swerv-admin-users-test-secret-0123456789';
let mongo: MongoMemoryReplSet;

function userDetails(email: string, extra: Record<string, unknown> = {}) {
  return { name: 'Taylor Example', email, password: 'CorrectHorse9!', role: 'operator', ...extra };
}

function authCookie(response: request.Response): string {
  const cookies = response.headers['set-cookie'];
  if (!cookies?.length) throw new Error('Expected an authentication cookie.');
  return cookies[0].split(';')[0];
}

async function register(email: string) {
  return request(app).post('/api/auth/register').send({
    name: 'Taylor Example', email, password: 'CorrectHorse9!',
  });
}

async function makeAdminAndOperator() {
  const admin = await register('admin@example.com');
  const operator = await register('operator@example.com');
  return { admin, operator };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = testSecret;
  process.env.JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await ensureAuthCollections();
});

beforeEach(async () => {
  await User.deleteMany({});
  await AuthBootstrap.updateOne(
    { _id: 'initial-admin' },
    { $set: { firstAdminAssigned: false, adminChangeVersion: 0 } },
    { upsert: true },
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('administrator user management', () => {
  it('requires an authenticated administrator for all user routes', async () => {
    const { admin, operator } = await makeAdminAndOperator();
    await request(app).get('/api/admin/users').expect(401);
    await request(app).post('/api/admin/users').send(userDetails('new@example.com')).expect(401);
    await request(app).get('/api/admin/users').set('Cookie', authCookie(operator)).expect(403);
    await request(app).get('/api/admin/users').set('Cookie', authCookie(admin)).expect(200);
  });

  it('lists users with search, role, account status, and pagination', async () => {
    const { admin } = await makeAdminAndOperator();
    const cookie = authCookie(admin);
    await request(app).post('/api/admin/users').set('Cookie', cookie).send(userDetails('second@example.com', { name: 'Morgan Fleet', role: 'operator' })).expect(201);
    await request(app).post('/api/admin/users').set('Cookie', cookie).send(userDetails('third@example.com', { name: 'Morgan Admin', role: 'admin' })).expect(201);
    const inactive = await User.findOneAndUpdate({ email: 'second@example.com' }, { isActive: false }, { new: true });
    expect(inactive?.isActive).toBe(false);

    const response = await request(app).get('/api/admin/users?search=morgan&role=operator&status=inactive&page=1&limit=1').set('Cookie', cookie).expect(200);
    expect(response.body.data.users).toHaveLength(1);
    expect(response.body.data.users[0]).toMatchObject({ email: 'second@example.com', isActive: false });
    expect(response.body.data.pagination).toMatchObject({ page: 1, limit: 1, total: 1, pages: 1 });
    expect(response.body.data.users[0].password).toBeUndefined();
  });

  it('creates users with a bcrypt hash and does not accept privilege fields beyond the schema', async () => {
    const { admin } = await makeAdminAndOperator();
    const response = await request(app).post('/api/admin/users').set('Cookie', authCookie(admin)).send(userDetails('created@example.com', { isActive: false }));
    expect(response.status).toBe(400);
    const created = await request(app).post('/api/admin/users').set('Cookie', authCookie(admin)).send(userDetails('created@example.com'));
    expect(created.status).toBe(201);
    expect(created.body.data.user).not.toHaveProperty('password');
    const stored = await User.findOne({ email: 'created@example.com' }).select('+password');
    expect(stored?.password).not.toBe('CorrectHorse9!');
    expect(await bcrypt.compare('CorrectHorse9!', stored!.password)).toBe(true);
  });

  it('rejects duplicate emails and invalid creation input', async () => {
    const { admin } = await makeAdminAndOperator();
    const cookie = authCookie(admin);
    await request(app).post('/api/admin/users').set('Cookie', cookie).send(userDetails('operator@example.com')).expect(409);
    await request(app).post('/api/admin/users').set('Cookie', cookie).send(userDetails('bad@example.com', { role: 'superadmin' })).expect(400);
  });

  it('returns a user without sensitive fields and handles invalid or missing IDs', async () => {
    const { admin } = await makeAdminAndOperator();
    const cookie = authCookie(admin);
    const userId = admin.body.data.user.id;
    const response = await request(app).get(`/api/admin/users/${userId}`).set('Cookie', cookie).expect(200);
    expect(response.body.data.user).toMatchObject({ email: 'admin@example.com', role: 'admin' });
    expect(response.body.data.user.password).toBeUndefined();
    expect(response.body.data.user.token).toBeUndefined();
    await request(app).get('/api/admin/users/not-an-id').set('Cookie', cookie).expect(400);
    await request(app).get(`/api/admin/users/${new mongoose.Types.ObjectId()}`).set('Cookie', cookie).expect(404);
  });

  it('changes roles and protects the last active administrator', async () => {
    const { admin, operator } = await makeAdminAndOperator();
    const cookie = authCookie(admin);
    const operatorId = operator.body.data.user.id;
    await request(app).patch(`/api/admin/users/${operatorId}/role`).set('Cookie', cookie).send({ role: 'admin' }).expect(200);
    await request(app).patch(`/api/admin/users/${operatorId}/role`).set('Cookie', cookie).send({ role: 'operator' }).expect(200);
    await request(app).patch(`/api/admin/users/${admin.body.data.user.id}/role`).set('Cookie', cookie).send({ role: 'operator' }).expect(409);
    await request(app).patch(`/api/admin/users/${operatorId}/role`).set('Cookie', cookie).send({ role: 'root' }).expect(400);
  });

  it('activates and deactivates users, rejects self-deactivation, and blocks inactive credentials', async () => {
    const { admin, operator } = await makeAdminAndOperator();
    const cookie = authCookie(admin);
    const operatorId = operator.body.data.user.id;
    await request(app).patch(`/api/admin/users/${operatorId}/status`).set('Cookie', cookie).send({ isActive: false }).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', authCookie(operator)).expect(401);
    await request(app).patch(`/api/admin/users/${operatorId}/status`).set('Cookie', cookie).send({ isActive: true }).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', authCookie(operator)).expect(200);
    await request(app).patch(`/api/admin/users/${admin.body.data.user.id}/status`).set('Cookie', cookie).send({ isActive: false }).expect(400);
    await request(app).patch(`/api/admin/users/${operatorId}/status`).set('Cookie', cookie).send({ isActive: 'false' }).expect(400);
  });

  it('prevents deactivating the last active administrator and serializes concurrent demotions', async () => {
    const firstAdmin = await register('first-admin@example.com');
    const secondAdmin = await request(app).post('/api/admin/users').set('Cookie', authCookie(firstAdmin)).send(userDetails('second-admin@example.com', { role: 'admin' }));
    const firstId = firstAdmin.body.data.user.id;
    const secondId = secondAdmin.body.data.user.id;
    await request(app).patch(`/api/admin/users/${firstId}/status`).set('Cookie', authCookie(firstAdmin)).send({ isActive: false }).expect(400);

    const results = await Promise.all([
      request(app).patch(`/api/admin/users/${firstId}/role`).set('Cookie', authCookie(firstAdmin)).send({ role: 'operator' }),
      request(app).patch(`/api/admin/users/${secondId}/role`).set('Cookie', authCookie(firstAdmin)).send({ role: 'operator' }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await User.countDocuments({ role: 'admin', isActive: true })).toBe(1);
  });

  it('rejects malformed IDs and status requests for missing users', async () => {
    const { admin } = await makeAdminAndOperator();
    const cookie = authCookie(admin);
    await request(app).patch('/api/admin/users/invalid/role').set('Cookie', cookie).send({ role: 'operator' }).expect(400);
    await request(app).patch(`/api/admin/users/${new mongoose.Types.ObjectId()}/status`).set('Cookie', cookie).send({ isActive: true }).expect(404);
  });
});

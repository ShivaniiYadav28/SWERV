import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import { AuthBootstrap } from '../src/models/AuthBootstrap.js';
import { User } from '../src/models/User.js';
import { ensureAuthCollections } from '../src/services/authService.js';

const testSecret = 'swerv-vitest-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
let mongo: MongoMemoryReplSet;

function registration(email: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'Casey Operator',
    email,
    password: 'CorrectHorse9!',
    ...extra,
  };
}

function authCookie(response: request.Response): string {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie?.length) throw new Error('Expected an authentication cookie.');
  return setCookie[0].split(';')[0];
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
    { $set: { firstAdminAssigned: false } },
    { upsert: true },
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('SWERV authentication and authorization', () => {
  it('registers the first account as admin and returns only safe user fields', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send(registration('first@example.com'));
    expect(response.status).toBe(201);
    expect(response.body.data.user).toMatchObject({
      email: 'first@example.com',
      role: 'admin',
      isActive: true,
    });
    expect(response.body.data.user.password).toBeUndefined();
    expect(response.body.data.user._id).toBeUndefined();
    expect(authCookie(response)).toContain('swerv_access=');
  });

  it('rejects duplicate email registration with a generic conflict response', async () => {
    await request(app)
      .post('/api/auth/register')
      .send(registration('duplicate@example.com'))
      .expect(201);
    const response = await request(app)
      .post('/api/auth/register')
      .send(registration('DUPLICATE@example.com'));
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/already exists/i);
  });

  it('stores a bcrypt password hash and verifies it during registration', async () => {
    await request(app)
      .post('/api/auth/register')
      .send(registration('hash@example.com'))
      .expect(201);
    const user = await User.findOne({ email: 'hash@example.com' }).select(
      '+password',
    );
    expect(user?.password).not.toBe('CorrectHorse9!');
    expect(await bcrypt.compare('CorrectHorse9!', user!.password)).toBe(true);
  });

  it('logs in with valid credentials and sets a protected cookie', async () => {
    await request(app)
      .post('/api/auth/register')
      .send(registration('login@example.com'))
      .expect(201);
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'LOGIN@example.com', password: 'CorrectHorse9!' });
    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe('login@example.com');
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    expect(response.headers['set-cookie'][0]).toMatch(/SameSite=Lax/i);
    expect(response.body).not.toHaveProperty('token');
  });

  it('marks authentication cookies Secure in production', async () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await request(app)
        .post('/api/auth/register')
        .send(registration('secure-cookie@example.com'));
      expect(response.status).toBe(201);
      expect(response.headers['set-cookie'][0]).toMatch(/Secure/i);
    } finally {
      process.env.NODE_ENV = previousEnvironment;
    }
  });

  it('rejects an invalid password without identifying which credential was wrong', async () => {
    await request(app)
      .post('/api/auth/register')
      .send(registration('wrong-password@example.com'))
      .expect(201);
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'wrong-password@example.com',
        password: 'NotThePassword9!',
      });
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid email or password.');
  });

  it('validates missing login credentials', async () => {
    const response = await request(app).post('/api/auth/login').send({});
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('rejects passwords that exceed bcrypt’s 72-byte limit at login', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'long-password@example.com', password: 'x'.repeat(73) });
    expect(response.status).toBe(400);
  });

  it('denies the current-user route without a cookie', async () => {
    const response = await request(app).get('/api/auth/me');
    expect(response.status).toBe(401);
  });

  it('returns the current user when the cookie is valid', async () => {
    const registered = await request(app)
      .post('/api/auth/register')
      .send(registration('me@example.com'))
      .expect(201);
    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', authCookie(registered));
    expect(response.status).toBe(200);
    expect(response.body.data.user).toMatchObject({
      email: 'me@example.com',
      role: 'admin',
    });
  });

  it('forbids an operator from the administrator endpoint', async () => {
    await request(app)
      .post('/api/auth/register')
      .send(registration('first-admin@example.com'))
      .expect(201);
    const operator = await request(app)
      .post('/api/auth/register')
      .send(registration('operator@example.com'))
      .expect(201);
    expect(operator.body.data.user.role).toBe('operator');
    await request(app)
      .get('/api/admin/dashboard')
      .set('Cookie', authCookie(operator))
      .expect(403);
  });

  it('allows the initial admin into the administrator endpoint', async () => {
    const admin = await request(app)
      .post('/api/auth/register')
      .send(registration('admin-dashboard@example.com'))
      .expect(201);
    const response = await request(app)
      .get('/api/admin/dashboard')
      .set('Cookie', authCookie(admin));
    expect(response.status).toBe(200);
    expect(response.body.data.user.role).toBe('admin');
  });

  it('clears the authentication cookie on logout', async () => {
    const registered = await request(app)
      .post('/api/auth/register')
      .send(registration('logout@example.com'))
      .expect(201);
    const response = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', authCookie(registered));
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.headers['set-cookie'][0]).toMatch(
      /Expires=Thu, 01 Jan 1970/i,
    );
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
  });

  it('rejects a previously issued cookie after the account is deactivated', async () => {
    const registered = await request(app)
      .post('/api/auth/register')
      .send(registration('inactive@example.com'))
      .expect(201);
    await User.updateOne(
      { email: 'inactive@example.com' },
      { $set: { isActive: false } },
    );
    await request(app)
      .get('/api/auth/me')
      .set('Cookie', authCookie(registered))
      .expect(401);
  });

  it('rejects an operator session immediately after deactivation while the admin remains authorized', async () => {
    const admin = await request(app)
      .post('/api/auth/register')
      .send(registration('deactivation-admin@example.com'))
      .expect(201);
    const operator = await request(app)
      .post('/api/auth/register')
      .send(registration('deactivation-operator@example.com'))
      .expect(201);
    const adminCookie = authCookie(admin);
    const operatorCookie = authCookie(operator);

    await request(app)
      .get('/api/auth/me')
      .set('Cookie', operatorCookie)
      .expect(200);
    await request(app)
      .get('/api/admin/users')
      .set('Cookie', adminCookie)
      .expect(200);

    await request(app)
      .patch(`/api/admin/users/${operator.body.data.user.id}/status`)
      .set('Cookie', adminCookie)
      .send({ isActive: false })
      .expect(200);

    await request(app)
      .get('/api/auth/me')
      .set('Cookie', operatorCookie)
      .expect(401);
    await request(app)
      .get('/api/admin/users')
      .set('Cookie', adminCookie)
      .expect(200);
  });

  it('rejects attempts to submit a role and does not consume the first-admin slot', async () => {
    const rejected = await request(app)
      .post('/api/auth/register')
      .send(registration('role-attack@example.com', { role: 'admin' }));
    expect(rejected.status).toBe(400);
    expect(await User.countDocuments()).toBe(0);
    const legitimate = await request(app)
      .post('/api/auth/register')
      .send(registration('legitimate@example.com'));
    expect(legitimate.body.data.user.role).toBe('admin');
  });

  it('assigns exactly one initial administrator during simultaneous registration', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        request(app)
          .post('/api/auth/register')
          .send(registration(`parallel-${index}@example.com`)),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const users = await User.find().select('role');
    expect(users.filter((user) => user.role === 'admin')).toHaveLength(1);
    expect(users.filter((user) => user.role === 'operator')).toHaveLength(7);
  });

  it('rejects malformed and expired JWTs', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'swerv_access=broken')
      .expect(401);
    const expired = jwt.sign({}, testSecret, {
      subject: new mongoose.Types.ObjectId().toString(),
      expiresIn: -1,
    });
    await request(app)
      .get('/api/auth/me')
      .set('Cookie', `swerv_access=${expired}`)
      .expect(401);
  });
});

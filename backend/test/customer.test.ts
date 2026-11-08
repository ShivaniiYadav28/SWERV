import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { AuthBootstrap } from '../src/models/AuthBootstrap.js';
import { Customer } from '../src/models/Customer.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { User } from '../src/models/User.js';
import { ensureAuthCollections } from '../src/services/authService.js';
import { ensureCustomerCollections } from '../src/services/customerService.js';
import { ensureDispatchRequestCollections } from '../src/services/dispatchRequestService.js';

const testSecret = 'swerv-customer-tests-secret-0123456789';
let mongo: MongoMemoryReplSet;
let adminCookie: string;
let operatorCookie: string;

const pickup = {
  address: '10 North Street', city: 'Austin', region: 'Texas',
  postalCode: '73301', country: 'USA',
};
const delivery = {
  address: '22 South Street', city: 'Austin', region: 'Texas',
  postalCode: '73302', country: 'USA',
};
const packageDetails = {
  description: 'Customer package', category: 'parcel', weightKg: 2, quantity: 1,
};

function customerInput(overrides: Record<string, unknown> = {}) {
  return { name: 'Alex Customer', email: 'alex@example.com', phone: '+1 555 123 4567', ...overrides };
}

function dispatchInput(overrides: Record<string, unknown> = {}) {
  return {
    customer: customerInput(), pickup, delivery, package: packageDetails, ...overrides,
  };
}

function authCookie(response: request.Response): string {
  const cookies = response.headers['set-cookie'];
  if (!cookies?.length) throw new Error('Expected an authentication cookie.');
  return cookies[0].split(';')[0];
}

async function register(email: string, name: string) {
  return request(app).post('/api/auth/register').send({ name, email, password: 'CorrectHorse9!' });
}

function createCustomer(cookie: string, input = customerInput()) {
  return request(app).post('/api/customers').set('Cookie', cookie).send(input);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = testSecret;
  process.env.JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await ensureAuthCollections();
  await ensureCustomerCollections();
  await ensureDispatchRequestCollections();
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Customer.deleteMany({}), DispatchRequest.deleteMany({}),
    DispatchRequestActivity.deleteMany({}),
  ]);
  await AuthBootstrap.updateOne(
    { _id: 'initial-admin' },
    { $set: { firstAdminAssigned: false, adminChangeVersion: 0 } },
    { upsert: true },
  );
  const admin = await register('admin@example.com', 'Admin User');
  const operator = await register('operator@example.com', 'Operator User');
  adminCookie = authCookie(admin);
  operatorCookie = authCookie(operator);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('customer management', () => {
  it('requires authentication and allows Admin and Operator customer operations', async () => {
    await request(app).get('/api/customers').expect(401);
    await request(app).post('/api/customers').send(customerInput()).expect(401);
    await createCustomer(adminCookie).expect(201);
    await createCustomer(operatorCookie, customerInput({ email: 'operator-customer@example.com' })).expect(201);
    await request(app).get('/api/customers').set('Cookie', adminCookie).expect(200);
    await request(app).get('/api/customers').set('Cookie', operatorCookie).expect(200);
  });

  it('validates customer fields and rejects an exact duplicate contact without requiring unique email or phone indexes', async () => {
    const created = await createCustomer(adminCookie).expect(201);
    expect(created.body.data.customer).toMatchObject({ name: 'Alex Customer', email: 'alex@example.com', isActive: true });
    expect(created.body.data.customer).not.toHaveProperty('identityKey');
    await createCustomer(operatorCookie).expect(409);
    await createCustomer(adminCookie, customerInput({ email: 'not-an-email' })).expect(400);
    await createCustomer(adminCookie, customerInput({ extra: true })).expect(400);
  });

  it('lists with pagination, name/email/phone search, and active status filter', async () => {
    await createCustomer(adminCookie).expect(201);
    await createCustomer(adminCookie, customerInput({ name: 'Morgan Example', email: 'morgan@example.com', phone: '555-888-7777' })).expect(201);
    const inactive = await createCustomer(adminCookie, customerInput({ name: 'Inactive Person', email: 'inactive@example.com', phone: '555-222-4444' })).expect(201);
    await request(app).patch(`/api/customers/${inactive.body.data.customer.id}/status`).set('Cookie', adminCookie).send({ isActive: false }).expect(200);

    const response = await request(app).get('/api/customers?search=morgan&status=active&page=1&limit=1').set('Cookie', operatorCookie).expect(200);
    expect(response.body.data.customers).toHaveLength(1);
    expect(response.body.data.customers[0].email).toBe('morgan@example.com');
    expect(response.body.data.pagination).toMatchObject({ page: 1, limit: 1, total: 1, pages: 1 });
    await request(app).get('/api/customers?search=555-222-4444&status=inactive').set('Cookie', adminCookie).expect(200).expect((res) => {
      expect(res.body.data.customers[0].name).toBe('Inactive Person');
    });
  });

  it('returns customer details and handles invalid and missing IDs', async () => {
    const created = await createCustomer(operatorCookie).expect(201);
    const id = created.body.data.customer.id;
    const response = await request(app).get(`/api/customers/${id}`).set('Cookie', adminCookie).expect(200);
    expect(response.body.data.customer).toMatchObject({ id, name: 'Alex Customer' });
    expect(response.body.data).toHaveProperty('dispatchRequests');
    expect(response.body.data.customer).not.toHaveProperty('identityKey');
    await request(app).get('/api/customers/not-an-id').set('Cookie', adminCookie).expect(400);
    await request(app).get(`/api/customers/${new mongoose.Types.ObjectId()}`).set('Cookie', adminCookie).expect(404);
  });

  it('updates customer contact details and rejects empty or invalid updates', async () => {
    const created = await createCustomer(adminCookie).expect(201);
    const id = created.body.data.customer.id;
    const response = await request(app).patch(`/api/customers/${id}`).set('Cookie', operatorCookie).send({ name: 'Alex Updated' }).expect(200);
    expect(response.body.data.customer).toMatchObject({ name: 'Alex Updated', email: 'alex@example.com' });
    await request(app).patch(`/api/customers/${id}`).set('Cookie', adminCookie).send({}).expect(400);
    await request(app).patch(`/api/customers/${id}`).set('Cookie', adminCookie).send({ role: 'admin' }).expect(400);
  });

  it('soft-deactivates and reactivates customers while retaining dispatch history', async () => {
    const created = await createCustomer(adminCookie).expect(201);
    const id = created.body.data.customer.id;
    await request(app).patch(`/api/customers/${id}/status`).set('Cookie', operatorCookie).send({ isActive: false }).expect(200);
    const inactive = await request(app).get(`/api/customers/${id}`).set('Cookie', adminCookie).expect(200);
    expect(inactive.body.data.customer.isActive).toBe(false);
    await request(app).patch(`/api/customers/${id}/status`).set('Cookie', adminCookie).send({ isActive: true }).expect(200);
    expect((await Customer.findById(id))?.isActive).toBe(true);
    await request(app).patch(`/api/customers/${id}/status`).set('Cookie', adminCookie).send({ isActive: 'true' }).expect(400);
  });

  it('creates legacy embedded requests and explicitly linked requests with contact snapshots', async () => {
    const customer = await createCustomer(adminCookie).expect(201);
    const linked = await request(app).post('/api/dispatch-requests').set('Cookie', operatorCookie)
      .send(dispatchInput({ customer: undefined, customerId: customer.body.data.customer.id })).expect(201);
    expect(linked.body.data.dispatchRequest).toMatchObject({
      customerId: customer.body.data.customer.id,
      customer: { name: 'Alex Customer', email: 'alex@example.com', phone: '+1 555 123 4567' },
    });

    const legacy = await request(app).post('/api/dispatch-requests').set('Cookie', adminCookie)
      .send(dispatchInput({ customer: customerInput({ email: 'legacy@example.com' }) })).expect(201);
    expect(legacy.body.data.dispatchRequest.customerId).toBeFalsy();
    expect(legacy.body.data.dispatchRequest.customer.email).toBe('legacy@example.com');
  });

  it('returns only explicitly associated dispatch history and does not link legacy requests by matching contacts', async () => {
    const first = await createCustomer(adminCookie).expect(201);
    const second = await createCustomer(adminCookie, customerInput({ name: 'Morgan Customer', email: 'morgan@example.com', phone: '555-987-6543' })).expect(201);
    await request(app).post('/api/dispatch-requests').set('Cookie', adminCookie)
      .send(dispatchInput({ customer: undefined, customerId: first.body.data.customer.id })).expect(201);
    await request(app).post('/api/dispatch-requests').set('Cookie', adminCookie)
      .send(dispatchInput()).expect(201);

    const firstDetails = await request(app).get(`/api/customers/${first.body.data.customer.id}`).set('Cookie', adminCookie).expect(200);
    const secondDetails = await request(app).get(`/api/customers/${second.body.data.customer.id}`).set('Cookie', adminCookie).expect(200);
    expect(firstDetails.body.data.dispatchRequests).toHaveLength(1);
    expect(firstDetails.body.data.dispatchRequests[0].customer.name).toBe('Alex Customer');
    expect(secondDetails.body.data.dispatchRequests).toHaveLength(0);
  });

  it('rejects inactive, missing, invalid, or ambiguously specified customer associations', async () => {
    const customer = await createCustomer(adminCookie).expect(201);
    await request(app).patch(`/api/customers/${customer.body.data.customer.id}/status`).set('Cookie', adminCookie).send({ isActive: false }).expect(200);
    await request(app).post('/api/dispatch-requests').set('Cookie', adminCookie)
      .send(dispatchInput({ customer: undefined, customerId: customer.body.data.customer.id })).expect(409);
    await request(app).post('/api/dispatch-requests').set('Cookie', adminCookie)
      .send(dispatchInput({ customer: undefined, customerId: new mongoose.Types.ObjectId() })).expect(404);
    await request(app).post('/api/dispatch-requests').set('Cookie', adminCookie)
      .send(dispatchInput({ customer: undefined, customerId: 'bad-id' })).expect(400);
    await request(app).post('/api/dispatch-requests').set('Cookie', adminCookie)
      .send(dispatchInput({ customerId: customer.body.data.customer.id })).expect(400);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import request from 'supertest';
import { mkdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { ProofOfDelivery, ProofOfDeliveryDraft } from '../src/models/ProofOfDelivery.js';
import { User } from '../src/models/User.js';
import { ensureAgentCollections } from '../src/services/agentService.js';
import { ensureDispatchRequestCollections } from '../src/services/dispatchRequestService.js';
import { ensureProofOfDeliveryCollections } from '../src/services/proofOfDeliveryService.js';
import { createAccessToken } from '../src/utils/jwt.js';
import { createAgentAccessToken } from '../src/utils/agentJwt.js';
import { deletePodImage, readPodImage, validatePodStorageConfiguration } from '../src/services/podStorageService.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { HttpError } from '../src/utils/httpError.js';

const testStorageDirectory = join(tmpdir(), 'swerv-pod-test-storage');
const pngFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpl8AAAAASUVORK5CYII=', 'base64');
const agentFields = {
  name: 'Delivery Agent', email: 'pod-agent@example.test', phone: '+1 555 222 3333',
  vehicle: { vehicleType: 'van', registrationNumber: 'POD-1001', manufacturer: 'Ford', model: 'Transit' },
  capacity: { maxOrders: 4 }, capabilities: ['parcel_delivery'], activeDispatchCount: 1,
};
const requestFields = {
  customer: { name: 'Test Customer', email: 'pod-customer@example.test', phone: '+1 555 222 4444' },
  pickup: { address: '10 Pickup Road', city: 'Bengaluru', region: 'KA', postalCode: '560001', country: 'India' },
  delivery: { address: '20 Delivery Road', city: 'Bengaluru', region: 'KA', postalCode: '560002', country: 'India' },
  package: { description: 'Test parcel', category: 'parcel', weightKg: 1, quantity: 1 },
};

let mongo: MongoMemoryReplSet;
let agentId = '';
let agentCookie = '';
let adminCookie = '';
let operatorCookie = '';
let dispatchId = '';

function userCookie(id: string) { return `swerv_access=${createAccessToken(id)}`; }
function agentSessionCookie(id: string) { return `swerv_agent_access=${createAgentAccessToken(id)}`; }

async function createActiveDelivery() {
  const dispatch = await DispatchRequest.create({ ...requestFields, status: 'assigned', assignedAgent: agentId });
  dispatchId = dispatch.id;
  return dispatchId;
}

async function moveToInTransit() {
  await request(app).patch(`/api/agent/deliveries/${dispatchId}/status`).set('Cookie', agentCookie).send({ status: 'picked_up' }).expect(200);
  await request(app).patch(`/api/agent/deliveries/${dispatchId}/status`).set('Cookie', agentCookie).send({ status: 'in_transit' }).expect(200);
}

async function uploadPhoto() {
  return request(app).post(`/api/agent/deliveries/${dispatchId}/pod/photo`)
    .set('Cookie', agentCookie).set('Content-Type', 'image/png').set('X-File-Name', 'delivery.png')
    .send(pngFixture).expect(201);
}

async function prepareVerifiedEvidence() {
  await uploadPhoto();
  await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/signature`)
    .set('Cookie', agentCookie).set('Content-Type', 'image/png').set('X-File-Name', 'signature.png')
    .send(pngFixture).expect(201);
  const response = await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/otp`).set('Cookie', agentCookie).expect(200);
  const code = response.body.data.developmentOtp as string;
  expect(code).toMatch(/^\d{6}$/);
  await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/otp/verify`).set('Cookie', agentCookie).send({ otp: code }).expect(200);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-pod-test-user-secret-0123456789-abcdef';
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.AGENT_JWT_SECRET = 'swerv-pod-test-agent-secret-0123456789-abcdef';
  process.env.AGENT_JWT_EXPIRES_IN = '1d';
  process.env.POD_STORAGE_DIR = testStorageDirectory;
  process.env.POD_DEV_OTP_ENABLED = 'true';
  await mkdir(testStorageDirectory, { recursive: true });
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([ensureAgentCollections(), ensureDispatchRequestCollections(), ensureProofOfDeliveryCollections()]);
});

beforeEach(async () => {
  await Promise.all([Agent.deleteMany({}), DispatchRequest.deleteMany({}), DispatchRequestActivity.deleteMany({}), ProofOfDelivery.deleteMany({}), ProofOfDeliveryDraft.deleteMany({}), User.deleteMany({})]);
  const [agent, admin, operator] = await Promise.all([
    Agent.create({ ...agentFields, agentCode: 'AGT-POD-TEST' }),
    User.create({ name: 'POD Admin', email: 'pod-admin@example.test', password: 'CorrectHorse9!', role: 'admin' }),
    User.create({ name: 'POD Operator', email: 'pod-operator@example.test', password: 'CorrectHorse9!', role: 'operator' }),
  ]);
  agentId = agent.id;
  agentCookie = agentSessionCookie(agentId);
  adminCookie = userCookie(admin.id);
  operatorCookie = userCookie(operator.id);
  await createActiveDelivery();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  await rm(testStorageDirectory, { recursive: true, force: true });
});

describe('proof of delivery API', () => {
  it('lets only the assigned agent read and prepare a POD draft', async () => {
    const otherAgent = await Agent.create({ ...agentFields, email: 'other-pod-agent@example.test', agentCode: 'AGT-POD-OTHER', vehicle: { ...agentFields.vehicle, registrationNumber: 'POD-1002' } });
    await request(app).get(`/api/agent/deliveries/${dispatchId}/pod`).set('Cookie', agentSessionCookie(otherAgent.id)).expect(404);
    const status = await request(app).get(`/api/agent/deliveries/${dispatchId}/pod`).set('Cookie', agentCookie).expect(200);
    expect(status.body.data).toMatchObject({ photoUploaded: false, signatureUploaded: false, otpVerified: false });
  });

  it('accepts image files with matching supported extensions and rejects invalid formats', async () => {
    await uploadPhoto();
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/photo`).set('Cookie', agentCookie)
      .set('Content-Type', 'image/png').set('X-File-Name', 'not-an-image.jpg').send(pngFixture).expect(400);
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/photo`).set('Cookie', agentCookie)
      .set('Content-Type', 'application/pdf').set('X-File-Name', 'proof.pdf').send('document').expect(400);
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/photo`).set('Cookie', agentCookie)
      .set('Content-Type', 'image/png').set('X-File-Name', 'large.png').send(Buffer.alloc(5 * 1024 * 1024 + 1)).expect(413);
  });

  it('stores and retrieves new proof images through configured S3-compatible storage', async () => {
    const objects = new Map<string, Buffer>();
    let failPut = false;
    let failGet = false;
    let failDelete = false;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const key = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'PUT') {
        if (failPut) {
          res.writeHead(500).end('sensitive provider response');
          return;
        }
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200).end();
      } else if (req.method === 'GET') {
        if (failGet) {
          res.writeHead(500).end('sensitive provider response');
          return;
        }
        const bytes = objects.get(key);
        if (!bytes) {
          res.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
        } else {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length }).end(bytes);
        }
      } else if (req.method === 'DELETE') {
        if (failDelete) {
          res.writeHead(500).end('sensitive provider response');
          return;
        }
        objects.delete(key);
        res.writeHead(204).end();
      } else {
        res.writeHead(405).end();
      }
    });

    const previousEnvironment = {
      nodeEnv: process.env.NODE_ENV,
      provider: process.env.POD_STORAGE_PROVIDER,
      bucket: process.env.POD_S3_BUCKET,
      region: process.env.POD_S3_REGION,
      endpoint: process.env.POD_S3_ENDPOINT,
      pathStyle: process.env.POD_S3_FORCE_PATH_STYLE,
      accessKey: process.env.AWS_ACCESS_KEY_ID,
      secretKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test object storage server did not start.');
    process.env.POD_STORAGE_PROVIDER = 's3';
    process.env.POD_S3_BUCKET = 'pod-test';
    process.env.POD_S3_REGION = 'us-east-1';
    process.env.POD_S3_ENDPOINT = `http://127.0.0.1:${address.port}`;
    process.env.POD_S3_FORCE_PATH_STYLE = 'true';
    process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';

    try {
      validatePodStorageConfiguration();
      failPut = true;
      const failedUpload = await request(app)
        .post(`/api/agent/deliveries/${dispatchId}/pod/photo`)
        .set('Cookie', agentCookie)
        .set('Content-Type', 'image/png')
        .set('X-File-Name', 'delivery.png')
        .send(pngFixture)
        .expect(503);
      expect(failedUpload.body.message).toBe('Proof storage is temporarily unavailable.');
      expect(failedUpload.text).not.toContain('sensitive provider response');
      expect(await ProofOfDeliveryDraft.countDocuments({ dispatchRequestId: dispatchId })).toBe(0);
      failPut = false;

      await uploadPhoto();
      const draft = await ProofOfDeliveryDraft.findOne({ dispatchRequestId: dispatchId }).lean();
      const stored = draft?.photo;
      if (!stored) throw new Error('Expected uploaded proof metadata.');
      expect(stored.storageProvider).toBe('s3');
      expect(stored.storageKey).toMatch(/^pod\/[0-9a-f-]{36}\.png$/);
      expect(objects.size).toBe(1);
      await expect(readPodImage(stored!)).resolves.toEqual(pngFixture);
      await request(app)
        .get(`/api/agent/deliveries/${dispatchId}/pod/evidence/photo`)
        .expect(401);
      const otherAgent = await Agent.create({
        ...agentFields,
        email: 'other-s3-pod-agent@example.test',
        agentCode: 'AGT-POD-S3-OTHER',
        vehicle: { ...agentFields.vehicle, registrationNumber: 'POD-S3-1002' },
      });
      await request(app)
        .get(`/api/agent/deliveries/${dispatchId}/pod/evidence/photo`)
        .set('Cookie', agentSessionCookie(otherAgent.id))
        .expect(404);
      const retrieved = await request(app)
        .get(`/api/agent/deliveries/${dispatchId}/pod/evidence/photo`)
        .set('Cookie', agentCookie)
        .expect(200);
      expect(retrieved.headers['content-type']).toContain('image/png');
      expect(retrieved.body).toEqual(pngFixture);

      failGet = true;
      const failedRetrieval = await request(app)
        .get(`/api/agent/deliveries/${dispatchId}/pod/evidence/photo`)
        .set('Cookie', agentCookie)
        .expect(503);
      expect(failedRetrieval.body.message).toBe('Proof storage is temporarily unavailable.');
      expect(failedRetrieval.text).not.toContain('sensitive provider response');
      failGet = false;

      failDelete = true;
      await expect(deletePodImage(stored)).rejects.toMatchObject({
        status: 503,
        message: 'Proof storage is temporarily unavailable.',
      });
      failDelete = false;
      await deletePodImage(stored);
      expect(objects.size).toBe(0);
      await expect(
        readPodImage({
          storageKey: 'pod/00000000-0000-0000-0000-000000000000.png',
          storageProvider: 's3',
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      server.close();
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore('POD_STORAGE_PROVIDER', previousEnvironment.provider);
      restore('POD_S3_BUCKET', previousEnvironment.bucket);
      restore('POD_S3_REGION', previousEnvironment.region);
      restore('POD_S3_ENDPOINT', previousEnvironment.endpoint);
      restore('POD_S3_FORCE_PATH_STYLE', previousEnvironment.pathStyle);
      restore('AWS_ACCESS_KEY_ID', previousEnvironment.accessKey);
      restore('AWS_SECRET_ACCESS_KEY', previousEnvironment.secretKey);
      restore('AWS_SESSION_TOKEN', previousEnvironment.sessionToken);
      process.env.NODE_ENV = previousEnvironment.nodeEnv ?? 'test';
    }
  });

  it('returns only the sanitized storage message for production storage errors', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    process.env.NODE_ENV = 'production';

    try {
      errorHandler(
        new HttpError(503, 'Proof storage is temporarily unavailable.', true),
        {} as Request,
        response,
        vi.fn(),
      );
      expect(response.status).toHaveBeenCalledWith(503);
      expect(response.json).toHaveBeenCalledWith({
        success: false,
        message: 'Proof storage is temporarily unavailable.',
      });

      const hiddenErrorResponse = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      errorHandler(new Error('provider secret detail'), {} as Request, hiddenErrorResponse, vi.fn());
      expect(hiddenErrorResponse.json).toHaveBeenCalledWith({
        success: false,
        message: 'Internal server error',
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('requires explicit access and secret keys for Cloudflare R2', () => {
    const previousEnvironment = {
      provider: process.env.POD_STORAGE_PROVIDER,
      bucket: process.env.POD_S3_BUCKET,
      region: process.env.POD_S3_REGION,
      endpoint: process.env.POD_S3_ENDPOINT,
      accessKey: process.env.AWS_ACCESS_KEY_ID,
      secretKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
    process.env.POD_STORAGE_PROVIDER = 's3';
    process.env.POD_S3_BUCKET = 'pod-test';
    process.env.POD_S3_REGION = 'auto';
    process.env.POD_S3_ENDPOINT = 'https://account.r2.cloudflarestorage.com';
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;

    try {
      expect(() => validatePodStorageConfiguration()).toThrow(
        /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for Cloudflare R2/,
      );

      process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
      expect(() => validatePodStorageConfiguration()).toThrow(
        /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for Cloudflare R2/,
      );

      delete process.env.AWS_ACCESS_KEY_ID;
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
      expect(() => validatePodStorageConfiguration()).toThrow(
        /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for Cloudflare R2/,
      );

      process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
      process.env.AWS_SESSION_TOKEN = 'test-session-token';
      expect(() => validatePodStorageConfiguration()).not.toThrow();
    } finally {
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore('POD_STORAGE_PROVIDER', previousEnvironment.provider);
      restore('POD_S3_BUCKET', previousEnvironment.bucket);
      restore('POD_S3_REGION', previousEnvironment.region);
      restore('POD_S3_ENDPOINT', previousEnvironment.endpoint);
      restore('AWS_ACCESS_KEY_ID', previousEnvironment.accessKey);
      restore('AWS_SECRET_ACCESS_KEY', previousEnvironment.secretKey);
      restore('AWS_SESSION_TOKEN', previousEnvironment.sessionToken);
    }
  });

  it('refuses production startup when durable S3 storage is not configured', () => {
    const previousEnvironment = {
      nodeEnv: process.env.NODE_ENV,
      provider: process.env.POD_STORAGE_PROVIDER,
    };
    process.env.NODE_ENV = 'production';
    delete process.env.POD_STORAGE_PROVIDER;
    try {
      expect(() => validatePodStorageConfiguration()).toThrow(/POD_STORAGE_PROVIDER/);
    } finally {
      if (previousEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnvironment.nodeEnv;
      if (previousEnvironment.provider === undefined) delete process.env.POD_STORAGE_PROVIDER;
      else process.env.POD_STORAGE_PROVIDER = previousEnvironment.provider;
    }
  });

  it('creates a development OTP only when explicitly enabled and stores only a hash', async () => {
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/otp`).set('Cookie', agentCookie).expect(409);
    await uploadPhoto();
    const response = await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/otp`).set('Cookie', agentCookie).expect(200);
    const code = response.body.data.developmentOtp as string;
    const draft = await ProofOfDeliveryDraft.findOne({ dispatchRequestId: dispatchId }).select('+otpHash');
    expect(draft?.otpHash).not.toBe(code);
    expect(draft?.otpHash).toContain(':');
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/otp`).set('Cookie', agentCookie).expect(429);
  });

  it('rejects incorrect, expired, and repeatedly guessed customer codes', async () => {
    await uploadPhoto();
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/otp`).set('Cookie', agentCookie).expect(200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/otp/verify`).set('Cookie', agentCookie).send({ otp: '000000' }).expect(attempt === 4 ? 429 : 400);
    }
    const draft = await ProofOfDeliveryDraft.findOne({ dispatchRequestId: dispatchId });
    expect(draft?.otpAttempts).toBe(5);
    await ProofOfDeliveryDraft.updateOne({ dispatchRequestId: dispatchId }, { $set: { otpAttempts: 0, otpExpiresAt: new Date(Date.now() - 1_000) } });
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/otp/verify`).set('Cookie', agentCookie).send({ otp: '000000' }).expect(410);
  });

  it('requires a signature, valid GPS fields, and verified OTP before completion', async () => {
    await moveToInTransit();
    await uploadPhoto();
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/submit`).set('Cookie', agentCookie).send({ latitude: 91, longitude: 0 }).expect(400);
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/submit`).set('Cookie', agentCookie).send({ locationUnavailableReason: 'not_available' }).expect(409);
    expect((await DispatchRequest.findById(dispatchId))?.status).toBe('in_transit');
  });

  it('submits immutable proof and marks the dispatch delivered in one transaction', async () => {
    await moveToInTransit();
    await prepareVerifiedEvidence();
    const submitted = await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/submit`).set('Cookie', agentCookie)
      .send({ latitude: 12.9716, longitude: 77.5946, accuracyMeters: 18 }).expect(201);
    expect(submitted.body.data.pod).toMatchObject({ otpVerified: true, locationStatus: 'captured', latitude: 12.9716 });
    expect(submitted.body.data.pod).not.toHaveProperty('photo.storageKey');
    expect((await DispatchRequest.findById(dispatchId))?.status).toBe('delivered');
    expect((await Agent.findById(agentId))?.activeDispatchCount).toBe(0);
    expect(await ProofOfDelivery.countDocuments({ dispatchRequestId: dispatchId })).toBe(1);
    expect(await ProofOfDeliveryDraft.countDocuments({ dispatchRequestId: dispatchId })).toBe(0);
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/submit`).set('Cookie', agentCookie).send({ locationUnavailableReason: 'not_available' }).expect(409);
  });

  it('records unavailable GPS without representing it as verified coordinates', async () => {
    await moveToInTransit();
    await prepareVerifiedEvidence();
    const response = await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/submit`).set('Cookie', agentCookie)
      .send({ locationUnavailableReason: 'permission_denied' }).expect(201);
    expect(response.body.data.pod).toMatchObject({ locationStatus: 'unavailable', latitude: null, longitude: null, locationUnavailableReason: 'permission_denied' });
  });

  it('blocks direct delivered status changes and keeps the OTP provider limitation explicit', async () => {
    await request(app).patch(`/api/agent/deliveries/${dispatchId}/status`).set('Cookie', agentCookie).send({ status: 'delivered' }).expect(409);
    await DispatchRequest.updateOne({ _id: dispatchId }, { $set: { status: 'in_transit' } });
    await request(app).patch(`/api/dispatch-requests/${dispatchId}/status`).set('Cookie', adminCookie).send({ status: 'delivered' }).expect(409);
    await uploadPhoto();
    process.env.POD_DEV_OTP_ENABLED = 'false';
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/otp`).set('Cookie', agentCookie).expect(503);
    process.env.POD_DEV_OTP_ENABLED = 'true';
    expect((await DispatchRequest.findById(dispatchId))?.status).toBe('in_transit');
  });

  it('allows Admins to inspect submitted evidence and denies operators', async () => {
    await moveToInTransit();
    await prepareVerifiedEvidence();
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/submit`).set('Cookie', agentCookie).send({ locationUnavailableReason: 'not_available' }).expect(201);
    const list = await request(app).get('/api/admin/pod').set('Cookie', adminCookie).expect(200);
    expect(list.body.data.records).toHaveLength(1);
    expect(list.body.data.records[0].photo).not.toHaveProperty('storageKey');
    await request(app).get(`/api/admin/pod/${dispatchId}`).set('Cookie', operatorCookie).expect(403);
    await request(app).get(`/api/admin/pod/${dispatchId}`).set('Cookie', adminCookie).expect(200);
    const image = await request(app).get(`/api/admin/pod/${dispatchId}/evidence/photo`).set('Cookie', adminCookie).expect(200);
    expect(image.headers['content-type']).toContain('image/png');
    expect(image.headers['content-disposition']).toContain('inline');
    expect(image.body).toEqual(pngFixture);
    await request(app).get(`/api/admin/pod/${dispatchId}/evidence/photo`).set('Cookie', operatorCookie).expect(403);
    await request(app).get(`/api/admin/pod/${dispatchId}/evidence/photo`).expect(401);
    const savedPod = await ProofOfDelivery.findOne({ dispatchRequestId: dispatchId }).lean();
    await unlink(join(testStorageDirectory, savedPod!.photo.storageKey));
    const missingImage = await request(app)
      .get(`/api/admin/pod/${dispatchId}/evidence/photo`)
      .set('Cookie', adminCookie)
      .expect(404);
    expect(missingImage.body.message).toBe('Proof file not found.');
  });

  it('continues reading legacy local proof metadata without a storage provider', async () => {
    await moveToInTransit();
    await prepareVerifiedEvidence();
    await request(app).post(`/api/agent/deliveries/${dispatchId}/pod/submit`)
      .set('Cookie', agentCookie).send({ locationUnavailableReason: 'not_available' }).expect(201);
    await ProofOfDelivery.updateOne(
      { dispatchRequestId: dispatchId },
      { $unset: { 'photo.storageProvider': 1 } },
    );

    const response = await request(app)
      .get(`/api/admin/pod/${dispatchId}/evidence/photo`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(response.body).toEqual(pngFixture);
  });
});

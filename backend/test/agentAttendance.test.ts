import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { Agent } from '../src/models/Agent.js';
import { AgentAttendance } from '../src/models/AgentAttendance.js';
import { User } from '../src/models/User.js';
import { ensureAgentCollections } from '../src/services/agentService.js';
import {
  attendanceDateInIndia,
  checkInAgent,
  checkOutAgent,
  ensureAgentAttendanceCollections,
  getAgentAttendanceHistory,
} from '../src/services/agentAttendanceService.js';
import { createAccessToken } from '../src/utils/jwt.js';
import { createAgentAccessToken } from '../src/utils/agentJwt.js';

const password = 'AttendanceAgentPass123!';
let mongo: MongoMemoryReplSet;
let adminCookie = '';
let operatorCookie = '';
let agentCookie = '';
let otherAgentCookie = '';
let agentId = '';
let otherAgentId = '';
let agentObjectId: mongoose.Types.ObjectId;
let otherAgentObjectId: mongoose.Types.ObjectId;

const agentInput = (email: string, registrationNumber: string, name: string) => ({
  agentCode: `AGT-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
  name,
  email,
  passwordHash: '$2a$04$Uq2bQm8o5x2fMHeC2xXz0eRKk/LjrD4gMpQbYTLhsKQXjWpXmY0W2',
  phone: '+91 98765 43210',
  vehicle: { vehicleType: 'van', registrationNumber, manufacturer: 'Tata', model: 'Ace' },
  capacity: { maxOrders: 4 },
});

function userCookie(id: string) { return `swerv_access=${createAccessToken(id)}`; }
function agentAuthCookie(id: string) { return `swerv_agent_access=${createAgentAccessToken(id)}`; }

async function addAttendance(agent: mongoose.Types.ObjectId, date: string, durationMinutes: number | null) {
  const checkInAt = new Date(`${date}T03:30:00.000Z`);
  return AgentAttendance.create({
    agentId: agent,
    attendanceDate: date,
    checkInAt,
    checkOutAt: durationMinutes === null ? null : new Date(checkInAt.getTime() + durationMinutes * 60_000),
  });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'swerv-attendance-user-secret-0123456789';
  process.env.JWT_EXPIRES_IN = '1d';
  process.env.AGENT_JWT_SECRET = 'swerv-attendance-agent-secret-0123456789';
  process.env.AGENT_JWT_EXPIRES_IN = '1d';
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([ensureAgentCollections(), ensureAgentAttendanceCollections()]);
});

beforeEach(async () => {
  await Promise.all([AgentAttendance.deleteMany({}), Agent.deleteMany({}), User.deleteMany({})]);
  const [admin, operator] = await User.create([
    { name: 'Attendance Admin', email: 'attendance-admin@example.com', password: 'CorrectHorse9!', role: 'admin' },
    { name: 'Attendance Operator', email: 'attendance-operator@example.com', password: 'CorrectHorse9!', role: 'operator' },
  ]);
  const [agent, otherAgent] = await Agent.create([
    agentInput('attendance-agent@example.com', 'ATT-1001', 'Morgan Lee'),
    agentInput('other-attendance-agent@example.com', 'ATT-1002', 'Taylor Reed'),
  ]);
  agentId = agent.id;
  otherAgentId = otherAgent.id;
  agentObjectId = agent._id;
  otherAgentObjectId = otherAgent._id;
  adminCookie = userCookie(admin.id);
  operatorCookie = userCookie(operator.id);
  agentCookie = agentAuthCookie(agent.id);
  otherAgentCookie = agentAuthCookie(otherAgent.id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('Agent Attendance API', () => {
  it('calculates attendance dates at the IST midnight boundary', () => {
    expect(attendanceDateInIndia(new Date('2026-01-14T18:29:59.999Z'))).toBe('2026-01-14');
    expect(attendanceDateInIndia(new Date('2026-01-14T18:30:00.000Z'))).toBe('2026-01-15');
  });

  it('keeps the check-in date across IST midnight and allows the next day after checkout', async () => {
    const beforeMidnight = new Date('2026-03-01T18:29:00.000Z');
    const afterMidnight = new Date('2026-03-01T18:31:00.000Z');

    const priorRecord = await checkInAgent(agentId, beforeMidnight);
    expect(priorRecord.attendanceDate).toBe('2026-03-01');
    const historyBeforeCheckout = await getAgentAttendanceHistory(agentId, { page: 1, limit: 10 });
    expect(historyBeforeCheckout.todayAttendance?.attendanceDate).toBe('2026-03-01');

    await expect(checkInAgent(agentId, afterMidnight)).rejects.toMatchObject({ status: 409 });

    const checkedOutRecord = await checkOutAgent(agentId, afterMidnight);
    expect(checkedOutRecord._id.toString()).toBe(priorRecord._id.toString());
    expect(checkedOutRecord.attendanceDate).toBe('2026-03-01');
    expect(checkedOutRecord.checkOutAt?.toISOString()).toBe(afterMidnight.toISOString());

    const nextDayRecord = await checkInAgent(agentId, new Date('2026-03-01T18:32:00.000Z'));
    expect(nextDayRecord.attendanceDate).toBe('2026-03-02');
    expect(await AgentAttendance.countDocuments({ agentId })).toBe(2);
  });

  it('requires an Agent session and returns only that agent’s history', async () => {
    await addAttendance(agentObjectId, '2026-03-01', 60);
    await addAttendance(otherAgentObjectId, '2026-03-02', 30);

    await request(app).get('/api/agent/attendance/me').expect(401);
    const response = await request(app).get('/api/agent/attendance/me?agentId=' + otherAgentId)
      .set('Cookie', agentCookie).expect(400);
    expect(response.body.success).toBe(false);

    const history = await request(app).get('/api/agent/attendance/me')
      .set('Cookie', agentCookie).expect(200);
    expect(history.body.data.records).toHaveLength(1);
    expect(history.body.data.records[0].agentId).toBe(agentId);
    expect(history.body.data.summary).toMatchObject({ totalRecords: 1, completedCheckouts: 1, openRecords: 0 });
  });

  it('uses a server timestamp and the authenticated agent for check-in', async () => {
    const beforeRequest = Date.now();
    const response = await request(app).post('/api/agent/attendance/check-in')
      .set('Cookie', agentCookie)
      .send({ agentId: otherAgentId, checkInAt: '2000-01-01T00:00:00Z', attendanceDate: '2000-01-01' })
      .expect(201);
    const afterRequest = Date.now();
    const { attendance } = response.body.data;

    expect(attendance.agentId).toBe(agentId);
    expect(attendanceDateInIndia(new Date(attendance.checkInAt))).toBe(attendance.attendanceDate);
    expect(new Date(attendance.checkInAt).getTime()).toBeGreaterThanOrEqual(beforeRequest);
    expect(new Date(attendance.checkInAt).getTime()).toBeLessThanOrEqual(afterRequest);
    expect(attendance.checkOutAt).toBeNull();
  });

  it('rejects duplicate check-in, including concurrent requests', async () => {
    const results = await Promise.all([
      request(app).post('/api/agent/attendance/check-in').set('Cookie', agentCookie).send({}),
      request(app).post('/api/agent/attendance/check-in').set('Cookie', agentCookie).send({}),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await AgentAttendance.countDocuments({ agentId })).toBe(1);

    await request(app).post('/api/agent/attendance/check-in').set('Cookie', agentCookie).send({}).expect(409);
  });

  it('requires a check-in and allows one server-timestamped checkout', async () => {
    await request(app).post('/api/agent/attendance/check-out').set('Cookie', agentCookie).send({}).expect(409);
    const checkInResponse = await request(app).post('/api/agent/attendance/check-in').set('Cookie', agentCookie).send({}).expect(201);
    const beforeCheckout = Date.now();
    const checkoutResponse = await request(app).post('/api/agent/attendance/check-out')
      .set('Cookie', agentCookie).send({ checkOutAt: '2000-01-01T00:00:00Z' }).expect(200);
    const afterCheckout = Date.now();
    expect(new Date(checkoutResponse.body.data.attendance.checkOutAt).getTime()).toBeGreaterThanOrEqual(beforeCheckout);
    expect(new Date(checkoutResponse.body.data.attendance.checkOutAt).getTime()).toBeLessThanOrEqual(afterCheckout);
    expect(checkoutResponse.body.data.attendance._id).toBe(checkInResponse.body.data.attendance._id);
    await request(app).post('/api/agent/attendance/check-out').set('Cookie', agentCookie).send({}).expect(409);
  });

  it('allows only one concurrent checkout to close an open record', async () => {
    await request(app).post('/api/agent/attendance/check-in').set('Cookie', agentCookie).send({}).expect(201);
    const responses = await Promise.all([
      request(app).post('/api/agent/attendance/check-out').set('Cookie', agentCookie).send({}),
      request(app).post('/api/agent/attendance/check-out').set('Cookie', agentCookie).send({}),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await AgentAttendance.countDocuments({ agentId, checkOutAt: { $ne: null } })).toBe(1);
  });

  it('filters, paginates, and summarizes an agent’s history', async () => {
    await addAttendance(agentObjectId, '2026-03-01', 60);
    await addAttendance(agentObjectId, '2026-03-02', null);
    await addAttendance(agentObjectId, '2026-03-03', 30);
    const response = await request(app).get('/api/agent/attendance/me?startDate=2026-03-02&endDate=2026-03-03&page=1&limit=1')
      .set('Cookie', agentCookie).expect(200);
    expect(response.body.data.records).toHaveLength(1);
    expect(response.body.data.records[0].attendanceDate).toBe('2026-03-03');
    expect(response.body.data.pagination).toMatchObject({ page: 1, limit: 1, total: 2, pages: 2 });
    expect(response.body.data.summary).toMatchObject({ totalRecords: 2, completedCheckouts: 1, openRecords: 1, totalDurationMinutes: 30 });
  });

  it('allows Admins and Operators to filter attendance without exposing credentials', async () => {
    await addAttendance(agentObjectId, '2026-03-03', 90);
    await addAttendance(otherAgentObjectId, '2026-03-03', null);

    await request(app).get('/api/agent-attendance').expect(401);
    await request(app).get('/api/agent-attendance').set('Cookie', agentCookie).expect(401);

    for (const cookie of [adminCookie, operatorCookie]) {
      const response = await request(app).get(`/api/agent-attendance?agentId=${agentId}&search=Morgan&startDate=2026-03-03&endDate=2026-03-03`)
        .set('Cookie', cookie).expect(200);
      expect(response.body.data.records).toHaveLength(1);
      expect(response.body.data.records[0]).toMatchObject({
        agent: { name: 'Morgan Lee', email: 'attendance-agent@example.com' },
        durationMinutes: 90,
        status: 'checked_out',
      });
      expect(response.body.data.records[0].agent).not.toHaveProperty('passwordHash');
      expect(response.body.data.summary).toMatchObject({ totalRecords: 1, completedCheckouts: 1, openRecords: 0, totalDurationMinutes: 90 });
    }
  });

  it('rejects invalid admin filters and applies pagination', async () => {
    await addAttendance(agentObjectId, '2026-03-01', 10);
    await addAttendance(agentObjectId, '2026-03-02', 20);
    await addAttendance(otherAgentObjectId, '2026-03-03', 30);

    await request(app).get('/api/agent-attendance?startDate=2026-03-04&endDate=2026-03-01')
      .set('Cookie', operatorCookie).expect(400);
    await request(app).get('/api/agent-attendance?startDate=2026-02-30')
      .set('Cookie', operatorCookie).expect(400);

    const response = await request(app).get('/api/agent-attendance?page=2&limit=1&search=Morgan')
      .set('Cookie', operatorCookie).expect(200);
    expect(response.body.data.records).toHaveLength(1);
    expect(response.body.data.pagination).toMatchObject({ page: 2, limit: 1, total: 2, pages: 2 });
  });
});

import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { Agent } from '../models/Agent.js';
import { AgentDeviceCredential } from '../models/AgentDeviceCredential.js';
import { AgentLocation } from '../models/AgentLocation.js';
import { DispatchRequest } from '../models/DispatchRequest.js';
import { HttpError } from '../utils/httpError.js';

type LocationInput = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  recordedAt: Date;
};

export const agentBrowserGpsSessionDurationMs = 8 * 60 * 60 * 1_000;

async function runTransaction<T>(work: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
  } finally {
    await session.endSession();
  }
  if (result === undefined) throw new Error('Agent location transaction did not complete.');
  return result;
}

export async function generateAgentDeviceCredential(agentId: string) {
  return runTransaction(async (session) => {
    const activeAgent = await Agent.updateOne(
      { _id: agentId, isActive: true },
      { $inc: { __v: 1 } },
      { session, timestamps: false },
    );
    if (!activeAgent.matchedCount) throw new HttpError(404, 'Active agent not found.');

    const token = `swerv_agent_${randomBytes(32).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await AgentDeviceCredential.updateMany(
      { agentId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    await AgentDeviceCredential.create([{ agentId, tokenHash }], { session });
    return { token };
  });
}

async function ensureAgentCanReportLocation(agentId: string, session: mongoose.ClientSession) {
  const activeAgent = await Agent.findOne({ _id: agentId, isActive: true })
    .select('status').session(session);
  if (!activeAgent) throw new HttpError(404, 'Active agent not found.');
  const hasActiveDelivery = await DispatchRequest.exists({
    assignedAgent: agentId,
    status: { $in: ['assigned', 'picked_up', 'in_transit'] },
  }).session(session);
  if (activeAgent.status !== 'on_duty' && !hasActiveDelivery) {
    throw new HttpError(403, 'Location updates are allowed only while on duty or assigned to an active delivery.');
  }
}

export async function createAgentBrowserGpsCredential(agentId: string) {
  return runTransaction(async (session) => {
    await ensureAgentCanReportLocation(agentId, session);
    const token = `swerv_agent_gps_${randomBytes(32).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + agentBrowserGpsSessionDurationMs);
    await AgentDeviceCredential.updateMany(
      { agentId, credentialType: 'browser', revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    await AgentDeviceCredential.create([{
      agentId,
      credentialType: 'browser',
      tokenHash,
      expiresAt,
    }], { session });
    return { token, expiresAt };
  });
}

export async function revokeAgentBrowserGpsCredential(agentId: string, token: string) {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await AgentDeviceCredential.updateOne(
    { agentId, credentialType: 'browser', tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAgentDeviceCredentials(agentId: string) {
  const agentExists = await Agent.exists({ _id: agentId });
  if (!agentExists) throw new HttpError(404, 'Agent not found.');
  const result = await AgentDeviceCredential.updateMany(
    { agentId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  return { revokedCount: result.modifiedCount };
}

export async function recordAgentLocation(agentId: string, input: LocationInput) {
  return runTransaction(async (session) => {
    await ensureAgentCanReportLocation(agentId, session);

    const [location] = await AgentLocation.create(
      [{ agentId, ...input, receivedAt: new Date() }],
      { session },
    );
    return location;
  });
}

export async function getLatestAgentLocations() {
  return AgentLocation.aggregate([
    { $sort: { agentId: 1, recordedAt: -1, receivedAt: -1 } },
    { $group: { _id: '$agentId', location: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$location' } },
    {
      $lookup: {
        from: Agent.collection.name,
        localField: 'agentId',
        foreignField: '_id',
        as: 'agent',
      },
    },
    { $unwind: '$agent' },
    { $match: { 'agent.isActive': true } },
    { $sort: { receivedAt: -1 } },
    {
      $project: {
        agentId: 1,
        latitude: 1,
        longitude: 1,
        accuracy: 1,
        speed: 1,
        heading: 1,
        recordedAt: 1,
        receivedAt: 1,
        agent: { _id: 1, agentCode: 1, name: 1, status: 1, vehicle: 1 },
      },
    },
  ]);
}

export async function getAgentLocationHistory(
  agentId: string,
  page: number,
  limit: number,
) {
  if (!(await Agent.exists({ _id: agentId }))) throw new HttpError(404, 'Agent not found.');
  const filter = { agentId };
  const [locations, total] = await Promise.all([
    AgentLocation.find(filter)
      .sort({ recordedAt: -1, receivedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AgentLocation.countDocuments(filter),
  ]);
  return {
    locations,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

export async function ensureAgentLocationCollections(): Promise<void> {
  await Promise.all([AgentDeviceCredential.init(), AgentLocation.init()]);
}

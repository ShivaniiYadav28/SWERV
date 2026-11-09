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
export const agentLocationMinimumIntervalMs = 15_000;
export const agentLocationMaximumAgeMs = 2 * 60_000;

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

async function ensureAgentCanReportLocation(
  agentId: string,
  session: mongoose.ClientSession,
  requireActiveDelivery = false,
) {
  const activeAgent = await Agent.findOne({ _id: agentId, isActive: true })
    .select('status').session(session);
  if (!activeAgent) throw new HttpError(404, 'Active agent not found.');
  const hasActiveDelivery = await DispatchRequest.exists({
    assignedAgent: agentId,
    status: { $in: ['assigned', 'picked_up', 'in_transit'] },
  }).session(session);
  if (!hasActiveDelivery && (requireActiveDelivery || activeAgent.status !== 'on_duty')) {
    throw new HttpError(403, requireActiveDelivery
      ? 'Browser GPS is available only during an active delivery.'
      : 'Location updates are allowed only while on duty or assigned to an active delivery.');
  }
  return activeAgent;
}

export async function createAgentBrowserGpsCredential(agentId: string) {
  return runTransaction(async (session) => {
    await ensureAgentCanReportLocation(agentId, session, true);
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

export async function recordAgentLocation(agentId: string, input: LocationInput, requireActiveDelivery = false) {
  const now = new Date();
  if (now.getTime() - input.recordedAt.getTime() > agentLocationMaximumAgeMs) {
    throw new HttpError(400, 'Location update is too old. Send a fresh GPS reading.');
  }
  return runTransaction(async (session) => {
    const agent = await ensureAgentCanReportLocation(agentId, session, requireActiveDelivery);
    const cutoff = new Date(now.getTime() - agentLocationMinimumIntervalMs);
    const throttle = await Agent.updateOne({
      _id: agentId,
      isActive: true,
      $or: [
        { lastLocationReceivedAt: { $exists: false } },
        { lastLocationReceivedAt: null },
        { lastLocationReceivedAt: { $lte: cutoff } },
      ],
    }, { $set: { lastLocationReceivedAt: now } }, { session });
    if (!throttle.matchedCount) throw new HttpError(429, 'Location update received too soon. Wait before sending another GPS reading.');

    const [location] = await AgentLocation.create(
      [{ agentId, ...input, receivedAt: now }],
      { session },
    );
    const [activeDispatch, agentDetails] = await Promise.all([
      DispatchRequest.findOne({ assignedAgent: agentId, status: { $in: ['assigned', 'picked_up', 'in_transit'] } })
        .select('_id status priority').sort({ updatedAt: -1 }).session(session).lean(),
      Agent.findById(agentId).select('_id agentCode name status vehicle').session(session).lean(),
    ]);
    if (!agentDetails) throw new HttpError(404, 'Active agent not found.');
    return {
      location,
      fleetLocation: {
        agentId,
        latitude: location.latitude,
        longitude: location.longitude,
        ...(location.accuracy == null ? {} : { accuracy: location.accuracy }),
        ...(location.speed == null ? {} : { speed: location.speed }),
        ...(location.heading == null ? {} : { heading: location.heading }),
        recordedAt: location.recordedAt.toISOString(),
        receivedAt: location.receivedAt.toISOString(),
        agent: {
          _id: agentDetails._id.toString(),
          agentCode: agentDetails.agentCode,
          name: agentDetails.name,
          status: agentDetails.status,
          vehicle: agentDetails.vehicle,
        },
        activeDispatch: activeDispatch ? {
          _id: activeDispatch._id.toString(),
          status: activeDispatch.status,
          priority: activeDispatch.priority,
        } : null,
      },
    };
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
    {
      $lookup: {
        from: DispatchRequest.collection.name,
        let: { assignedAgentId: '$agentId' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$assignedAgent', '$$assignedAgentId'] },
            { $in: ['$status', ['assigned', 'picked_up', 'in_transit']] },
          ] } } },
          { $sort: { updatedAt: -1 } },
          { $limit: 1 },
          { $project: { _id: 1, status: 1, priority: 1 } },
        ],
        as: 'activeDispatch',
      },
    },
    { $set: { activeDispatch: { $ifNull: [{ $first: '$activeDispatch' }, null] } } },
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
        activeDispatch: 1,
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

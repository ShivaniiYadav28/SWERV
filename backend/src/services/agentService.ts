import { randomBytes } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { Agent, type AgentStatus } from '../models/Agent.js';
import { AgentActivity, type AgentEventType } from '../models/AgentActivity.js';
import { HttpError } from '../utils/httpError.js';

type AgentInput = {
  name: string;
  email: string;
  phone: string;
  vehicle: { vehicleType: string; registrationNumber: string; manufacturer: string; model: string };
  capacity: { maxOrders: number };
  capabilities: string[];
};

async function recordActivity(
  session: ClientSession,
  agentId: mongoose.Types.ObjectId,
  performedBy: string,
  eventType: AgentEventType,
  description: string,
  previousValue?: unknown,
  newValue?: unknown,
): Promise<void> {
  await AgentActivity.create([{
    agentId, performedBy, eventType, description, previousValue, newValue,
  }], { session });
}

async function runTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => { result = await work(session); });
  } finally {
    await session.endSession();
  }
  if (result === undefined) throw new Error('Agent transaction did not complete.');
  return result;
}

export async function createAgent(input: AgentInput, performedBy: string) {
  return runTransaction(async (session) => {
    const agent = new Agent({
      ...input,
      agentCode: `AGT-${randomBytes(5).toString('hex').toUpperCase()}`,
    });
    await agent.save({ session });
    await recordActivity(session, agent._id, performedBy, 'agent_created', 'Agent registered.', undefined, {
      name: agent.name, status: agent.status,
    });
    return agent;
  });
}

export async function updateAgent(id: string, input: Partial<AgentInput>, performedBy: string) {
  return runTransaction(async (session) => {
    const agent = await Agent.findOne({ _id: id, isActive: true }).session(session);
    if (!agent) throw new HttpError(404, 'Active agent not found.');
    const previousValue: Record<string, unknown> = {};
    for (const key of Object.keys(input) as (keyof AgentInput)[]) {
      previousValue[key] = agent.get(key);
      agent.set(key, input[key]);
    }
    if (Object.keys(previousValue).every((key) => JSON.stringify(previousValue[key]) === JSON.stringify(input[key as keyof AgentInput]))) {
      return agent;
    }
    await agent.save({ session });
    await recordActivity(session, agent._id, performedBy, 'agent_updated', 'Agent details updated.', previousValue, input);
    return agent;
  });
}

const statusTransitions: Record<AgentStatus, AgentStatus[]> = {
  available: ['unavailable', 'on_duty', 'suspended'],
  unavailable: ['available', 'suspended'],
  on_duty: ['available', 'unavailable', 'suspended'],
  suspended: ['unavailable'],
};

export async function changeAgentStatus(id: string, status: AgentStatus, performedBy: string, isAdmin: boolean) {
  return runTransaction(async (session) => {
    const agent = await Agent.findOne({ _id: id, isActive: true }).session(session);
    if (!agent) throw new HttpError(404, 'Active agent not found.');
    if ((agent.status === 'suspended' || status === 'suspended') && !isAdmin) {
      throw new HttpError(403, 'Only administrators can suspend or reinstate an agent.');
    }
    if (!statusTransitions[agent.status].includes(status)) {
      throw new HttpError(400, `Status cannot change from ${agent.status} to ${status}.`);
    }
    const previousStatus = agent.status;
    agent.status = status;
    await agent.save({ session });
    await recordActivity(session, agent._id, performedBy, 'status_changed', `Status changed from ${previousStatus} to ${status}.`, { status: previousStatus }, { status });
    return agent;
  });
}

export async function archiveAgent(id: string, performedBy: string) {
  return runTransaction(async (session) => {
    const agent = await Agent.findOne({ _id: id, isActive: true }).session(session);
    if (!agent) throw new HttpError(404, 'Active agent not found.');
    agent.isActive = false;
    await agent.save({ session });
    await recordActivity(session, agent._id, performedBy, 'agent_archived', 'Agent archived.', { isActive: true }, { isActive: false });
    return agent;
  });
}

export async function restoreAgent(id: string, performedBy: string) {
  return runTransaction(async (session) => {
    const agent = await Agent.findById(id).session(session);
    if (!agent) throw new HttpError(404, 'Agent not found.');
    if (agent.isActive) throw new HttpError(409, 'Agent is already active.');

    agent.isActive = true;
    await agent.save({ session });
    await recordActivity(
      session,
      agent._id,
      performedBy,
      'agent_restored',
      'Agent restored.',
      { isActive: false },
      { isActive: true },
    );
    return agent;
  });
}

export async function ensureAgentCollections(): Promise<void> {
  await Promise.all([Agent.init(), AgentActivity.init()]);
}

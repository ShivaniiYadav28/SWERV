import type { RequestHandler } from 'express';
import { Agent } from '../models/Agent.js';
import { AgentActivity } from '../models/AgentActivity.js';
import { archiveAgent, changeAgentStatus, createAgent, restoreAgent, updateAgent } from '../services/agentService.js';
import { HttpError } from '../utils/httpError.js';
import { publishNotification } from '../realtime/socketServer.js';
import { createAgentSchema, listQuerySchema, parseAgentId, parseRequest, statusSchema, updateAgentSchema } from '../utils/agentValidation.js';

function actorId(req: Parameters<RequestHandler>[0]): string {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return req.user.id;
}

export const createAgentHandler: RequestHandler = async (req, res) => {
  const input = parseRequest(createAgentSchema, req.body);
  const agent = await createAgent(input, actorId(req));
  res.status(201).json({ success: true, message: 'Agent registered successfully.', data: { agent } });
};

export const listAgentsHandler: RequestHandler = async (req, res) => {
  const query = parseRequest(listQuerySchema, req.query);
  const filter: Record<string, unknown> = { isActive: query.isActive };
  if (query.status) filter.status = query.status;
  if (query.vehicleType) filter['vehicle.vehicleType'] = query.vehicleType;
  if (query.capability) filter.capabilities = query.capability;
  if (query.search) {
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const search = new RegExp(escaped, 'i');
    filter.$or = [{ name: search }, { email: search }, { agentCode: search }];
  }
  const skip = (query.page - 1) * query.limit;
  const [agents, total] = await Promise.all([
    Agent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
    Agent.countDocuments(filter),
  ]);
  res.json({ success: true, message: 'Agents retrieved successfully.', data: { agents, pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } } });
};

export const getAgentHandler: RequestHandler = async (req, res) => {
  const id = parseAgentId(req.params.id);
  const agent = await Agent.findById(id).lean();
  if (!agent) throw new HttpError(404, 'Agent not found.');
  const activity = await AgentActivity.find({ agentId: id }).sort({ createdAt: -1 }).limit(20).populate('performedBy', 'name email').lean();
  res.json({ success: true, message: 'Agent retrieved successfully.', data: { agent, activity } });
};

export const updateAgentHandler: RequestHandler = async (req, res) => {
  const id = parseAgentId(req.params.id);
  const input = parseRequest(updateAgentSchema, req.body);
  const agent = await updateAgent(id, input, actorId(req));
  res.json({ success: true, message: 'Agent updated successfully.', data: { agent } });
};

export const changeAgentStatusHandler: RequestHandler = async (req, res) => {
  const id = parseAgentId(req.params.id);
  const { status } = parseRequest(statusSchema, req.body);
  const { agent, notifications } = await changeAgentStatus(id, status, actorId(req), req.user?.role === 'admin');
  notifications.forEach(publishNotification);
  res.json({ success: true, message: 'Agent status updated successfully.', data: { agent } });
};

export const archiveAgentHandler: RequestHandler = async (req, res) => {
  const id = parseAgentId(req.params.id);
  const { agent, notifications } = await archiveAgent(id, actorId(req));
  notifications.forEach(publishNotification);
  res.json({ success: true, message: 'Agent archived successfully.', data: { agent } });
};

export const restoreAgentHandler: RequestHandler = async (req, res) => {
  const id = parseAgentId(req.params.id);
  const { agent, notifications } = await restoreAgent(id, actorId(req));
  notifications.forEach(publishNotification);
  res.json({
    success: true,
    message: 'Agent restored successfully.',
    data: { agent },
  });
};

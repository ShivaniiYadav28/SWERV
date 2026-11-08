import type { RequestHandler } from 'express';
import { AGENT_AUTH_COOKIE_NAME } from '../utils/agentJwt.js';
import { getActiveAgentById, verifyAgentToken } from '../services/agentAuthService.js';

export const requireAgentAuth: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[AGENT_AUTH_COOKIE_NAME];
  if (!token || typeof token !== 'string') {
    res.status(401).json({ success: false, message: 'Agent authentication required.' });
    return;
  }
  const agentId = verifyAgentToken(token);
  const agent = agentId ? await getActiveAgentById(agentId) : null;
  if (!agent) {
    res.status(401).json({ success: false, message: 'Invalid, expired, or inactive agent session.' });
    return;
  }
  req.agent = agent;
  req.agentId = agent.id;
  next();
};

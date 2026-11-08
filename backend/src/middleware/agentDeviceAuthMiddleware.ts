import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { Agent } from '../models/Agent.js';
import { AgentDeviceCredential } from '../models/AgentDeviceCredential.js';
import { AGENT_GPS_COOKIE_NAME, agentGpsCookieOptions } from '../utils/agentGpsCookie.js';

function unauthorized(res: Parameters<RequestHandler>[1]) {
  res.status(401).json({ success: false, message: 'Valid agent device credentials are required.' });
}

export const requireAgentDevice: RequestHandler = async (req, res, next) => {
  const authorization = req.get('authorization');
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    unauthorized(res);
    return;
  }

  const tokenHash = createHash('sha256').update(match[1]).digest('hex');
  const credential = await AgentDeviceCredential.findOne({
    tokenHash,
    revokedAt: null,
    $and: [
      { $or: [{ credentialType: 'device' }, { credentialType: { $exists: false } }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
    ],
  })
    .select('agentId')
    .lean();
  if (!credential) {
    unauthorized(res);
    return;
  }

  const agent = await Agent.findOne({ _id: credential.agentId, isActive: true })
    .select('_id')
    .lean();
  if (!agent) {
    unauthorized(res);
    return;
  }

  req.agentId = agent._id.toString();
  next();
};

export const requireAgentGpsCookie: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[AGENT_GPS_COOKIE_NAME];
  if (typeof token !== 'string' || !token) {
    res.clearCookie(AGENT_GPS_COOKIE_NAME, agentGpsCookieOptions());
    unauthorized(res);
    return;
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const credential = await AgentDeviceCredential.findOne({
    tokenHash,
    credentialType: 'browser',
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).select('agentId').lean();
  if (!credential) {
    res.clearCookie(AGENT_GPS_COOKIE_NAME, agentGpsCookieOptions());
    unauthorized(res);
    return;
  }

  const agent = await Agent.findOne({ _id: credential.agentId, isActive: true }).select('_id').lean();
  if (!agent) {
    res.clearCookie(AGENT_GPS_COOKIE_NAME, agentGpsCookieOptions());
    unauthorized(res);
    return;
  }

  req.agentId = agent._id.toString();
  next();
};

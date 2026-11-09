import type { RequestHandler } from 'express';
import {
  generateAgentDeviceCredential,
  createAgentBrowserGpsCredential,
  agentBrowserGpsSessionDurationMs,
  getAgentLocationHistory,
  getLatestAgentLocations,
  recordAgentLocation,
  revokeAgentBrowserGpsCredential,
  revokeAgentDeviceCredentials,
} from '../services/agentLocationService.js';
import { HttpError } from '../utils/httpError.js';
import { AGENT_GPS_COOKIE_NAME, agentGpsCookieOptions } from '../utils/agentGpsCookie.js';
import { parseAgentId } from '../utils/agentValidation.js';
import {
  locationHistoryQuerySchema,
  parseLocationRequest,
  submitAgentLocationSchema,
} from '../utils/agentLocationValidation.js';
import { publishFleetLocation } from '../realtime/socketServer.js';

export const generateAgentDeviceCredentialHandler: RequestHandler = async (req, res) => {
  const agentId = parseAgentId(req.params.id);
  const result = await generateAgentDeviceCredential(agentId);
  res.status(201).json({
    success: true,
    message: 'Device credential generated. Copy it now; it will not be shown again.',
    data: { agentId, credential: result.token },
  });
};

export const revokeAgentDeviceCredentialsHandler: RequestHandler = async (req, res) => {
  const agentId = parseAgentId(req.params.id);
  const result = await revokeAgentDeviceCredentials(agentId);
  res.json({
    success: true,
    message: 'Agent device credentials revoked.',
    data: { agentId, ...result },
  });
};

export const createAgentBrowserGpsSessionHandler: RequestHandler = async (req, res) => {
  if (!req.agentId) throw new HttpError(401, 'Agent authentication required.');
  const result = await createAgentBrowserGpsCredential(req.agentId);
  res.cookie(AGENT_GPS_COOKIE_NAME, result.token, {
    ...agentGpsCookieOptions(),
    maxAge: agentBrowserGpsSessionDurationMs,
  });
  res.json({
    success: true,
    message: 'Secure GPS session started.',
    data: { expiresAt: result.expiresAt },
  });
};

export const stopAgentBrowserGpsSessionHandler: RequestHandler = async (req, res) => {
  if (!req.agentId) throw new HttpError(401, 'Valid GPS session is required.');
  const token = req.cookies?.[AGENT_GPS_COOKIE_NAME];
  if (typeof token === 'string') {
    await revokeAgentBrowserGpsCredential(req.agentId, token);
  }
  res.clearCookie(AGENT_GPS_COOKIE_NAME, agentGpsCookieOptions());
  res.json({ success: true, message: 'GPS session stopped.', data: null });
};

async function submitLocation(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], requireActiveDelivery: boolean) {
  if (!req.agentId) throw new HttpError(401, 'Valid agent device credentials are required.');
  const input = parseLocationRequest(submitAgentLocationSchema, req.body);
  const result = await recordAgentLocation(req.agentId, input, requireActiveDelivery);
  publishFleetLocation(result.fleetLocation);
  res.status(201).json({ success: true, message: 'Agent location recorded.', data: { location: result.location } });
}

export const submitAgentLocationHandler: RequestHandler = async (req, res) => submitLocation(req, res, false);

export const submitAgentBrowserLocationHandler: RequestHandler = async (req, res) => submitLocation(req, res, true);

export const listLatestAgentLocationsHandler: RequestHandler = async (_req, res) => {
  const locations = await getLatestAgentLocations();
  res.json({
    success: true,
    message: 'Latest agent locations retrieved successfully.',
    data: { locations },
  });
};

export const getAgentLocationHistoryHandler: RequestHandler = async (req, res) => {
  const agentId = parseAgentId(req.params.agentId);
  const query = parseLocationRequest(locationHistoryQuerySchema, req.query);
  const result = await getAgentLocationHistory(agentId, query.page, query.limit);
  res.json({
    success: true,
    message: 'Agent location history retrieved successfully.',
    data: { agentId, ...result },
  });
};

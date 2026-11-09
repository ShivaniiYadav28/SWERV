import type { CookieOptions, RequestHandler, Response } from 'express';
import { authenticateAgent, setAgentPassword } from '../services/agentAuthService.js';
import { parseAgentId, parseRequest, agentLoginSchema, setAgentPasswordSchema, resetAgentPasswordSchema } from '../utils/agentValidation.js';
import { AGENT_AUTH_COOKIE_NAME, getAgentTokenMaxAge } from '../utils/agentJwt.js';
import { AGENT_GPS_COOKIE_NAME, agentGpsCookieOptions } from '../utils/agentGpsCookie.js';

function cookieOptions(): CookieOptions {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' };
}

function setAgentCookie(res: Response, token: string) {
  res.cookie(AGENT_AUTH_COOKIE_NAME, token, { ...cookieOptions(), maxAge: getAgentTokenMaxAge() });
}

export const agentLoginHandler: RequestHandler = async (req, res) => {
  const input = parseRequest(agentLoginSchema, req.body);
  const result = await authenticateAgent(input.email, input.password);
  if (!result) {
    res.status(401).json({ success: false, message: 'Invalid email or password.' });
    return;
  }
  setAgentCookie(res, result.token);
  res.json({ success: true, message: 'Agent signed in.', data: { agent: result.agent } });
};

export const agentLogoutHandler: RequestHandler = (_req, res) => {
  res.clearCookie(AGENT_AUTH_COOKIE_NAME, cookieOptions());
  res.clearCookie(AGENT_GPS_COOKIE_NAME, agentGpsCookieOptions());
  res.json({ success: true, message: 'Agent signed out.', data: null });
};

export const currentAgentHandler: RequestHandler = (req, res) => {
  res.json({ success: true, message: 'Current agent.', data: { agent: req.agent } });
};

export const setAgentPasswordHandler: RequestHandler = async (req, res) => {
  const agentId = parseAgentId(req.params.id);
  const { password } = parseRequest(setAgentPasswordSchema, req.body);
  await setAgentPassword(agentId, password);
  res.json({ success: true, message: 'Agent login password set successfully.', data: { agentId } });
};

export const resetAgentPasswordHandler: RequestHandler = async (req, res) => {
  const agentId = parseAgentId(req.params.id);
  const { newPassword } = parseRequest(resetAgentPasswordSchema, req.body);
  await setAgentPassword(agentId, newPassword);
  res.json({
    success: true,
    message: 'Agent password reset successfully.',
    data: { agentId },
  });
};

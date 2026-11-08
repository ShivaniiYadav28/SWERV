import type { CookieOptions } from 'express';

export const AGENT_GPS_COOKIE_NAME = 'swerv_agent_gps';

export function agentGpsCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/agent-locations',
  };
}

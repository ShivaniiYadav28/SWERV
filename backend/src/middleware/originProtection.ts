import type { RequestHandler } from 'express';
import { AGENT_AUTH_COOKIE_NAME } from '../utils/agentJwt.js';
import { AGENT_GPS_COOKIE_NAME } from '../utils/agentGpsCookie.js';
import { AUTH_COOKIE_NAME } from '../utils/jwt.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const authenticationCookieNames = [
  AUTH_COOKIE_NAME,
  AGENT_AUTH_COOKIE_NAME,
  AGENT_GPS_COOKIE_NAME,
];

export function createOriginProtection(
  allowedOrigins: readonly string[],
): RequestHandler {
  const allowedOriginSet = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.get('origin');
    if (safeMethods.has(req.method)) {
      next();
      return;
    }

    if (!origin) {
      const hasAuthenticationCookie = authenticationCookieNames.some(
        (name) => typeof req.cookies?.[name] === 'string' && req.cookies[name].length > 0,
      );
      const fetchSite = req.get('sec-fetch-site');
      if (
        !hasAuthenticationCookie ||
        !fetchSite ||
        fetchSite === 'same-origin'
      ) {
        next();
        return;
      }

      res.status(403).json({
        success: false,
        message: 'Cross-site cookie-authenticated requests are not allowed.',
      });
      return;
    }

    if (allowedOriginSet.has(origin)) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      message: 'Request origin is not allowed.',
    });
  };
}

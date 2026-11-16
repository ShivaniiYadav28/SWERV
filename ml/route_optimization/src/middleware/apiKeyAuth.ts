import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HttpError } from '../utils/httpError.js';

export const requireApiKey: RequestHandler = (req, _res, next) => {
  const expectedToken = process.env.ROUTE_OPTIMIZATION_API_KEY?.trim();
  if (!expectedToken) {
    next(new HttpError(503, 'Route optimization API key is not configured.'));
    return;
  }

  const authorization = req.get('authorization');
  const providedToken = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!providedToken) {
    next(new HttpError(401, 'A valid Bearer token is required.'));
    return;
  }

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(providedToken);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    next(new HttpError(401, 'A valid Bearer token is required.'));
    return;
  }

  next();
};

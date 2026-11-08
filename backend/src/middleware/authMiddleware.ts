import type { RequestHandler } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { AUTH_COOKIE_NAME, getJwtSecret } from '../utils/jwt.js';
import { getActiveUserById } from '../services/authService.js';

export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (!token) {
    res
      .status(401)
      .json({ success: false, message: 'Authentication required.' });
    return;
  }

  let decoded: string | JwtPayload;
  try {
    decoded = jwt.verify(token, getJwtSecret());
  } catch {
    res
      .status(401)
      .json({
        success: false,
        message: 'Invalid or expired authentication credentials.',
      });
    return;
  }
  if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
    res
      .status(401)
      .json({
        success: false,
        message: 'Invalid or expired authentication credentials.',
      });
    return;
  }
  const user = await getActiveUserById(decoded.sub);
  if (!user) {
    res
      .status(401)
      .json({
        success: false,
        message: 'Account is inactive or no longer exists.',
      });
    return;
  }
  req.user = user;
  next();
};

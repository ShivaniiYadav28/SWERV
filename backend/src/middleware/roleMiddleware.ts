import type { RequestHandler } from 'express';
import type { UserRole } from '../models/User.js';

export function allowRoles(...roles: UserRole[]): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res
        .status(401)
        .json({ success: false, message: 'Authentication required.' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res
        .status(403)
        .json({
          success: false,
          message: 'You do not have permission to access this resource.',
        });
      return;
    }
    next();
  };
}

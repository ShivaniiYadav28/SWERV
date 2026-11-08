import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  currentUser,
  login,
  logout,
  register,
} from '../controllers/authController.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = Router();
const credentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 100 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again later.',
  },
});

router.post('/register', credentialsLimiter, register);
router.post('/login', credentialsLimiter, login);
router.post('/logout', logout);
router.get('/me', requireAuth, currentUser);

export default router;

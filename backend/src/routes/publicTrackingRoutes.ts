import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getPublicDeliveryTrackingHandler } from '../controllers/deliveryTrackingController.js';

export const publicTrackingRateLimit = rateLimit({
  windowMs: 60 * 1_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many tracking requests. Please try again shortly.' },
});

const router = Router();
router.get('/tracking/:token', publicTrackingRateLimit, getPublicDeliveryTrackingHandler);

export default router;

import { Router } from 'express';
import { getDispatchAnalyticsHandler } from '../controllers/dispatchAnalyticsController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';

const router = Router();
router.get('/', requireAuth, allowRoles('admin', 'operator'), getDispatchAnalyticsHandler);

export default router;

import { Router } from 'express';
import { demandForecastHandler } from '../controllers/demandForecastingController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';

const router = Router();

router.post('/forecast', requireAuth, allowRoles('admin'), demandForecastHandler);

export default router;

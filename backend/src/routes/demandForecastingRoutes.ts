import { Router } from 'express';
import {
  demandForecastHandler,
  demandHistoryHandler,
} from '../controllers/demandForecastingController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';

const router = Router();

router.get('/history', requireAuth, allowRoles('admin'), demandHistoryHandler);
router.post('/forecast', requireAuth, allowRoles('admin'), demandForecastHandler);

export default router;

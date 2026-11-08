import { Router } from 'express';
import { allowRoles } from '../middleware/roleMiddleware.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import {
  anomalyAlertDetailsHandler, anomalyAlertsHandler, anomalySummaryHandler,
  reviewAnomalyAlertHandler, runAnomalyDetectionHandler,
} from '../controllers/anomalyDetectionController.js';

const router = Router();
router.use(requireAuth, allowRoles('admin'));
router.post('/detect', runAnomalyDetectionHandler);
router.get('/summary', anomalySummaryHandler);
router.get('/alerts', anomalyAlertsHandler);
router.get('/alerts/:id', anomalyAlertDetailsHandler);
router.patch('/alerts/:id/review', reviewAnomalyAlertHandler);
export default router;

import { Router } from 'express';
import {
  applyAgentRoutePlanHandler,
  getAgentRoutePlanHandler,
  listAgentRouteDeliveriesHandler,
  previewAgentRouteHandler,
} from '../controllers/routeOptimizationController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';

const router = Router();
router.use(requireAuth, allowRoles('admin', 'operator'));
router.get('/agents/:agentId/deliveries', listAgentRouteDeliveriesHandler);
router.get('/agents/:agentId/plan', getAgentRoutePlanHandler);
router.post('/preview', previewAgentRouteHandler);
router.post('/apply', applyAgentRoutePlanHandler);

export default router;

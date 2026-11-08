import { Router } from 'express';
import {
  agentLoginHandler,
  agentLogoutHandler,
  currentAgentHandler,
} from '../controllers/agentAuthController.js';
import {
  getAgentDeliveryHandler,
  listAgentDeliveryHistoryHandler,
  listAgentDeliveriesHandler,
  updateAgentDeliveryStatusHandler,
} from '../controllers/agentDeliveryController.js';
import { requireAgentAuth } from '../middleware/agentAuthMiddleware.js';

const router = Router();
router.post('/auth/login', agentLoginHandler);
router.post('/auth/logout', agentLogoutHandler);
router.get('/auth/me', requireAgentAuth, currentAgentHandler);
router.get('/deliveries/history', requireAgentAuth, listAgentDeliveryHistoryHandler);
router.get('/deliveries', requireAgentAuth, listAgentDeliveriesHandler);
router.get('/deliveries/:id', requireAgentAuth, getAgentDeliveryHandler);
router.patch('/deliveries/:id/status', requireAgentAuth, updateAgentDeliveryStatusHandler);

export default router;

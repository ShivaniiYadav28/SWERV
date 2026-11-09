import { Router } from 'express';
import {
  getAgentLocationHistoryHandler,
  listLatestAgentLocationsHandler,
  submitAgentLocationHandler,
  submitAgentBrowserLocationHandler,
  createAgentBrowserGpsSessionHandler,
  stopAgentBrowserGpsSessionHandler,
} from '../controllers/agentLocationController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireAgentDevice, requireAgentGpsCookie } from '../middleware/agentDeviceAuthMiddleware.js';
import { requireAgentAuth } from '../middleware/agentAuthMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';

const router = Router();

router.get('/', requireAuth, allowRoles('admin', 'operator'), listLatestAgentLocationsHandler);
router.get('/:agentId/history', requireAuth, allowRoles('admin', 'operator'), getAgentLocationHistoryHandler);
router.post('/browser-session', requireAgentAuth, createAgentBrowserGpsSessionHandler);
router.delete('/browser-session', requireAgentGpsCookie, stopAgentBrowserGpsSessionHandler);
router.post('/browser', requireAgentGpsCookie, submitAgentBrowserLocationHandler);
router.post('/', requireAgentDevice, submitAgentLocationHandler);

export default router;

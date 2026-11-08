import { Router } from 'express';
import { archiveAgentHandler, changeAgentStatusHandler, createAgentHandler, getAgentHandler, listAgentsHandler, restoreAgentHandler, updateAgentHandler } from '../controllers/agentController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';
import { setAgentPasswordHandler } from '../controllers/agentAuthController.js';
import {
  generateAgentDeviceCredentialHandler,
  revokeAgentDeviceCredentialsHandler,
} from '../controllers/agentLocationController.js';

const router = Router();
router.use(requireAuth);
router.get('/', allowRoles('admin', 'operator'), listAgentsHandler);
router.get('/:id', allowRoles('admin', 'operator'), getAgentHandler);
router.post('/', allowRoles('admin'), createAgentHandler);
router.patch('/:id', allowRoles('admin'), updateAgentHandler);
router.put('/:id/password', allowRoles('admin'), setAgentPasswordHandler);
router.patch('/:id/status', allowRoles('admin', 'operator'), changeAgentStatusHandler);
router.patch('/:id/archive', allowRoles('admin'), archiveAgentHandler);
router.patch('/:id/restore', allowRoles('admin'), restoreAgentHandler);
router.post('/:id/device-credential', allowRoles('admin'), generateAgentDeviceCredentialHandler);
router.delete('/:id/device-credential', allowRoles('admin'), revokeAgentDeviceCredentialsHandler);

export default router;

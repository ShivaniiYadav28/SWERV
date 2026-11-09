import { Router } from 'express';
import { getAdminPodHandler, getAdminPodImageHandler, listAdminPodHandler } from '../controllers/proofOfDeliveryController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';

const router = Router();
router.use(requireAuth, allowRoles('admin'));
router.get('/', listAdminPodHandler);
router.get('/:id/evidence/:kind', getAdminPodImageHandler);
router.get('/:id', getAdminPodHandler);

export default router;

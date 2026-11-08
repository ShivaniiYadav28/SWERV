import { Router } from 'express';
import { getAgentRecommendationsHandler } from '../controllers/agentRecommendationController.js';
import { predictDeliveryTimeHandler } from '../controllers/deliveryPredictionController.js';
import {
  assignDispatchRequestHandler,
  changeDispatchRequestStatusHandler,
  createDispatchRequestHandler,
  getDispatchRequestHandler,
  listDispatchRequestsHandler,
  updateDispatchRequestCoordinatesHandler,
} from '../controllers/dispatchRequestController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';
import {
  createDeliveryTrackingLinkHandler,
  getDeliveryTrackingLinkStatusHandler,
  revokeDeliveryTrackingLinkHandler,
} from '../controllers/deliveryTrackingController.js';

const router = Router();
router.use(requireAuth, allowRoles('admin', 'operator'));

router.post('/', createDispatchRequestHandler);
router.post('/:id/tracking-link', createDeliveryTrackingLinkHandler);
router.get('/:id/tracking-link', getDeliveryTrackingLinkStatusHandler);
router.delete('/:id/tracking-link', revokeDeliveryTrackingLinkHandler);
router.get('/', listDispatchRequestsHandler);
router.get('/:id/agent-recommendations', getAgentRecommendationsHandler);
router.get('/:id', getDispatchRequestHandler);
router.post('/:id/prediction', predictDeliveryTimeHandler);
router.patch('/:id/assignment', assignDispatchRequestHandler);
router.patch('/:id/status', changeDispatchRequestStatusHandler);
router.patch('/:id/coordinates', updateDispatchRequestCoordinatesHandler);

export default router;

import { Router } from 'express';
import { healthHandler, optimizeRouteHandler } from '../controllers/routeOptimizationController.js';
import { requireApiKey } from '../middleware/apiKeyAuth.js';

const router = Router();

router.get('/health', healthHandler);
router.post('/optimize', requireApiKey, optimizeRouteHandler);

export default router;

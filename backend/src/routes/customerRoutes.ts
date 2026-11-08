import { Router } from 'express';
import {
  changeCustomerStatusHandler, createCustomerHandler, getCustomerHandler,
  listCustomersHandler, updateCustomerHandler,
} from '../controllers/customerController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';

const router = Router();
router.use(requireAuth, allowRoles('admin', 'operator'));

router.post('/', createCustomerHandler);
router.get('/', listCustomersHandler);
router.get('/:id', getCustomerHandler);
router.patch('/:id', updateCustomerHandler);
router.patch('/:id/status', changeCustomerStatusHandler);

export default router;

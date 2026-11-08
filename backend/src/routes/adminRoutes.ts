import { Router } from 'express';
import { adminDashboard } from '../controllers/authController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';
import {
  changeUserRoleHandler, changeUserStatusHandler, createUserHandler,
  getUserHandler, listUsersHandler,
} from '../controllers/adminUserController.js';

const router = Router();
router.use(requireAuth, allowRoles('admin'));
router.get('/dashboard', adminDashboard);
router.get('/users', listUsersHandler);
router.get('/users/:id', getUserHandler);
router.post('/users', createUserHandler);
router.patch('/users/:id/role', changeUserRoleHandler);
router.patch('/users/:id/status', changeUserStatusHandler);

export default router;

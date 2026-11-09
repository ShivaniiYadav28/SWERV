import { Router } from 'express';
import {
  agentCheckInHandler,
  agentCheckOutHandler,
  adminAgentAttendanceHandler,
  myAgentAttendanceHandler,
} from '../controllers/agentAttendanceController.js';
import { requireAgentAuth } from '../middleware/agentAuthMiddleware.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';

export const agentAttendanceRoutes = Router();
agentAttendanceRoutes.post('/check-in', requireAgentAuth, agentCheckInHandler);
agentAttendanceRoutes.post('/check-out', requireAgentAuth, agentCheckOutHandler);
agentAttendanceRoutes.get('/me', requireAgentAuth, myAgentAttendanceHandler);
agentAttendanceRoutes.get('/', requireAuth, allowRoles('admin', 'operator'), adminAgentAttendanceHandler);

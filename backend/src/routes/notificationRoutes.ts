import { Router } from 'express';
import { agentNotificationHandlers, userNotificationHandlers } from '../controllers/notificationController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { allowRoles } from '../middleware/roleMiddleware.js';
import { requireAgentAuth } from '../middleware/agentAuthMiddleware.js';

export const userNotificationRoutes = Router();
userNotificationRoutes.use(requireAuth, allowRoles('admin', 'operator'));
userNotificationRoutes.get('/', userNotificationHandlers.list);
userNotificationRoutes.get('/unread-count', userNotificationHandlers.unreadCount);
userNotificationRoutes.patch('/read-all', userNotificationHandlers.markAllRead);
userNotificationRoutes.patch('/:id/read', userNotificationHandlers.markRead);

export const agentNotificationRoutes = Router();
agentNotificationRoutes.use(requireAgentAuth);
agentNotificationRoutes.get('/', agentNotificationHandlers.list);
agentNotificationRoutes.get('/unread-count', agentNotificationHandlers.unreadCount);
agentNotificationRoutes.patch('/read-all', agentNotificationHandlers.markAllRead);
agentNotificationRoutes.patch('/:id/read', agentNotificationHandlers.markRead);

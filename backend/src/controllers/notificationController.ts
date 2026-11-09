import type { RequestHandler } from 'express';
import { getNotifications, getUnreadCount, markAllNotificationsAsRead, markNotificationAsRead, validateNotificationId } from '../services/notificationService.js';
import { parseNotificationQuery } from '../utils/notificationValidation.js';
import { HttpError } from '../utils/httpError.js';

function userId(req: Parameters<RequestHandler>[0]): string {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return req.user.id;
}

function agentId(req: Parameters<RequestHandler>[0]): string {
  if (!req.agentId) throw new HttpError(401, 'Agent authentication required.');
  return req.agentId;
}

function createNotificationHandlers(recipientType: 'user' | 'agent', getRecipientId: typeof userId) {
  const list: RequestHandler = async (req, res) => {
    const query = parseNotificationQuery(req.query);
    const result = await getNotifications(recipientType, getRecipientId(req), query);
    res.json({ success: true, message: 'Notifications retrieved.', data: result });
  };
  const unreadCount: RequestHandler = async (req, res) => {
    const count = await getUnreadCount(recipientType, getRecipientId(req));
    res.json({ success: true, message: 'Unread notification count retrieved.', data: { count } });
  };
  const markRead: RequestHandler = async (req, res) => {
    const notification = await markNotificationAsRead(recipientType, getRecipientId(req), validateNotificationId(req.params.id));
    res.json({ success: true, message: 'Notification marked as read.', data: { notification } });
  };
  const markAllRead: RequestHandler = async (req, res) => {
    const result = await markAllNotificationsAsRead(recipientType, getRecipientId(req));
    res.json({ success: true, message: 'Notifications marked as read.', data: result });
  };
  return { list, unreadCount, markRead, markAllRead };
}

export const userNotificationHandlers = createNotificationHandlers('user', userId);
export const agentNotificationHandlers = createNotificationHandlers('agent', agentId);

import mongoose, { type ClientSession } from 'mongoose';
import { Notification, type NotificationEventType, type NotificationRecipientType, type NotificationRelatedEntityType } from '../models/Notification.js';
import { User, type UserRole } from '../models/User.js';
import { HttpError } from '../utils/httpError.js';

export type NotificationPayload = {
  id: string;
  recipientType: NotificationRecipientType;
  recipientId: string;
  eventType: NotificationEventType;
  title: string;
  message: string;
  relatedEntityType: NotificationRelatedEntityType | null;
  relatedEntityId: string | null;
  createdAt: string;
  readAt: string | null;
};

export type CreateNotificationInput = {
  recipientType: NotificationRecipientType;
  recipientId: string | mongoose.Types.ObjectId;
  eventType: NotificationEventType;
  title: string;
  message: string;
  relatedEntityType?: NotificationRelatedEntityType | null;
  relatedEntityId?: string | mongoose.Types.ObjectId | null;
};

export type NotificationQuery = { page: number; limit: number; unreadOnly: boolean };

function toPayload(notification: {
  _id: mongoose.Types.ObjectId;
  recipientType: NotificationRecipientType;
  recipientId: mongoose.Types.ObjectId;
  eventType: NotificationEventType;
  title: string;
  message: string;
  relatedEntityType?: NotificationRelatedEntityType | null;
  relatedEntityId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  readAt?: Date | null;
}): NotificationPayload {
  return {
    id: notification._id.toString(),
    recipientType: notification.recipientType,
    recipientId: notification.recipientId.toString(),
    eventType: notification.eventType,
    title: notification.title,
    message: notification.message,
    relatedEntityType: notification.relatedEntityType ?? null,
    relatedEntityId: notification.relatedEntityId?.toString() ?? null,
    createdAt: notification.createdAt.toISOString(),
    readAt: notification.readAt?.toISOString() ?? null,
  };
}

export async function createNotification(
  input: CreateNotificationInput,
  session?: ClientSession,
): Promise<NotificationPayload> {
  const notification = new Notification({ ...input, recipientId: input.recipientId, relatedEntityId: input.relatedEntityId ?? null });
  await notification.save(session ? { session } : undefined);
  return toPayload(notification);
}

export async function createUserNotifications(
  session: ClientSession,
  roles: readonly UserRole[],
  input: Omit<CreateNotificationInput, 'recipientType' | 'recipientId'>,
): Promise<NotificationPayload[]> {
  const users = await User.find({ isActive: true, role: { $in: roles } }).select('_id').session(session).lean();
  const notifications: NotificationPayload[] = [];
  for (const user of users) {
    notifications.push(await createNotification({ ...input, recipientType: 'user', recipientId: user._id }, session));
  }
  return notifications;
}

export async function createAgentNotification(
  session: ClientSession,
  agentId: string | mongoose.Types.ObjectId,
  input: Omit<CreateNotificationInput, 'recipientType' | 'recipientId'>,
): Promise<NotificationPayload> {
  return createNotification({ ...input, recipientType: 'agent', recipientId: agentId }, session);
}

export async function getNotifications(
  recipientType: NotificationRecipientType,
  recipientId: string,
  query: NotificationQuery,
) {
  const filter: Record<string, unknown> = { recipientType, recipientId };
  if (query.unreadOnly) filter.readAt = null;
  const skip = (query.page - 1) * query.limit;
  const [notifications, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
    Notification.countDocuments(filter),
  ]);
  return {
    notifications: notifications.map((notification) => toPayload(notification as unknown as Parameters<typeof toPayload>[0])),
    pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
  };
}

export async function getUnreadCount(recipientType: NotificationRecipientType, recipientId: string): Promise<number> {
  return Notification.countDocuments({ recipientType, recipientId, readAt: null });
}

export async function markNotificationAsRead(
  recipientType: NotificationRecipientType,
  recipientId: string,
  notificationId: string,
): Promise<NotificationPayload> {
  const filter = { _id: notificationId, recipientType, recipientId };
  const updated = await Notification.findOneAndUpdate(
    { ...filter, readAt: null },
    { $set: { readAt: new Date() } },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  const notification = updated ?? await Notification.findOne(filter).lean();
  if (!notification) throw new HttpError(404, 'Notification not found.');
  return toPayload(notification as unknown as Parameters<typeof toPayload>[0]);
}

export async function markAllNotificationsAsRead(recipientType: NotificationRecipientType, recipientId: string) {
  const result = await Notification.updateMany(
    { recipientType, recipientId, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return { updatedCount: result.modifiedCount };
}

export function validateNotificationId(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) {
    throw new HttpError(400, 'Invalid notification ID.');
  }
  return value;
}

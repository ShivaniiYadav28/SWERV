import { Schema, model } from 'mongoose';

export const notificationRecipientTypes = ['user', 'agent'] as const;
export type NotificationRecipientType = (typeof notificationRecipientTypes)[number];

export const notificationEventTypes = [
  'new_dispatch',
  'dispatch_assigned',
  'dispatch_reassigned',
  'dispatch_status_changed',
  'delivery_completed',
  'anomaly_detected',
  'agent_status_changed',
] as const;
export type NotificationEventType = (typeof notificationEventTypes)[number];

export const notificationRelatedEntityTypes = ['dispatch', 'anomaly_alert', 'agent'] as const;
export type NotificationRelatedEntityType = (typeof notificationRelatedEntityTypes)[number];

const notificationSchema = new Schema(
  {
    recipientType: { type: String, enum: notificationRecipientTypes, required: true },
    recipientId: { type: Schema.Types.ObjectId, required: true },
    eventType: { type: String, enum: notificationEventTypes, required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    relatedEntityType: { type: String, enum: notificationRelatedEntityTypes, default: null },
    relatedEntityId: { type: Schema.Types.ObjectId, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

notificationSchema.index({ recipientType: 1, recipientId: 1, createdAt: -1 });
notificationSchema.index({ recipientType: 1, recipientId: 1, readAt: 1, createdAt: -1 });

export const Notification = model('Notification', notificationSchema);

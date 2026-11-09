import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Notification } from '../src/models/Notification.js';

describe('Notification model', () => {
  it.each(['user', 'agent'] as const)('accepts a valid %s recipient notification', async (recipientType) => {
    const notification = new Notification({
      recipientType,
      recipientId: new mongoose.Types.ObjectId(),
      eventType: 'dispatch_assigned',
      title: 'Delivery assigned',
      message: 'A dispatch was assigned to you.',
      relatedEntityType: 'dispatch',
      relatedEntityId: new mongoose.Types.ObjectId(),
    });

    await expect(notification.validate()).resolves.toBeUndefined();
  });

  it('requires a recipient, event type, title, and message', async () => {
    const notification = new Notification({});

    await expect(notification.validate()).rejects.toMatchObject({
      errors: {
        recipientType: expect.anything(),
        recipientId: expect.anything(),
        eventType: expect.anything(),
        title: expect.anything(),
        message: expect.anything(),
      },
    });
  });

  it('rejects unsupported recipient, event, and related entity types', async () => {
    const notification = new Notification({
      recipientType: 'customer',
      recipientId: new mongoose.Types.ObjectId(),
      eventType: 'unknown_event',
      title: 'Update',
      message: 'An update occurred.',
      relatedEntityType: 'customer_record',
    });
    await expect(notification.validate()).rejects.toMatchObject({
      errors: {
        recipientType: expect.anything(),
        eventType: expect.anything(),
        relatedEntityType: expect.anything(),
      },
    });
  });

  it('defaults notifications to unread and uses timestamps', () => {
    const notification = new Notification({
      recipientType: 'user',
      recipientId: new mongoose.Types.ObjectId(),
      eventType: 'new_dispatch',
      title: 'New dispatch',
      message: 'A new dispatch request is ready.',
    });

    expect(notification.readAt).toBeNull();
    expect(Notification.schema.options.timestamps).toBe(true);
  });

  it('indexes recipient queries by creation time and read state', () => {
    const indexes = Notification.schema.indexes().map(([fields]) => Object.keys(fields));

    expect(indexes).toContainEqual(['recipientType', 'recipientId', 'createdAt']);
    expect(indexes).toContainEqual(['recipientType', 'recipientId', 'readAt', 'createdAt']);
  });
});

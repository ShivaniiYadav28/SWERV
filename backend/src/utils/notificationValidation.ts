import { z } from 'zod';
import { HttpError } from './httpError.js';

const booleanQuery = z.enum(['true', 'false']).optional().transform((value) => value === 'true');

export const notificationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unreadOnly: booleanQuery,
}).strict();

export function parseNotificationQuery(value: unknown) {
  const result = notificationListQuerySchema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(' '));
  return { ...result.data, unreadOnly: result.data.unreadOnly ?? false };
}

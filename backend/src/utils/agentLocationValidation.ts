import { z } from 'zod';
import { HttpError } from './httpError.js';

export const submitAgentLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(100_000).optional(),
  speed: z.number().finite().min(0).max(1_000).optional(),
  heading: z.number().finite().min(0).max(360).optional(),
  recordedAt: z.iso.datetime()
    .transform((value) => new Date(value))
    .refine((value) => value.getTime() <= Date.now() + 5 * 60 * 1_000, 'Location time cannot be more than five minutes in the future.'),
}).strict();

export const locationHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict().refine(
  ({ page, limit }) => (page - 1) * limit <= 100_000,
  'Requested history page is too large.',
);

export function parseLocationRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(' '));
  }
  return result.data;
}

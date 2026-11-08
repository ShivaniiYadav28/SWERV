import mongoose from 'mongoose';
import { z } from 'zod';
import { HttpError } from './httpError.js';

export const detectionRequestSchema = z.object({
  mode: z.enum(['real', 'synthetic_demo']),
}).strict();

export const alertReviewSchema = z.object({
  reviewStatus: z.enum(['under_review', 'resolved', 'dismissed']).optional(),
  reviewNotes: z.string().trim().min(1, 'Review notes cannot be empty.').max(1000).optional(),
}).strict().refine(
  (input) => input.reviewStatus !== undefined || input.reviewNotes !== undefined,
  'Provide a review status or a non-empty review note.',
);

const anomalyTypes = [
  'gps_missing_coordinates', 'gps_invalid_coordinates', 'gps_invalid_timestamp', 'gps_invalid_timestamp_order',
  'gps_stale_submission', 'gps_stale_update', 'gps_implausible_jump', 'repeated_dispatch_reassignment',
  'unusual_delivery_duration', 'invalid_status_transition',
] as const;

export function parseAlertQuery(query: Record<string, unknown>) {
  const schema = z.object({
    mode: z.enum(['real', 'synthetic_demo']).default('real'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    anomalyType: z.enum(anomalyTypes).optional(),
    reviewStatus: z.enum(['new', 'under_review', 'resolved', 'dismissed']).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }).strict().safeParse(query);
  if (!schema.success) throw new HttpError(400, 'Invalid alert filters or pagination values.');
  return schema.data;
}

export function validateAlertId(value: unknown): string {
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) throw new HttpError(400, 'Invalid alert ID.');
  return value;
}

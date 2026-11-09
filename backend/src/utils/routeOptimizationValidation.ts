import mongoose from 'mongoose';
import { z } from 'zod';
import type { StopPreference } from '../services/routeOptimizer.js';
import { HttpError } from './httpError.js';

const objectId = z.string().refine(mongoose.isValidObjectId, 'Provide a valid ID.');
const dispatchRequestIds = z.array(objectId).min(1).max(12)
  .refine((ids) => new Set(ids).size === ids.length, 'Dispatch IDs must be unique.');
const stopSequence = z.array(z.object({
  dispatchRequestId: objectId,
  stopType: z.enum(['pickup', 'delivery']),
}).strict()).min(1).max(24);

export const routePreviewSchema = z.object({ agentId: objectId, dispatchRequestIds }).strict();
export const routeApplySchema = z.object({ agentId: objectId, dispatchRequestIds, stopSequence }).strict();

export function parseRouteRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(' '));
  return result.data;
}

export type RouteStopSequenceInput = StopPreference[];

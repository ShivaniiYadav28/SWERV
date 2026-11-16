import { z } from 'zod';
import { HttpError } from './httpError.js';
import type { RouteOptimizationRequest } from '../types/routeOptimization.js';

const coordinatesSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();

const deliverySchema = z.object({
  dispatchRequestId: z.string().trim().min(1).max(128),
  status: z.enum(['assigned', 'picked_up', 'in_transit']),
  pickup: coordinatesSchema.optional(),
  delivery: coordinatesSchema,
}).strict().superRefine((delivery, context) => {
  if (delivery.status === 'assigned' && !delivery.pickup) {
    context.addIssue({
      code: 'custom',
      path: ['pickup'],
      message: 'Pickup coordinates are required for assigned deliveries.',
    });
  }
  if (delivery.status !== 'assigned' && delivery.pickup) {
    context.addIssue({
      code: 'custom',
      path: ['pickup'],
      message: 'Pickup coordinates are only accepted for assigned deliveries.',
    });
  }
});

const routeOptimizationRequestSchema = z.object({
  agent: z.object({
    agentId: z.string().trim().min(1).max(128),
    ...coordinatesSchema.shape,
  }).strict(),
  deliveries: z.array(deliverySchema).min(1).max(12),
}).strict().superRefine((request, context) => {
  const ids = request.deliveries.map((delivery) => delivery.dispatchRequestId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: 'custom',
      path: ['deliveries'],
      message: 'Delivery IDs must be unique.',
    });
  }
});

export function parseRouteOptimizationRequest(value: unknown): RouteOptimizationRequest {
  const result = routeOptimizationRequestSchema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(' '));
  }
  return result.data;
}

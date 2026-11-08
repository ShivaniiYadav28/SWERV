import mongoose from 'mongoose';
import { z } from 'zod';
import {
  dispatchPriorities,
  dispatchRequestStatuses,
  packageCategories,
} from '../models/DispatchRequest.js';
import { HttpError } from './httpError.js';

const contactSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  phone: z.string().trim().min(7).max(24).regex(/^\+?[0-9().\s-]+$/),
}).strict();

const locationSchema = z.object({
  address: z.string().trim().min(1).max(240),
  addressLine2: z.string().trim().max(160).optional(),
  city: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(80),
  postalCode: z.string().trim().min(1).max(20),
  country: z.string().trim().min(1).max(80),
  instructions: z.string().trim().max(300).optional(),
  latitude: z.number().finite().min(-90).max(90).nullable().optional(),
  longitude: z.number().finite().min(-180).max(180).nullable().optional(),
}).strict().refine(
  ({ latitude, longitude }) => (latitude == null) === (longitude == null),
  'Provide both latitude and longitude, or leave both empty.',
);

const coordinatePointSchema = z.object({
  latitude: z.number().finite().min(-90).max(90).nullable(),
  longitude: z.number().finite().min(-180).max(180).nullable(),
}).strict().refine(
  ({ latitude, longitude }) => (latitude === null) === (longitude === null),
  'Provide both latitude and longitude, or clear both coordinates.',
);

const packageSchema = z.object({
  description: z.string().trim().min(2).max(240),
  category: z.enum(packageCategories),
  weightKg: z.number().min(0.01).max(10_000),
  quantity: z.number().int().min(1).max(1_000),
}).strict();

export const createDispatchRequestSchema = z.object({
  customer: contactSchema.optional(),
  customerId: z.string().refine((id) => mongoose.isValidObjectId(id), 'Invalid customer ID.').optional(),
  pickup: locationSchema,
  delivery: locationSchema,
  package: packageSchema,
  priority: z.enum(dispatchPriorities).default('standard'),
}).strict().refine(
  ({ customer, customerId }) => Boolean(customer) !== Boolean(customerId),
  'Provide either customer details or a customerId, but not both.',
);

export const dispatchRequestListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(dispatchRequestStatuses).optional(),
  priority: z.enum(dispatchPriorities).optional(),
}).strict();

export const dispatchAnalyticsQuerySchema = z.object({
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
}).strict().refine(
  ({ startDate, endDate }) => {
    if (!startDate && !endDate) return true;
    if (!startDate || !endDate) return false;
    const start = Date.parse(`${startDate}T00:00:00.000Z`);
    const end = Date.parse(`${endDate}T00:00:00.000Z`);
    return end >= start && end - start <= 365 * 24 * 60 * 60 * 1_000;
  },
  'Provide both startDate and endDate, with a range of no more than 366 days.',
);

export const dispatchStatusSchema = z.object({
  status: z.enum(dispatchRequestStatuses),
}).strict();

export const dispatchAssignmentSchema = z.object({
  agentId: z.string().refine((id) => mongoose.isValidObjectId(id), 'Invalid agent ID.'),
}).strict();

export const updateDispatchRequestCoordinatesSchema = z.object({
  pickup: coordinatePointSchema.optional(),
  delivery: coordinatePointSchema.optional(),
}).strict().refine(
  ({ pickup, delivery }) => Boolean(pickup || delivery),
  'Provide pickup or delivery coordinates to update.',
);

export function parseRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(' '));
  }
  return result.data;
}

export function parseDispatchRequestId(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) {
    throw new HttpError(400, 'Invalid dispatch request ID.');
  }
  return value;
}

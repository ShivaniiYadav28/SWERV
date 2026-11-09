import mongoose from 'mongoose';
import { z } from 'zod';
import { agentCapabilities, agentStatuses, vehicleTypes } from '../models/Agent.js';
import { HttpError } from './httpError.js';

const vehicleSchema = z.object({
  vehicleType: z.enum(vehicleTypes),
  registrationNumber: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9 -]+$/),
  manufacturer: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
}).strict();
const capacitySchema = z.object({ maxOrders: z.number().int().min(1).max(10_000) }).strict();
const fields = {
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone: z.string().trim().min(7).max(24).regex(/^\+?[0-9().\s-]+$/),
  vehicle: vehicleSchema,
  capacity: capacitySchema,
  capabilities: z.array(z.enum(agentCapabilities)).max(agentCapabilities.length),
};

export const createAgentSchema = z.object(fields).strict();
export const updateAgentSchema = z.object({
  name: fields.name.optional(), email: fields.email.optional(), phone: fields.phone.optional(),
  vehicle: fields.vehicle.optional(), capacity: fields.capacity.optional(), capabilities: fields.capabilities.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.');
export const statusSchema = z.object({ status: z.enum(agentStatuses) }).strict();
export const setAgentPasswordSchema = z.object({
  password: z.string().min(12).max(72),
}).strict();
export const resetAgentPasswordSchema = z.object({
  newPassword: z.string().min(12).max(72),
}).strict();
export const agentLoginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(72),
}).strict();

export function parseRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(' '));
  }
  return result.data;
}

export function parseAgentId(value: string | string[] | undefined): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Invalid agent ID.');
  if (!mongoose.isValidObjectId(value)) throw new HttpError(400, 'Invalid agent ID.');
  return value;
}

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z.enum(agentStatuses).optional(),
  vehicleType: z.enum(vehicleTypes).optional(),
  capability: z.enum(agentCapabilities).optional(),
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true').default(() => true),
}).strict();

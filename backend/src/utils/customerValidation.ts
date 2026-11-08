import mongoose from 'mongoose';
import { z } from 'zod';
import { HttpError } from './httpError.js';

const customerFields = {
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  phone: z.string().trim().min(7).max(24).regex(/^\+?[0-9().\s-]+$/),
};

export const createCustomerSchema = z.object(customerFields).strict();
export const updateCustomerSchema = z.object({
  name: customerFields.name.optional(),
  email: customerFields.email.optional(),
  phone: customerFields.phone.optional(),
}).strict().refine((input) => Object.keys(input).length > 0, 'Provide at least one customer field to update.');
export const customerStatusSchema = z.object({ isActive: z.boolean() }).strict();
export const customerListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).strict();

export function parseCustomerRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(' '));
  }
  return result.data;
}

export function parseCustomerId(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) {
    throw new HttpError(400, 'Invalid customer ID.');
  }
  return value;
}

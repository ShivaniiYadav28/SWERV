import mongoose from 'mongoose';
import { z } from 'zod';
import { userRoles } from '../models/User.js';
import { HttpError } from './httpError.js';

const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());
const passwordSchema = z.string().min(8).max(72).refine((password) => Buffer.byteLength(password, 'utf8') <= 72, {
  message: 'Password must be no more than 72 UTF-8 bytes',
});

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(userRoles),
}).strict();

export const userRoleSchema = z.object({ role: z.enum(userRoles) }).strict();
export const userStatusSchema = z.object({ isActive: z.boolean() }).strict();

export const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  role: z.enum(userRoles).optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).strict();

export function parseUserId(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) {
    throw new HttpError(400, 'Invalid user ID.');
  }
  return value;
}

export function parseUserRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(' '));
  }
  return result.data;
}

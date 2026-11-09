import mongoose from 'mongoose';
import { z } from 'zod';
import { HttpError } from './httpError.js';

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const dateFilter = z.string().refine(isCalendarDate, 'Dates must use a valid YYYY-MM-DD value.');
const pagination = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  startDate: dateFilter.optional(),
  endDate: dateFilter.optional(),
};

function validateDateRange(value: { startDate?: string; endDate?: string }, context: z.RefinementCtx) {
  if (value.startDate && value.endDate && value.startDate > value.endDate) {
    context.addIssue({ code: 'custom', message: 'Start date must be on or before end date.', path: ['endDate'] });
  }
}

export const agentAttendanceHistoryQuerySchema = z.object(pagination)
  .strict()
  .superRefine(validateDateRange);

export const adminAgentAttendanceQuerySchema = z.object({
  ...pagination,
  agentId: z.string().refine((value) => mongoose.isValidObjectId(value), 'Invalid agent ID.').optional(),
  search: z.string().trim().max(100).optional(),
}).strict().superRefine(validateDateRange);

export type AgentAttendanceHistoryQuery = z.output<typeof agentAttendanceHistoryQuerySchema>;
export type AdminAgentAttendanceQuery = z.output<typeof adminAgentAttendanceQuerySchema>;

export function parseAttendanceRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(' '));
  }
  return result.data;
}

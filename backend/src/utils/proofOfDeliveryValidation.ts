import { z } from 'zod';
import { HttpError } from './httpError.js';

export const verifyPodOtpSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'Enter the six-digit customer code.'),
}).strict();

export const submitPodSchema = z.object({
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional(),
  accuracyMeters: z.number().finite().min(0).max(100_000).optional(),
  locationUnavailableReason: z.enum(['permission_denied', 'unsupported', 'timeout', 'not_available']).optional(),
}).strict().refine(({ latitude, longitude }) => (latitude === undefined) === (longitude === undefined), {
  message: 'Provide both GPS coordinates or neither.',
}).refine(({ latitude, locationUnavailableReason }) => latitude !== undefined || locationUnavailableReason !== undefined, {
  message: 'Capture GPS or explain why it is unavailable.',
}).refine(({ latitude, locationUnavailableReason }) => latitude === undefined || locationUnavailableReason === undefined, {
  message: 'GPS coordinates and an unavailable reason cannot be sent together.',
});

export function parsePodRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join(' '));
  }
  return parsed.data;
}

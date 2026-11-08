import { z } from 'zod';

const hourlyUtcTimestamp = z.iso.datetime({ offset: true }).refine((value) => {
  if (!value.endsWith('Z') && !value.endsWith('+00:00')) return false;
  const timestamp = new Date(value);
  return timestamp.getUTCMinutes() === 0
    && timestamp.getUTCSeconds() === 0
    && timestamp.getUTCMilliseconds() === 0;
}, 'forecastStartTimestamp must be a UTC timestamp aligned to the start of an hour.');

export const demandForecastRequestSchema = z.object({
  mode: z.enum(['real', 'synthetic_demo']),
  forecastStartTimestamp: hourlyUtcTimestamp,
  forecastPeriods: z.number().int().min(1).max(168),
  historicalRequestCounts: z.array(
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ).length(168),
}).strict();

import { apiRequest } from './api'
import type { DemandForecast } from '../types/demandForecast'

function isUtcHour(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = new Date(value)
  return (value.endsWith('Z') || value.endsWith('+00:00'))
    && Number.isFinite(timestamp.getTime())
    && timestamp.getUTCMinutes() === 0
    && timestamp.getUTCSeconds() === 0
    && timestamp.getUTCMilliseconds() === 0
}

export async function requestDemandForecast(
  input: {
    forecastStartTimestamp: string
    forecastPeriods: 24 | 72 | 168
  },
): Promise<DemandForecast> {
  if (
    !isUtcHour(input.forecastStartTimestamp)
    || ![24, 72, 168].includes(input.forecastPeriods)
  ) {
    throw new Error('Valid synthetic forecast settings are required.')
  }

  const response = await apiRequest<{ forecast: DemandForecast }>(
    '/api/demand-forecasting/forecast',
    {
      method: 'POST',
      body: JSON.stringify({
        forecastStartTimestamp: input.forecastStartTimestamp,
        forecastPeriods: input.forecastPeriods,
      }),
    },
  )
  const forecast = response.data?.forecast
  if (
    !forecast
    || forecast.mode !== 'synthetic_demo'
    || forecast.historySource !== 'synthetic_hourly_demand.csv'
    || typeof forecast.historyProvenance !== 'string'
    || forecast.historyProvenance.trim().length === 0
    || forecast.forecastPeriods !== input.forecastPeriods
    || Date.parse(forecast.forecastStartTimestamp) !== Date.parse(input.forecastStartTimestamp)
    || typeof forecast.modelVersion !== 'string'
    || !forecast.modelVersion.includes('synthetic')
    || forecast.trainingSource !== 'synthetic'
    || typeof forecast.syntheticProvenance !== 'string'
    || forecast.syntheticProvenance.trim().length === 0
    || !Array.isArray(forecast.predictions)
    || forecast.predictions.length !== input.forecastPeriods
    || forecast.predictions.some((prediction, index) => (
      !prediction
      || !isUtcHour(prediction.timestamp)
      || Date.parse(prediction.timestamp)
        !== Date.parse(input.forecastStartTimestamp) + index * 60 * 60 * 1_000
      || !Number.isSafeInteger(prediction.requestCount)
      || prediction.requestCount < 0
    ))
  ) {
    throw new Error('The forecasting service returned an invalid forecast.')
  }
  return forecast
}

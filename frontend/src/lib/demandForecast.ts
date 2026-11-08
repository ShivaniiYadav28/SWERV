import { apiRequest } from './api'
import type { DemandForecast, DemandHistory } from '../types/demandForecast'

const requiredHistoryHours = 168

function isUtcHour(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = new Date(value)
  return (value.endsWith('Z') || value.endsWith('+00:00'))
    && Number.isFinite(timestamp.getTime())
    && timestamp.getUTCMinutes() === 0
    && timestamp.getUTCSeconds() === 0
    && timestamp.getUTCMilliseconds() === 0
}

export type DemandDataMode = 'real' | 'synthetic_demo'

export async function getDemandHistory(mode: DemandDataMode): Promise<DemandHistory> {
  const response = await apiRequest<{ history: DemandHistory }>(`/api/demand-forecasting/history?mode=${mode}`)
  const history = response.data?.history
  if (
    !history
    || typeof history.available !== 'boolean'
    || typeof history.message !== 'string'
    || !isUtcHour(history.forecastStartTimestamp)
    || !isUtcHour(history.historyStartTimestamp)
    || history.requiredHistoryHours !== requiredHistoryHours
    || !Number.isInteger(history.availableHistoryHours)
    || history.availableHistoryHours < 0
    || history.availableHistoryHours > requiredHistoryHours
    || history.mode !== mode
    || (mode === 'real' && history.source !== 'DispatchRequest.createdAt')
    || (mode === 'synthetic_demo' && history.source !== 'synthetic_hourly_demand.csv')
    || typeof history.provenance !== 'string'
    || (history.available && (
      history.availableHistoryHours !== requiredHistoryHours
      || !Array.isArray(history.historicalRequestCounts)
      || history.historicalRequestCounts.length !== requiredHistoryHours
      || history.historicalRequestCounts.some((count) => !Number.isSafeInteger(count) || count < 0)
    ))
    || (!history.available && history.historicalRequestCounts !== null)
  ) {
    throw new Error('The historical demand service returned invalid data.')
  }
  return history
}

export async function requestDemandForecast(
  input: {
    mode: DemandDataMode
    forecastStartTimestamp: string
    forecastPeriods: 24 | 72 | 168
    historicalRequestCounts: number[]
  },
): Promise<DemandForecast> {
  if (
    !isUtcHour(input.forecastStartTimestamp)
    || ![24, 72, 168].includes(input.forecastPeriods)
    || input.historicalRequestCounts.length !== requiredHistoryHours
    || input.historicalRequestCounts.some((count) => !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new Error('Valid hourly history and forecast settings are required.')
  }

  const response = await apiRequest<{ forecast: DemandForecast }>(
    '/api/demand-forecasting/forecast',
    {
      method: 'POST',
      body: JSON.stringify({
        mode: input.mode,
        forecastStartTimestamp: input.forecastStartTimestamp,
        forecastPeriods: input.forecastPeriods,
        historicalRequestCounts: input.historicalRequestCounts,
      }),
    },
  )
  const forecast = response.data?.forecast
  if (
    !forecast
    || forecast.mode !== input.mode
    || forecast.historySource !== (input.mode === 'real' ? 'DispatchRequest.createdAt' : 'synthetic_hourly_demand.csv')
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

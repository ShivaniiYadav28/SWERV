export type DemandHistory = {
  mode: 'real' | 'synthetic_demo'
  available: boolean
  message: string
  forecastStartTimestamp: string
  historyStartTimestamp: string
  requiredHistoryHours: number
  availableHistoryHours: number
  historicalRequestCounts: number[] | null
  source: 'DispatchRequest.createdAt' | 'synthetic_hourly_demand.csv'
  provenance: string
}

export type HourlyDemandPrediction = {
  timestamp: string
  requestCount: number
}

export type DemandForecast = {
  mode: 'real' | 'synthetic_demo'
  historySource: DemandHistory['source']
  historyProvenance: string
  forecastStartTimestamp: string
  forecastPeriods: number
  predictions: HourlyDemandPrediction[]
  modelVersion: string
  trainingSource: 'synthetic'
  syntheticProvenance: string
}

export type HourlyDemandPrediction = {
  timestamp: string
  requestCount: number
}

export type DemandForecast = {
  mode: 'synthetic_demo'
  historySource: 'synthetic_hourly_demand.csv'
  historyProvenance: string
  forecastStartTimestamp: string
  forecastPeriods: number
  predictions: HourlyDemandPrediction[]
  modelVersion: string
  trainingSource: 'synthetic'
  syntheticProvenance: string
}

export type DetectionMode = 'real' | 'synthetic_demo'
export type ReviewStatus = 'new' | 'under_review' | 'resolved' | 'dismissed'
export type Severity = 'low' | 'medium' | 'high' | 'critical'

export type AnomalyAlert = {
  _id: string
  anomalyType: string
  severity: Severity
  dispatchId: string | null
  agentId: string | null
  explanation: string
  evidence: unknown
  evidenceTimestamp: string | null
  measuredValue: unknown
  threshold: unknown
  detectionMethod: string
  modelName: string | null
  modelVersion: string | null
  modelProvenance: string | null
  dataSource: DetectionMode
  detectionMode: DetectionMode
  dataQualityNotes: string[]
  reviewStatus: ReviewStatus
  reviewNotes: string
  createdAt: string
}

export type AnomalySummary = {
  mode: DetectionMode
  total: number
  new: number
  highSeverity: number
  underReview: number
  resolved: number
}

export type AlertPage = {
  alerts: AnomalyAlert[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

export type DetectionResult = {
  mode: DetectionMode
  modelName: string
  modelVersion: string
  trainingDataSource: 'synthetic'
  syntheticProvenance: string
  scenarioCount: number
  candidateCount: number
  savedAlerts: number
  duplicateAlertsSkipped: number
  limitations: string[]
}

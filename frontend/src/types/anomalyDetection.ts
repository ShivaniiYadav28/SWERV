export type DetectionMode = 'real' | 'synthetic_demo'
export type DetectionSource = 'backend_rule_based' | 'machine_learning_demo'
export type ReviewStatus = 'new' | 'under_review' | 'resolved' | 'dismissed'
export type Severity = 'low' | 'medium' | 'high' | 'critical'
export type AnomalyType =
  | 'gps_missing_coordinates'
  | 'gps_invalid_coordinates'
  | 'gps_invalid_timestamp'
  | 'gps_invalid_timestamp_order'
  | 'gps_stale_submission'
  | 'gps_stale_update'
  | 'gps_implausible_jump'
  | 'repeated_dispatch_reassignment'
  | 'unusual_delivery_duration'
  | 'invalid_status_transition'
  | 'unsupervised_outlier'
  | string

export type ScenarioEvidence = {
  scenarioId?: unknown
  scenarioTimestamp?: unknown
  scenarioCategory?: unknown
  scenarioCategorySource?: unknown
  scenarioCategoryIsModelPrediction?: unknown
  [key: string]: unknown
}

export type AnomalyAlert = {
  _id: string
  anomalyType: AnomalyType
  severity: Severity
  dispatchId: string | null
  agentId: string | null
  explanation: string
  evidence?: ScenarioEvidence | unknown
  evidenceTimestamp?: string | null
  measuredValue?: unknown
  threshold?: unknown
  detectionMethod: string
  modelName?: string | null
  modelVersion?: string | null
  modelProvenance?: string | null
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
  detectionSource: DetectionSource
  modelName?: string | null
  modelVersion?: string | null
  trainingDataSource?: 'synthetic' | 'not_applicable' | null
  syntheticProvenance?: string | null
  scenarioCount: number
  candidateCount: number
  savedAlerts: number
  duplicateAlertsSkipped: number
  limitations: string[]
}

import { apiRequest } from './api'
import type { AlertPage, AnomalyAlert, AnomalySummary, DetectionMode, DetectionResult, ReviewStatus, Severity } from '../types/anomalyDetection'

export async function getAnomalySummary(mode: DetectionMode) {
  const response = await apiRequest<AnomalySummary>(`/api/anomaly-detection/summary?mode=${mode}`)
  if (!response.data) throw new Error('Anomaly summary was missing from the response.')
  return response.data
}

export async function getAnomalyAlerts(filters: { mode: DetectionMode; page: number; limit: number; severity?: Severity; anomalyType?: string; reviewStatus?: ReviewStatus }) {
  const query = new URLSearchParams({ mode: filters.mode, page: String(filters.page), limit: String(filters.limit) })
  if (filters.severity) query.set('severity', filters.severity)
  if (filters.anomalyType) query.set('anomalyType', filters.anomalyType)
  if (filters.reviewStatus) query.set('reviewStatus', filters.reviewStatus)
  const response = await apiRequest<AlertPage>(`/api/anomaly-detection/alerts?${query}`)
  if (!response.data) throw new Error('Anomaly alert history was missing from the response.')
  return response.data
}

export async function runAnomalyDetection(mode: DetectionMode) {
  const response = await apiRequest<DetectionResult>('/api/anomaly-detection/detect', { method: 'POST', body: JSON.stringify({ mode }) })
  if (!response.data) throw new Error('Detection result was missing from the response.')
  return response.data
}

export async function getAnomalyAlert(id: string, mode: DetectionMode) {
  const response = await apiRequest<{ alert: AnomalyAlert }>(`/api/anomaly-detection/alerts/${encodeURIComponent(id)}?mode=${mode}`)
  if (!response.data) throw new Error('Anomaly alert details were missing from the response.')
  return response.data.alert
}

export async function reviewAnomalyAlert(id: string, mode: DetectionMode, reviewStatus?: Exclude<ReviewStatus, 'new'>, reviewNotes?: string) {
  const response = await apiRequest<{ alert: AnomalyAlert }>(`/api/anomaly-detection/alerts/${encodeURIComponent(id)}/review?mode=${mode}`, {
    method: 'PATCH', body: JSON.stringify({ ...(reviewStatus ? { reviewStatus } : {}), ...(reviewNotes !== undefined ? { reviewNotes } : {}) }),
  })
  if (!response.data) throw new Error('Updated anomaly alert was missing from the response.')
  return response.data.alert
}

export async function saveAnomalyAlertNote(id: string, mode: DetectionMode, reviewNotes: string) {
  return reviewAnomalyAlert(id, mode, undefined, reviewNotes)
}

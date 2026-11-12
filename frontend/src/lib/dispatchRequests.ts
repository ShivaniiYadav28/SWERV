import { apiRequest } from './api.ts'
import type {
  DispatchPriority,
  DispatchRequest,
  DispatchRequestStatus,
  CreateDispatchRequestInput,
  DispatchRequestDetails,
  DispatchCoordinatePoint,
  DeliveryTimePrediction,
  DemoDeliveryTimePrediction,
  AgentRecommendation,
  AgentRecommendationResult,
} from '../types/dispatchRequest'

export type DispatchRequestFilters = {
  page: number
  limit: number
  status: DispatchRequestStatus | ''
  priority: DispatchPriority | ''
}

function isAgentRecommendation(value: unknown): value is AgentRecommendation {
  if (!value || typeof value !== 'object') return false
  const item = value as AgentRecommendation
  return Boolean(
    item.agent
    && typeof item.agent.id === 'string'
    && typeof item.agent.name === 'string'
    && typeof item.agent.agentCode === 'string'
    && typeof item.agent.vehicleType === 'string'
    && Number.isInteger(item.rank)
    && Number.isFinite(item.predictedDurationMinutes)
    && item.predictedDurationMinutes > 0
    && item.workload
    && Number.isFinite(item.workload.activeDispatchCount)
    && Number.isFinite(item.workload.maxOrders)
    && (item.distanceKm === null || (Number.isFinite(item.distanceKm) && item.distanceKm >= 0))
    && Number.isInteger(item.historicalCompletedDeliveries)
    && (item.historicalMedianDurationMinutes === null
      || (Number.isFinite(item.historicalMedianDurationMinutes)
        && item.historicalMedianDurationMinutes > 0))
    && Array.isArray(item.explanation)
    && item.explanation.every((reason) => typeof reason === 'string'),
  )
}

export async function createDispatchRequest(
  input: CreateDispatchRequestInput,
): Promise<DispatchRequest> {
  const response = await apiRequest<{ dispatchRequest: DispatchRequest }>(
    '/api/dispatch-requests',
    { method: 'POST', body: JSON.stringify(input) },
  )
  if (!response.data?.dispatchRequest) {
    throw new Error('The dispatch request could not be created.')
  }
  return response.data.dispatchRequest
}

export async function getDispatchRequest(id: string): Promise<DispatchRequestDetails> {
  const response = await apiRequest<DispatchRequestDetails>(
    `/api/dispatch-requests/${encodeURIComponent(id)}`,
  )
  if (!response.data?.dispatchRequest) {
    throw new Error('Dispatch request details could not be loaded.')
  }
  return response.data
}

export async function requestDeliveryTimePrediction(
  requestId: string,
): Promise<DeliveryTimePrediction> {
  const response = await apiRequest<{ prediction: DeliveryTimePrediction }>(
    `/api/dispatch-requests/${encodeURIComponent(requestId)}/prediction`,
    { method: 'POST' },
  )
  const prediction = response.data?.prediction
  if (
    !prediction
    || prediction.predictionStatus !== 'available'
    || typeof prediction.predictedDurationMinutes !== 'number'
    || !Number.isFinite(prediction.predictedDurationMinutes)
    || prediction.predictedDurationMinutes <= 0
    || typeof prediction.modelVersion !== 'string'
    || prediction.modelVersion.trim().length === 0
  ) {
    throw new Error('The prediction service returned an invalid prediction.')
  }
  return prediction
}

export async function requestDemoDeliveryTimePrediction(
  requestId: string,
): Promise<DemoDeliveryTimePrediction> {
  const response = await apiRequest<{ prediction: DemoDeliveryTimePrediction }>(
    `/api/dispatch-requests/${encodeURIComponent(requestId)}/demo-prediction`,
    { method: 'POST' },
  )
  const prediction = response.data?.prediction
  if (
    !prediction
    || prediction.predictionStatus !== 'available'
    || prediction.predictionType !== 'simulated_demo'
    || typeof prediction.predictedDurationMinutes !== 'number'
    || !Number.isFinite(prediction.predictedDurationMinutes)
    || prediction.predictedDurationMinutes <= 0
    || typeof prediction.modelVersion !== 'string'
    || prediction.modelVersion.trim().length === 0
  ) {
    throw new Error('The demo prediction service returned an invalid prediction.')
  }
  return prediction
}

export async function getAgentRecommendations(
  requestId: string,
): Promise<AgentRecommendationResult> {
  const response = await apiRequest<AgentRecommendationResult>(
    `/api/dispatch-requests/${encodeURIComponent(requestId)}/agent-recommendations`,
  )
  const result = response.data
  const rankingData = result?.rankingData
  if (
    !result
    || result.dispatchRequestId !== requestId
    || !Array.isArray(result.recommendations)
    || !['available', 'no_eligible_candidates'].includes(result.predictionStatus)
    || !(result.modelVersion === null || typeof result.modelVersion === 'string')
    || !(result.trainingSource === null || result.trainingSource === 'synthetic')
    || !rankingData
    || typeof rankingData.pickupCoordinatesAvailable !== 'boolean'
    || !Number.isInteger(rankingData.agentsWithFreshGps)
    || typeof rankingData.historicalPerformanceAvailable !== 'boolean'
    || !Number.isInteger(rankingData.minimumHistoricalDeliveries)
    || !Array.isArray(result.notes)
    || !result.notes.every((note) => typeof note === 'string')
    || (result.recommendations as unknown[]).some((item) => !isAgentRecommendation(item))
  ) {
    throw new Error('The recommendation service returned an invalid response.')
  }
  return result
}

export async function assignDispatchAgent(requestId: string, agentId: string) {
  return apiRequest<{ dispatchRequest: DispatchRequest }>(
    `/api/dispatch-requests/${encodeURIComponent(requestId)}/assignment`,
    { method: 'PATCH', body: JSON.stringify({ agentId }) },
  )
}

export async function updateDispatchRequestStatus(
  requestId: string,
  status: DispatchRequestStatus,
) {
  return apiRequest<{ dispatchRequest: DispatchRequest }>(
    `/api/dispatch-requests/${encodeURIComponent(requestId)}/status`,
    { method: 'PATCH', body: JSON.stringify({ status }) },
  )
}

export async function updateDispatchRequestCoordinates(
  requestId: string,
  coordinates: { pickup?: DispatchCoordinatePoint; delivery?: DispatchCoordinatePoint },
): Promise<DispatchRequest> {
  const response = await apiRequest<{ dispatchRequest: DispatchRequest }>(
    `/api/dispatch-requests/${encodeURIComponent(requestId)}/coordinates`,
    { method: 'PATCH', body: JSON.stringify(coordinates) },
  )
  if (!response.data?.dispatchRequest) {
    throw new Error('Dispatch request map coordinates could not be updated.')
  }
  return response.data.dispatchRequest
}

export type DispatchRequestPage = {
  dispatchRequests: DispatchRequest[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

export async function getDispatchRequests(
  filters: DispatchRequestFilters,
): Promise<DispatchRequestPage> {
  const params = new URLSearchParams({
    page: String(filters.page),
    limit: String(filters.limit),
  })
  if (filters.status) params.set('status', filters.status)
  if (filters.priority) params.set('priority', filters.priority)

  const response = await apiRequest<DispatchRequestPage>(
    `/api/dispatch-requests?${params}`,
  )
  if (!response.data) {
    throw new Error('Dispatch requests could not be loaded.')
  }
  return response.data
}

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
    && item.rank > 0
    && Number.isInteger(item.modelRank)
    && item.modelRank > 0
    && Number.isFinite(item.predictedDurationMinutes)
    && item.predictedDurationMinutes > 0
    && Number.isFinite(item.suitabilityScore)
    && item.suitabilityScore >= 0
    && item.suitabilityScore <= 100
    && item.workload
    && Number.isInteger(item.workload.activeDispatchCount)
    && item.workload.activeDispatchCount >= 0
    && Number.isInteger(item.workload.maxOrders)
    && item.workload.maxOrders > 0
    && (item.distanceKm === null || (Number.isFinite(item.distanceKm) && item.distanceKm >= 0))
    && Number.isInteger(item.historicalCompletedDeliveries)
    && item.historicalCompletedDeliveries >= 0
    && (item.historicalMedianDurationMinutes === null
      || (Number.isFinite(item.historicalMedianDurationMinutes)
        && item.historicalMedianDurationMinutes > 0))
    && Array.isArray(item.scoreExplanation)
    && item.scoreExplanation.every((reason) => typeof reason === 'string')
    && Array.isArray(item.explanation)
    && item.explanation.every((reason) => typeof reason === 'string'),
  )
}

export function sanitizeRecommendationDisplayText(text: string): string {
  return text.replace(/\bsynthetic\b/gi, 'illustrative demo')
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
  const recommendations = result?.recommendations
  const rankedAlternatives = result?.rankedAlternatives
  if (
    !result
    || result.dispatchRequestId !== requestId
    || !Array.isArray(recommendations)
    || !Array.isArray(rankedAlternatives)
    || (recommendations as unknown[]).some((item, index) =>
      !isAgentRecommendation(item) || item.rank !== index + 1)
    || (rankedAlternatives as unknown[]).some((item, index) =>
      !isAgentRecommendation(item)
      || item.rank !== index + 2
      || item.agent.id !== recommendations[index + 1]?.agent.id
      || item.modelRank !== recommendations[index + 1]?.modelRank
      || item.suitabilityScore !== recommendations[index + 1]?.suitabilityScore
      || item.predictedDurationMinutes !== recommendations[index + 1]?.predictedDurationMinutes)
    || new Set(recommendations.map((item) => item.agent.id)).size !== recommendations.length
    || new Set(recommendations.map((item) => item.modelRank)).size !== recommendations.length
    || recommendations.some((item) => item.modelRank > recommendations.length)
    || !(
      result.recommendedAgent === null
        ? recommendations.length === 0
        : isAgentRecommendation(result.recommendedAgent)
          && result.recommendedAgent.rank === 1
          && result.recommendedAgent.modelRank === recommendations[0]?.modelRank
          && result.recommendedAgent.agent.id === recommendations[0]?.agent.id
          && result.recommendedAgent.suitabilityScore === recommendations[0]?.suitabilityScore
          && result.recommendedAgent.predictedDurationMinutes === recommendations[0]?.predictedDurationMinutes
    )
    || !['available', 'no_eligible_candidates'].includes(result.predictionStatus)
    || (result.predictionStatus === 'no_eligible_candidates') !== (recommendations.length === 0)
    || !(result.modelVersion === null || typeof result.modelVersion === 'string')
    || !(result.trainingSource === null || result.trainingSource === 'synthetic')
    || !rankingData
    || typeof rankingData.pickupCoordinatesAvailable !== 'boolean'
    || !Number.isInteger(rankingData.agentsWithFreshGps)
    || rankingData.agentsWithFreshGps < 0
    || typeof rankingData.historicalPerformanceAvailable !== 'boolean'
    || !Number.isInteger(rankingData.minimumHistoricalDeliveries)
    || rankingData.minimumHistoricalDeliveries < 0
    || !Array.isArray(result.notes)
    || !result.notes.every((note) => typeof note === 'string')
    || rankedAlternatives.length !== Math.max(recommendations.length - 1, 0)
  ) {
    throw new Error('The recommendation service returned an invalid response.')
  }
  const sanitizeRecommendation = (recommendation: AgentRecommendation): AgentRecommendation => ({
    ...recommendation,
    explanation: recommendation.explanation.map(sanitizeRecommendationDisplayText),
    scoreExplanation: recommendation.scoreExplanation.map(sanitizeRecommendationDisplayText),
  })
  return {
    ...result,
    recommendations: result.recommendations.map(sanitizeRecommendation),
    recommendedAgent: result.recommendedAgent
      ? sanitizeRecommendation(result.recommendedAgent)
      : null,
    rankedAlternatives: result.rankedAlternatives.map(sanitizeRecommendation),
    notes: result.notes.map(sanitizeRecommendationDisplayText),
  }
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

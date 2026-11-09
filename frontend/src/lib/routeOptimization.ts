import { apiRequest } from './api'
import type { RouteDeliveryOption, RoutePreview, RouteStop, SavedRoutePlan } from '../types/routeOptimization'

function isRouteStop(value: unknown): value is RouteStop {
  if (!value || typeof value !== 'object') return false
  const stop = value as RouteStop
  return typeof stop.dispatchRequestId === 'string'
    && (stop.stopType === 'pickup' || stop.stopType === 'delivery')
    && Number.isFinite(stop.latitude) && stop.latitude >= -90 && stop.latitude <= 90
    && Number.isFinite(stop.longitude) && stop.longitude >= -180 && stop.longitude <= 180
}

function isRouteSummary(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const route = value as RoutePreview['optimized']
  return Array.isArray(route.stops) && route.stops.length > 0 && route.stops.every(isRouteStop)
    && Number.isFinite(route.distanceMeters) && route.distanceMeters >= 0
    && Number.isFinite(route.durationSeconds) && route.durationSeconds >= 0
    && Array.isArray(route.geometry) && route.geometry.length >= 2
    && route.geometry.every((point) => Array.isArray(point) && point.length === 2
      && point.every(Number.isFinite) && point[0] >= -90 && point[0] <= 90 && point[1] >= -180 && point[1] <= 180)
}

function isRoutePreview(value: unknown): value is RoutePreview {
  if (!value || typeof value !== 'object') return false
  const preview = value as RoutePreview
  return typeof preview.agentId === 'string'
    && preview.routingProvider === 'OSRM'
    && Number.isFinite(preview.origin?.latitude) && preview.origin.latitude >= -90 && preview.origin.latitude <= 90
    && Number.isFinite(preview.origin?.longitude) && preview.origin.longitude >= -180 && preview.origin.longitude <= 180
    && ['fresh_agent_gps', 'first_route_stop'].includes(preview.origin.source)
    && typeof preview.baselineLabel === 'string'
    && isRouteSummary(preview.baseline)
    && isRouteSummary(preview.optimized)
    && (preview.improvement?.distancePercent === null || Number.isFinite(preview.improvement.distancePercent))
    && (preview.improvement?.durationPercent === null || Number.isFinite(preview.improvement.durationPercent))
}

export async function getRouteDeliveries(agentId: string): Promise<RouteDeliveryOption[]> {
  const response = await apiRequest<{ deliveries: RouteDeliveryOption[] }>(
    `/api/route-optimization/agents/${encodeURIComponent(agentId)}/deliveries`,
  )
  if (!Array.isArray(response.data?.deliveries)) throw new Error('Eligible route deliveries could not be loaded.')
  return response.data.deliveries
}

export async function getSavedRoutePlan(agentId: string): Promise<SavedRoutePlan | null> {
  const response = await apiRequest<{ routePlan: SavedRoutePlan | null }>(
    `/api/route-optimization/agents/${encodeURIComponent(agentId)}/plan`,
  )
  if (response.data?.routePlan !== null && !response.data?.routePlan) {
    throw new Error('The saved route plan response was invalid.')
  }
  return response.data?.routePlan ?? null
}

export async function previewRoute(agentId: string, dispatchRequestIds: string[]): Promise<RoutePreview> {
  const response = await apiRequest<{ preview: RoutePreview }>('/api/route-optimization/preview', {
    method: 'POST',
    body: JSON.stringify({ agentId, dispatchRequestIds }),
  })
  if (!isRoutePreview(response.data?.preview)) throw new Error('The routing service returned an invalid route preview.')
  return response.data.preview
}

export async function applyRoute(
  agentId: string,
  dispatchRequestIds: string[],
  stopSequence: RoutePreview['optimized']['stops'],
): Promise<SavedRoutePlan> {
  const response = await apiRequest<{ routePlan: SavedRoutePlan }>('/api/route-optimization/apply', {
    method: 'POST',
    body: JSON.stringify({
      agentId,
      dispatchRequestIds,
      stopSequence: stopSequence.map(({ dispatchRequestId, stopType }) => ({ dispatchRequestId, stopType })),
    }),
  })
  const routePlan = response.data?.routePlan
  if (!routePlan || routePlan.agentId !== agentId || !Array.isArray(routePlan.stopSequence)) {
    throw new Error('The saved route plan response was invalid.')
  }
  return routePlan
}

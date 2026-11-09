export type RouteStopType = 'pickup' | 'delivery'

export type RouteStop = {
  dispatchRequestId: string
  stopType: RouteStopType
  latitude: number
  longitude: number
}

export type RouteGeometryPoint = [number, number]

export type RouteSummary = {
  stops: RouteStop[]
  distanceMeters: number
  durationSeconds: number
  geometry: RouteGeometryPoint[]
}

export type RoutePreview = {
  agentId: string
  routingProvider: 'OSRM'
  origin: { latitude: number; longitude: number; source: 'fresh_agent_gps' | 'first_route_stop' }
  baselineLabel: string
  baseline: RouteSummary
  optimized: RouteSummary
  improvement: { distancePercent: number | null; durationPercent: number | null }
}

export type RouteDeliveryOption = {
  dispatchRequestId: string
  status: 'assigned' | 'picked_up' | 'in_transit'
  priority: string
  createdAt: string
  missingCoordinates: string[]
}

export type SavedRoutePlan = {
  id: string
  agentId: string
  dispatchRequestIds: string[]
  stopSequence: Array<{ dispatchRequestId: string; stopType: RouteStopType }>
  appliedAt: string
}

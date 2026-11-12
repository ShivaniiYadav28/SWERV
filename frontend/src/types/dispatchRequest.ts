export const dispatchRequestStatuses = [
  'pending',
  'assigned',
  'picked_up',
  'in_transit',
  'delivered',
  'cancelled',
  'failed',
] as const

export type DispatchRequestStatus = (typeof dispatchRequestStatuses)[number]
export type DispatchPriority = 'standard' | 'express' | 'urgent'
export type PackageCategory =
  | 'documents'
  | 'parcel'
  | 'food'
  | 'fragile'
  | 'heavy_goods'
  | 'other'

export type DispatchContact = {
  name: string
  email: string
  phone: string
}

export type DispatchLocation = {
  address: string
  addressLine2?: string
  city: string
  region: string
  postalCode: string
  country: string
  instructions?: string
  latitude?: number | null
  longitude?: number | null
}

export type DispatchCoordinatePoint = {
  latitude: number | null
  longitude: number | null
}

export type DispatchPackage = {
  description: string
  category: PackageCategory
  weightKg: number
  quantity: number
}

type DispatchRequestFields = {
  pickup: DispatchLocation
  delivery: DispatchLocation
  package: DispatchPackage
  priority: DispatchPriority
}

export type CreateDispatchRequestInput = DispatchRequestFields & (
  | { customer: DispatchContact; customerId?: never }
  | { customerId: string; customer?: never }
)

export type AssignedAgentSummary = {
  _id: string
  agentCode: string
  name: string
  status: string
  vehicle: {
    vehicleType: string
    registrationNumber: string
    manufacturer: string
    model: string
  }
}

export type DispatchRequest = {
  _id: string
  customer: DispatchContact
  customerId?: string | null
  pickup: DispatchLocation
  delivery: DispatchLocation
  package: DispatchPackage
  priority: DispatchPriority
  status: DispatchRequestStatus
  assignedAgent: AssignedAgentSummary | null
  createdAt: string
  updatedAt: string
}

export type DispatchRequestActivity = {
  _id: string
  dispatchRequestId: string
  eventType: string
  description: string
  performedBy: { _id: string; name: string; email: string } | string
  previousValue: unknown
  newValue: unknown
  createdAt: string
}

export type DispatchRequestDetails = {
  dispatchRequest: DispatchRequest
  activity: DispatchRequestActivity[]
}

export type DeliveryTimePrediction = {
  predictedDurationMinutes: number
  modelVersion: string
  predictionStatus: 'available'
}

export type DemoDeliveryTimePrediction = {
  predictedDurationMinutes: number
  predictionType: 'simulated_demo'
  modelVersion: string
  predictionStatus: 'available'
  disclaimer: string
}

export type AgentRecommendation = {
  rank: number
  agent: {
    id: string
    name: string
    agentCode: string
    vehicleType: string
  }
  predictedDurationMinutes: number
  workload: {
    activeDispatchCount: number
    maxOrders: number
  }
  distanceKm: number | null
  historicalCompletedDeliveries: number
  historicalMedianDurationMinutes: number | null
  explanation: string[]
}

export type AgentRecommendationResult = {
  dispatchRequestId: string
  recommendations: AgentRecommendation[]
  predictionStatus: 'available' | 'no_eligible_candidates'
  modelVersion: string | null
  trainingSource: 'synthetic' | null
  rankingData: {
    pickupCoordinatesAvailable: boolean
    agentsWithFreshGps: number
    historicalPerformanceAvailable: boolean
    minimumHistoricalDeliveries: number
  }
  notes: string[]
}

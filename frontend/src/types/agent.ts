export const agentStatuses = [
  'available',
  'unavailable',
  'on_duty',
  'suspended',
] as const

export type AgentStatus = (typeof agentStatuses)[number]
export type VehicleType = 'car' | 'van' | 'motorcycle' | 'truck' | 'bicycle'
export type AgentCapability =
  | 'parcel_delivery'
  | 'food_delivery'
  | 'document_delivery'
  | 'heavy_goods'
  | 'express_delivery'

export type AgentInput = {
  name: string
  email: string
  phone: string
  vehicle: {
    vehicleType: VehicleType
    registrationNumber: string
    manufacturer: string
    model: string
  }
  capacity: { maxOrders: number }
  capabilities: AgentCapability[]
}

export type Agent = AgentInput & {
  _id: string
  agentCode: string
  isActive: boolean
  status: AgentStatus
  activeDispatchCount?: number
  createdAt: string
  updatedAt: string
}

export type AgentActivity = {
  _id: string
  eventType: 'agent_created' | 'agent_updated' | 'status_changed' | 'agent_archived'
  description: string
  performedBy: { _id: string; name: string; email: string } | string
  previousValue?: unknown
  newValue?: unknown
  createdAt: string
}

import type { DispatchContact, DispatchLocation, DispatchPackage, DispatchPriority, DispatchRequestStatus } from './dispatchRequest'

export type AgentProfile = {
  id: string
  name: string
  email: string
  agentCode: string
  status: 'available' | 'unavailable' | 'on_duty' | 'suspended'
  isActive: boolean
}

export type AgentDelivery = {
  _id: string
  customer: DispatchContact
  pickup: DispatchLocation
  delivery: DispatchLocation
  package: DispatchPackage
  priority: DispatchPriority
  status: DispatchRequestStatus
  assignedAgent: string | null
  createdAt: string
  updatedAt: string
}

export type AgentDeliveryActivity = {
  _id: string
  eventType: string
  actorType?: 'user' | 'agent'
  description: string
  performedBy?: { _id: string; name: string; email: string } | string | null
  performedByAgent?: { _id: string; name: string; email: string; agentCode: string } | string | null
  createdAt: string
}

export type AgentDeliveryDetails = {
  dispatchRequest: AgentDelivery
  activity: AgentDeliveryActivity[]
}

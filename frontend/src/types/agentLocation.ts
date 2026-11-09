import type { AgentStatus, VehicleType } from './agent'

export type AgentLocation = {
  agentId: string
  latitude: number
  longitude: number
  accuracy?: number
  speed?: number
  heading?: number
  recordedAt: string
  receivedAt: string
  activeDispatch?: { _id: string; status: string; priority: string } | null
  agent: {
    _id: string
    agentCode: string
    name: string
    status: AgentStatus
    vehicle: {
      vehicleType: VehicleType
      registrationNumber: string
      manufacturer: string
      model: string
    }
  }
}

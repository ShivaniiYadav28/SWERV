import { apiRequest } from './api'
import type { AgentLocation } from '../types/agentLocation'

export async function getLatestAgentLocations(): Promise<AgentLocation[]> {
  const response = await apiRequest<{ locations: AgentLocation[] }>('/api/agent-locations')
  if (!response.data) throw new Error('Agent locations could not be loaded.')
  return response.data.locations
}

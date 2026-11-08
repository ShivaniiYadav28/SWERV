import { apiRequest } from './api'
import type { Agent, AgentActivity, AgentInput, AgentStatus } from '../types/agent'

export type AgentFilters = {
  page: number
  limit: number
  search: string
  status: string
  vehicleType: string
  capability: string
  isActive: boolean
}

export type AgentPage = {
  agents: Agent[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

export async function getAgents(filters: AgentFilters): Promise<AgentPage> {
  const params = new URLSearchParams({
    page: String(filters.page),
    limit: String(filters.limit),
    isActive: String(filters.isActive),
  })
  if (filters.search) params.set('search', filters.search)
  if (filters.status) params.set('status', filters.status)
  if (filters.vehicleType) params.set('vehicleType', filters.vehicleType)
  if (filters.capability) params.set('capability', filters.capability)

  const response = await apiRequest<AgentPage>(`/api/agents?${params}`)
  if (!response.data) throw new Error('The agent list could not be loaded.')
  return response.data
}

export async function getAgent(id: string) {
  const response = await apiRequest<{ agent: Agent; activity: AgentActivity[] }>(
    `/api/agents/${id}`,
  )
  if (!response.data) throw new Error('Agent details could not be loaded.')
  return response.data
}

export async function saveAgent(input: AgentInput, id?: string) {
  return apiRequest<{ agent: Agent }>(id ? `/api/agents/${id}` : '/api/agents', {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify(input),
  })
}

export async function setAgentStatus(id: string, status: AgentStatus) {
  return apiRequest<{ agent: Agent }>(`/api/agents/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export async function archiveAgent(id: string) {
  return apiRequest<{ agent: Agent }>(`/api/agents/${id}/archive`, {
    method: 'PATCH',
  })
}

export async function restoreAgent(id: string) {
  return apiRequest<{ agent: Agent }>(`/api/agents/${id}/restore`, {
    method: 'PATCH',
  })
}

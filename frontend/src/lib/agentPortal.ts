import { apiRequest } from './api'
import type { AgentDelivery, AgentDeliveryDetails, AgentProfile } from '../types/agentDelivery'

export type AgentDeliveryStatus = 'picked_up' | 'in_transit' | 'delivered'

export type AgentGpsLocation = {
  latitude: number
  longitude: number
  accuracy?: number
  speed?: number
  heading?: number
  recordedAt: string
}

export type AgentGpsSession = { expiresAt: string }

let currentAgentRequest: Promise<AgentProfile> | null = null

export async function agentLogin(email: string, password: string): Promise<AgentProfile> {
  const response = await apiRequest<{ agent: AgentProfile }>('/api/agent/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  if (!response.data) throw new Error('Agent sign in could not be completed.')
  return response.data.agent
}

export function getCurrentAgent(): Promise<AgentProfile> {
  if (!currentAgentRequest) {
    currentAgentRequest = apiRequest<{ agent: AgentProfile }>('/api/agent/auth/me')
      .then((response) => {
        if (!response.data) throw new Error('Agent profile could not be loaded.')
        return response.data.agent
      })
      .finally(() => {
        currentAgentRequest = null
      })
  }
  return currentAgentRequest
}

export async function agentLogout(): Promise<void> {
  await apiRequest<null>('/api/agent/auth/logout', { method: 'POST' })
}

export async function getAgentDeliveries(): Promise<AgentDelivery[]> {
  const response = await apiRequest<{ deliveries: AgentDelivery[] }>('/api/agent/deliveries')
  if (!response.data) throw new Error('Assigned deliveries could not be loaded.')
  return response.data.deliveries
}

export async function getAgentDeliveryHistory(): Promise<AgentDelivery[]> {
  const response = await apiRequest<{ deliveries: AgentDelivery[] }>('/api/agent/deliveries/history')
  if (!response.data) throw new Error('Delivery history could not be loaded.')
  return response.data.deliveries
}

export async function getAgentDelivery(id: string): Promise<AgentDeliveryDetails> {
  const response = await apiRequest<AgentDeliveryDetails>(`/api/agent/deliveries/${encodeURIComponent(id)}`)
  if (!response.data) throw new Error('Delivery details could not be loaded.')
  return response.data
}

export async function updateAgentDeliveryStatus(id: string, status: AgentDeliveryStatus): Promise<AgentDelivery> {
  const response = await apiRequest<{ dispatchRequest: AgentDelivery }>(`/api/agent/deliveries/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
  if (!response.data) throw new Error('Delivery status could not be updated.')
  return response.data.dispatchRequest
}

export async function startAgentGpsSession(): Promise<AgentGpsSession> {
  const response = await apiRequest<AgentGpsSession>('/api/agent-locations/browser-session', { method: 'POST' })
  if (!response.data) throw new Error('Secure GPS session could not be started.')
  return response.data
}

export async function stopAgentGpsSession(): Promise<void> {
  await apiRequest<null>('/api/agent-locations/browser-session', { method: 'DELETE' })
}

export async function submitAgentGpsLocation(location: AgentGpsLocation): Promise<void> {
  await apiRequest('/api/agent-locations/browser', {
    method: 'POST',
    body: JSON.stringify(location),
  })
}

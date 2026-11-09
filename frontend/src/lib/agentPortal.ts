import { apiBlobRequest, apiRequest } from './api.ts'
import type { AgentDelivery, AgentDeliveryDetails, AgentProfile } from '../types/agentDelivery'
import type { PodLocation, PodStatus } from '../types/proofOfDelivery'

export type AgentDeliveryStatus = 'picked_up' | 'in_transit'

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

export async function getAgentPodStatus(id: string): Promise<PodStatus> {
  const response = await apiRequest<PodStatus>(`/api/agent/deliveries/${encodeURIComponent(id)}/pod`)
  if (!response.data) throw new Error('Proof of delivery status could not be loaded.')
  return response.data
}

export async function uploadAgentPodImage(id: string, type: 'photo' | 'signature', file: Blob, fileName: string): Promise<void> {
  await apiRequest(`/api/agent/deliveries/${encodeURIComponent(id)}/pod/${type}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(fileName) },
    body: file,
  })
}

export async function requestAgentPodOtp(id: string): Promise<{ deliveryMode: 'development_test_code'; developmentOtp: string; expiresAt: string }> {
  const response = await apiRequest<{ deliveryMode: 'development_test_code'; developmentOtp: string; expiresAt: string }>(`/api/agent/deliveries/${encodeURIComponent(id)}/pod/otp`, { method: 'POST' })
  if (!response.data) throw new Error('Customer verification code could not be created.')
  return response.data
}

export async function verifyAgentPodOtp(id: string, otp: string): Promise<void> {
  await apiRequest(`/api/agent/deliveries/${encodeURIComponent(id)}/pod/otp/verify`, { method: 'POST', body: JSON.stringify({ otp }) })
}

export async function submitAgentPod(id: string, location: PodLocation): Promise<void> {
  await apiRequest(`/api/agent/deliveries/${encodeURIComponent(id)}/pod/submit`, { method: 'POST', body: JSON.stringify(location) })
}

export function getAgentPodImage(id: string, type: 'photo' | 'signature'): Promise<Blob> {
  return apiBlobRequest(`/api/agent/deliveries/${encodeURIComponent(id)}/pod/evidence/${type}`)
}

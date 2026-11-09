import { apiBlobRequest, apiRequest } from './api.ts'
import type { PodRecord } from '../types/proofOfDelivery'

export async function getPodRecords(): Promise<PodRecord[]> {
  const response = await apiRequest<{ records: PodRecord[] }>('/api/admin/pod')
  if (!response.data) throw new Error('Proof of delivery records could not be loaded.')
  return response.data.records
}

export async function getPodRecord(dispatchId: string): Promise<PodRecord> {
  const response = await apiRequest<{ pod: PodRecord }>(`/api/admin/pod/${encodeURIComponent(dispatchId)}`)
  if (!response.data) throw new Error('Proof of delivery could not be loaded.')
  return response.data.pod
}

export function getAdminPodImage(dispatchId: string, type: 'photo' | 'signature'): Promise<Blob> {
  return apiBlobRequest(`/api/admin/pod/${encodeURIComponent(dispatchId)}/evidence/${type}`)
}

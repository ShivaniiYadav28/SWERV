import { ApiError, apiBlobRequest, apiRequest } from './api.ts'
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

export async function getAdminPodEvidence(dispatchId: string): Promise<{ photo: Blob | null; signature: Blob | null }> {
  const results = await Promise.allSettled([
    getAdminPodImage(dispatchId, 'photo'),
    getAdminPodImage(dispatchId, 'signature'),
  ])
  const readResult = (result: PromiseSettledResult<Blob>): Blob | null => {
    if (result.status === 'fulfilled') return result.value
    if (result.reason instanceof ApiError && result.reason.status === 404) return null
    throw result.reason
  }
  return { photo: readResult(results[0]), signature: readResult(results[1]) }
}

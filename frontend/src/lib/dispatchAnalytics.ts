import { apiRequest } from './api'
import type { DispatchAnalytics } from '../types/dispatchAnalytics'

export async function getDispatchAnalytics(): Promise<DispatchAnalytics> {
  const response = await apiRequest<DispatchAnalytics>('/api/dispatch-analytics')
  if (!response.data) {
    throw new Error('Dispatch analytics could not be loaded.')
  }
  return response.data
}

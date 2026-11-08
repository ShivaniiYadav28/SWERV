import { ApiError, apiRequest } from './api.ts'
import type { CustomerDeliveryStatus, CustomerTrackingData, CustomerTrackingAddress } from '../types/customerTracking.ts'

const trackingTokenPattern = /^[A-Za-z0-9_-]{43}$/

export function isTerminalDeliveryStatus(status: CustomerDeliveryStatus): boolean {
  return status === 'delivered' || status === 'cancelled' || status === 'failed'
}

export function getCustomerTrackingErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'This tracking link is invalid, expired, or no longer available. Please contact the sender for help.'
  }
  if (error instanceof ApiError && error.status === 429) {
    return 'There have been too many tracking requests. Please wait a moment and try again.'
  }
  return error instanceof Error
    ? error.message
    : 'Delivery tracking is temporarily unavailable. Please try again shortly.'
}

export async function getCustomerTracking(token: string): Promise<CustomerTrackingData> {
  if (!trackingTokenPattern.test(token)) {
    throw new ApiError('This tracking link is invalid or incomplete.', 404)
  }

  const response = await apiRequest<{ tracking: CustomerTrackingData }>(
    `/api/public/tracking/${encodeURIComponent(token)}`,
    { credentials: 'omit' },
  )
  if (!response.data) throw new Error('Delivery tracking could not be loaded.')
  return response.data.tracking
}

export function getAddressMapPosition(address: CustomerTrackingAddress): [number, number] | null {
  const coordinates = address.coordinates
  if (!coordinates) return null
  const { latitude, longitude } = coordinates
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null
  return [latitude, longitude]
}

export function getAgentMapPosition(
  location: CustomerTrackingData['location'],
): [number, number] | null {
  if (!location) return null
  const { latitude, longitude } = location
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null
  return [latitude, longitude]
}

export function getCustomerTrackingMapPoints(tracking: CustomerTrackingData) {
  const pickup = getAddressMapPosition(tracking.pickup)
  const destination = getAddressMapPosition(tracking.destination)
  const isLocationVisible = tracking.status === 'picked_up' || tracking.status === 'in_transit'
  const agent = isLocationVisible ? getAgentMapPosition(tracking.location) : null
  const route = pickup && destination
    ? [pickup, ...(agent ? [agent] : []), destination]
    : []
  const positions = [pickup, agent, destination]
    .filter((position): position is [number, number] => position !== null)

  return { pickup, destination, agent, route, positions }
}

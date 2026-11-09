import type { AgentGpsLocation } from './agentPortal'

export function shouldAutomaticallyStartGps(
  hasActiveDelivery: boolean,
  isEligibilityLoading: boolean,
  wasManuallyStopped: boolean,
): boolean {
  return hasActiveDelivery && !isEligibilityLoading && !wasManuallyStopped
}

const maximumGpsAgeMs = 2 * 60_000
const maximumFutureGpsTimeMs = 5 * 60_000

export function toGpsLocation(position: GeolocationPosition, now = Date.now()): AgentGpsLocation | null {
  const { latitude, longitude, accuracy, speed, heading } = position.coords
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null

  const recordedAt = position.timestamp
  if (!Number.isFinite(recordedAt) || recordedAt <= 0) return null
  if (now - recordedAt > maximumGpsAgeMs || recordedAt - now > maximumFutureGpsTimeMs) return null

  return {
    latitude,
    longitude,
    ...(Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100_000 ? { accuracy } : {}),
    ...(speed !== null && Number.isFinite(speed) && speed >= 0 && speed <= 1_000 ? { speed } : {}),
    ...(heading !== null && Number.isFinite(heading) && heading >= 0 && heading <= 360 ? { heading } : {}),
    recordedAt: new Date(recordedAt).toISOString(),
  }
}

export function getGpsErrorState(code: number) {
  if (code === 1) {
    return {
      status: 'permission-required' as const,
      message: 'GPS permission is required. Allow location access in browser settings, then try again.',
    }
  }
  if (code === 3) {
    return {
      status: 'unavailable' as const,
      message: 'GPS is taking too long to respond. Waiting for another location fix…',
    }
  }
  return {
    status: 'unavailable' as const,
    message: 'Your location is temporarily unavailable. We’ll keep trying.',
  }
}

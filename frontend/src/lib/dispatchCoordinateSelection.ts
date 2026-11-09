import type { CreateDispatchRequestInput } from '../types/dispatchRequest.ts'

export type DispatchMapPoint = { latitude: number; longitude: number }
type DispatchLocations = Pick<CreateDispatchRequestInput, 'pickup' | 'delivery'>

export type ManualCoordinateResult =
  | { point: DispatchMapPoint; error: null }
  | { point: null; error: string }

export function parseManualCoordinates(latitudeText: string, longitudeText: string): ManualCoordinateResult {
  if (!latitudeText.trim() || !longitudeText.trim()) {
    return { point: null, error: 'Enter both latitude and longitude.' }
  }

  const latitude = Number(latitudeText)
  const longitude = Number(longitudeText)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { point: null, error: 'Latitude must be between -90 and 90.' }
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { point: null, error: 'Longitude must be between -180 and 180.' }
  }
  return { point: { latitude, longitude }, error: null }
}

export function updateDispatchLocationPoint(
  locations: DispatchLocations,
  place: 'pickup' | 'delivery',
  point: DispatchMapPoint | null,
): DispatchLocations {
  return {
    ...locations,
    [place]: {
      ...locations[place],
      latitude: point?.latitude,
      longitude: point?.longitude,
    },
  }
}

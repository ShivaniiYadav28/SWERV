import type { CreateDispatchRequestInput } from '../types/dispatchRequest.ts'

export type DispatchMapPoint = { latitude: number; longitude: number }
type DispatchLocations = Pick<CreateDispatchRequestInput, 'pickup' | 'delivery'>

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

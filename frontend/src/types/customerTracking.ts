export type CustomerDeliveryStatus =
  | 'pending'
  | 'assigned'
  | 'picked_up'
  | 'in_transit'
  | 'delivered'
  | 'cancelled'
  | 'failed'

export type CustomerTrackingAddress = {
  address: string
  addressLine2?: string
  city: string
  region: string
  postalCode: string
  country: string
  coordinates?: { latitude: number; longitude: number } | null
}

export type CustomerTrackingTimelineItem = {
  status: CustomerDeliveryStatus
  description: string
  timestamp: string
}

export type CustomerTrackingData = {
  status: CustomerDeliveryStatus
  package: { description: string; category: string }
  pickup: CustomerTrackingAddress
  destination: CustomerTrackingAddress
  priority: string
  timeline: CustomerTrackingTimelineItem[]
  location: { latitude: number; longitude: number; recordedAt: string } | null
  lastLocationUpdate: string | null
  estimatedArrival: string | null
}

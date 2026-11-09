export type PodStatus = {
  photoUploaded: boolean
  signatureUploaded: boolean
  otpVerified: boolean
  otpExpiresAt: string | null
  locationRequired: boolean
  photoFileName?: string | null
  signatureFileName?: string | null
}

export type PodLocation = {
  latitude?: number
  longitude?: number
  accuracyMeters?: number
  locationUnavailableReason?: 'permission_denied' | 'unsupported' | 'timeout' | 'not_available'
}

export type PodRecord = {
  _id: string
  dispatchRequestId: string
  agentId: string
  agent: { name: string; agentCode: string } | null
  photo: { contentType: string; fileName: string }
  signature: { contentType: string; fileName: string }
  otpVerified: boolean
  otpVerifiedAt: string
  locationStatus: 'captured' | 'unavailable'
  latitude: number | null
  longitude: number | null
  accuracyMeters: number | null
  locationUnavailableReason: string | null
  deliveredAt: string
  createdAt: string
}

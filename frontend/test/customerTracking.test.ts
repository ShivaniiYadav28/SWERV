import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError } from '../src/lib/api.ts'
import {
  getAddressMapPosition,
  getAgentMapPosition,
  getCustomerTracking,
  getCustomerTrackingErrorMessage,
  getCustomerTrackingMapPoints,
  isTerminalDeliveryStatus,
} from '../src/lib/customerTracking.ts'
import type { CustomerTrackingData } from '../src/types/customerTracking.ts'

const validTracking: CustomerTrackingData = {
  status: 'in_transit',
  package: { description: 'Boxed item', category: 'parcel' },
  pickup: { address: '10 North Street', city: 'Portland', region: 'OR', postalCode: '97201', country: 'USA' },
  destination: { address: '25 River Road', city: 'Portland', region: 'OR', postalCode: '97202', country: 'USA' },
  priority: 'standard',
  timeline: [],
  location: { latitude: 37.7, longitude: -122.4, recordedAt: '2026-01-01T00:00:00.000Z' },
  lastLocationUpdate: '2026-01-01T00:00:00.000Z',
  estimatedArrival: null,
}

describe('public customer tracking', () => {
  it('loads a valid token without sending authenticated session cookies', async () => {
    const previousFetch = globalThis.fetch
    let requestCredentials: RequestCredentials | undefined
    globalThis.fetch = async (_input, init) => {
      requestCredentials = init?.credentials
      return Response.json({ success: true, message: 'ok', data: { tracking: validTracking } })
    }

    try {
      const tracking = await getCustomerTracking('a'.repeat(43))
      assert.equal(tracking.status, 'in_transit')
      assert.equal(requestCredentials, 'omit')
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('rejects malformed tokens with a helpful customer message', async () => {
    await assert.rejects(
      getCustomerTracking('not-a-token'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.match(getCustomerTrackingErrorMessage(error), /invalid, expired, or no longer available/i)
        return true
      },
    )
  })

  it('gives the same safe message for expired and revoked links', () => {
    const missingLinkError = new ApiError('Tracking link is invalid or expired.', 404)
    assert.match(getCustomerTrackingErrorMessage(missingLinkError), /invalid, expired, or no longer available/i)
  })

  it('returns valid marker positions and updates when agent coordinates change', () => {
    assert.deepEqual(getAgentMapPosition(validTracking.location), [37.7, -122.4])
    assert.deepEqual(getAgentMapPosition({ ...validTracking.location!, latitude: 38.1, longitude: -121.9 }), [38.1, -121.9])
    assert.equal(getAgentMapPosition(null), null)
    assert.equal(getAgentMapPosition({ ...validTracking.location!, latitude: 91 }), null)
    assert.deepEqual(
      getAddressMapPosition({ ...validTracking.pickup, coordinates: { latitude: 45, longitude: -122 } }),
      [45, -122],
    )
    assert.equal(getAddressMapPosition(validTracking.destination), null)
  })

  it('uses only supplied pickup, agent and destination coordinates for the map route', () => {
    const trackingWithStops: CustomerTrackingData = {
      ...validTracking,
      pickup: { ...validTracking.pickup, coordinates: { latitude: 45, longitude: -122 } },
      destination: { ...validTracking.destination, coordinates: { latitude: 46, longitude: -123 } },
    }
    const points = getCustomerTrackingMapPoints(trackingWithStops)

    assert.deepEqual(points.pickup, [45, -122])
    assert.deepEqual(points.agent, [37.7, -122.4])
    assert.deepEqual(points.destination, [46, -123])
    assert.deepEqual(points.route, [[45, -122], [37.7, -122.4], [46, -123]])
    assert.deepEqual(points.positions, points.route)
  })

  it('hides agent coordinates outside active post-pickup statuses', () => {
    const trackingWithStops: CustomerTrackingData = {
      ...validTracking,
      status: 'delivered',
      pickup: { ...validTracking.pickup, coordinates: { latitude: 45, longitude: -122 } },
      destination: { ...validTracking.destination, coordinates: { latitude: 46, longitude: -123 } },
    }
    const points = getCustomerTrackingMapPoints(trackingWithStops)

    assert.equal(points.agent, null)
    assert.deepEqual(points.route, [[45, -122], [46, -123]])
  })

  it('shows available markers without inventing missing coordinates', () => {
    const points = getCustomerTrackingMapPoints(validTracking)
    assert.equal(points.pickup, null)
    assert.equal(points.destination, null)
    assert.deepEqual(points.positions, [points.agent])
    assert.deepEqual(points.route, [])
  })

  it('recognizes terminal delivery statuses so polling can stop', () => {
    assert.equal(isTerminalDeliveryStatus('delivered'), true)
    assert.equal(isTerminalDeliveryStatus('cancelled'), true)
    assert.equal(isTerminalDeliveryStatus('failed'), true)
    assert.equal(isTerminalDeliveryStatus('in_transit'), false)
  })
})

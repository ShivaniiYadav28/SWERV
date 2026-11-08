import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getGpsErrorState, toGpsLocation } from '../src/lib/agentGps.ts'

function gpsPosition(overrides: Partial<GeolocationCoordinates> = {}): GeolocationPosition {
  const coords = {
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 8,
    altitude: null,
    altitudeAccuracy: null,
    heading: 90,
    speed: 12,
    ...overrides,
  } as GeolocationCoordinates
  return { coords, timestamp: Date.UTC(2026, 0, 1), toJSON: () => ({}) }
}

describe('agent GPS browser data', () => {
  it('turns a valid browser position into a backend GPS update', () => {
    assert.deepEqual(toGpsLocation(gpsPosition()), {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 8,
      speed: 12,
      heading: 90,
      recordedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('omits unavailable optional measurements and rejects invalid coordinates', () => {
    const position = gpsPosition({ speed: null, heading: null, latitude: Number.NaN })
    assert.equal(toGpsLocation(position), null)
    assert.equal(toGpsLocation(gpsPosition({ longitude: 181 })), null)
    assert.deepEqual(toGpsLocation(gpsPosition({ speed: null, heading: null })), {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 8,
      recordedAt: '2026-01-01T00:00:00.000Z',
    })
    assert.equal('accuracy' in (toGpsLocation(gpsPosition({ accuracy: 100_001 })) ?? {}), false)
    assert.equal('speed' in (toGpsLocation(gpsPosition({ speed: 1_001 })) ?? {}), false)
  })

  it('maps permission denial, timeout, and unavailable location to clear states', () => {
    assert.equal(getGpsErrorState(1).status, 'permission-required')
    assert.match(getGpsErrorState(1).message, /permission/)
    assert.equal(getGpsErrorState(2).status, 'unavailable')
    assert.match(getGpsErrorState(2).message, /temporarily unavailable/)
    assert.equal(getGpsErrorState(3).status, 'unavailable')
    assert.match(getGpsErrorState(3).message, /too long/)
  })
})

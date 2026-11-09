import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getGpsErrorState, shouldAutomaticallyStartGps, toGpsLocation } from '../src/lib/agentGps.ts'

function gpsPosition(overrides: Partial<GeolocationCoordinates> = {}, timestamp = Date.now()): GeolocationPosition {
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
  return { coords, timestamp, toJSON: () => ({}) }
}

describe('agent GPS browser data', () => {
  it('automatically starts GPS only after an active delivery is confirmed', () => {
    assert.equal(shouldAutomaticallyStartGps(true, false, false), true)
    assert.equal(shouldAutomaticallyStartGps(false, false, false), false)
    assert.equal(shouldAutomaticallyStartGps(true, true, false), false)
    assert.equal(shouldAutomaticallyStartGps(true, false, true), false)
  })

  it('turns a valid browser position into a backend GPS update', () => {
    const timestamp = Date.now()
    assert.deepEqual(toGpsLocation(gpsPosition({}, timestamp), timestamp), {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 8,
      speed: 12,
      heading: 90,
      recordedAt: new Date(timestamp).toISOString(),
    })
  })

  it('omits unavailable optional measurements and rejects invalid coordinates', () => {
    const position = gpsPosition({ speed: null, heading: null, latitude: Number.NaN })
    assert.equal(toGpsLocation(position), null)
    assert.equal(toGpsLocation(gpsPosition({ longitude: 181 })), null)
    const timestamp = Date.now()
    assert.deepEqual(toGpsLocation(gpsPosition({ speed: null, heading: null }, timestamp), timestamp), {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 8,
      recordedAt: new Date(timestamp).toISOString(),
    })
    assert.equal('accuracy' in (toGpsLocation(gpsPosition({ accuracy: 100_001 })) ?? {}), false)
    assert.equal('speed' in (toGpsLocation(gpsPosition({ speed: 1_001 })) ?? {}), false)
  })

  it('rejects browser readings with invalid or stale timestamps before sending them', () => {
    const now = Date.now()
    assert.equal(toGpsLocation(gpsPosition({}, now - 3 * 60_000), now), null)
    assert.equal(toGpsLocation(gpsPosition({}, 0), now), null)
    assert.equal(toGpsLocation(gpsPosition({}, now + 6 * 60_000), now), null)
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

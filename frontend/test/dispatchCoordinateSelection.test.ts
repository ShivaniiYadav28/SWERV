import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { updateDispatchLocationPoint } from '../src/lib/dispatchCoordinateSelection.ts'

const locations = {
  pickup: {
    address: '10 North Street', city: 'Portland', region: 'OR', postalCode: '97201', country: 'USA',
  },
  delivery: {
    address: '25 River Road', city: 'Portland', region: 'OR', postalCode: '97202', country: 'USA',
  },
}

describe('dispatch map coordinate selection', () => {
  it('updates only pickup coordinates and keeps address fields', () => {
    const updated = updateDispatchLocationPoint(locations, 'pickup', { latitude: 45.5, longitude: -122.6 })

    assert.deepEqual(updated.pickup, {
      ...locations.pickup,
      latitude: 45.5,
      longitude: -122.6,
    })
    assert.deepEqual(updated.delivery, locations.delivery)
  })

  it('updates only destination coordinates', () => {
    const updated = updateDispatchLocationPoint(locations, 'delivery', { latitude: 46.1, longitude: -123.2 })

    assert.deepEqual(updated.delivery, {
      ...locations.delivery,
      latitude: 46.1,
      longitude: -123.2,
    })
    assert.deepEqual(updated.pickup, locations.pickup)
  })

  it('clears selected coordinates without removing the address', () => {
    const selected = updateDispatchLocationPoint(locations, 'pickup', { latitude: 45.5, longitude: -122.6 })
    const cleared = updateDispatchLocationPoint(selected, 'pickup', null)

    assert.equal(cleared.pickup.latitude, undefined)
    assert.equal(cleared.pickup.longitude, undefined)
    assert.equal(cleared.pickup.address, locations.pickup.address)
  })
})

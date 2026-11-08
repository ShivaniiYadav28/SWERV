import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { updateDispatchRequestCoordinates } from '../src/lib/dispatchRequests.ts'

describe('dispatch coordinate save request', () => {
  it('patches the selected request with top-level pickup and delivery coordinates', async () => {
    const originalFetch = globalThis.fetch
    let requestedUrl = ''
    let requestedMethod = ''
    let requestedBody = ''
    const requestId = '507f1f77bcf86cd799439011'
    const expectedCoordinates = {
      pickup: { latitude: 45.5231, longitude: -122.6765 },
      delivery: { latitude: 45.5152, longitude: -122.6784 },
    }

    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input)
      requestedMethod = init?.method ?? ''
      requestedBody = String(init?.body ?? '')
      return Response.json({
        success: true,
        message: 'Coordinates saved.',
        data: { dispatchRequest: { _id: requestId, ...expectedCoordinates } },
      })
    }) as typeof fetch

    try {
      const updatedRequest = await updateDispatchRequestCoordinates(requestId, expectedCoordinates)

      assert.ok(requestedUrl.endsWith(`/api/dispatch-requests/${requestId}/coordinates`))
      assert.equal(requestedMethod, 'PATCH')
      assert.deepEqual(JSON.parse(requestedBody), expectedCoordinates)
      assert.equal(updatedRequest._id, requestId)
      assert.deepEqual(updatedRequest.pickup, expectedCoordinates.pickup)
      assert.deepEqual(updatedRequest.delivery, expectedCoordinates.delivery)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

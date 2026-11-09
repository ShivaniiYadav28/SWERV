import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDispatchRequest, getDispatchRequest, requestDeliveryTimePrediction, updateDispatchRequestCoordinates } from '../src/lib/dispatchRequests.ts'

describe('dispatch detail request', () => {
  it('loads only the dispatch selected by its database ID', async () => {
    const originalFetch = globalThis.fetch
    const dispatchId = '507f1f77bcf86cd799439013'
    let requestedUrl = ''
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input)
      return Response.json({
        success: true,
        message: 'Dispatch loaded.',
        data: { dispatchRequest: { _id: dispatchId, customer: { name: 'Rohan Mehta' } }, activity: [] },
      })
    }) as typeof fetch

    try {
      const details = await getDispatchRequest(dispatchId)
      assert.ok(requestedUrl.endsWith(`/api/dispatch-requests/${dispatchId}`))
      assert.equal(details.dispatchRequest._id, dispatchId)
      assert.equal(details.dispatchRequest.customer.name, 'Rohan Mehta')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('delivery time prediction response', () => {
  it('returns the model prediction and synthetic provenance for the selected dispatch', async () => {
    const originalFetch = globalThis.fetch
    let requestedUrl = ''
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input)
      return Response.json({
        success: true,
        message: 'Prediction generated.',
        data: { prediction: {
          predictedDurationMinutes: 34.11,
          modelVersion: 'gradient_boosting-synthetic-916a99cdc260',
          predictionStatus: 'available',
        } },
      })
    }) as typeof fetch

    try {
      const prediction = await requestDeliveryTimePrediction('6af1607673c78ab463a23fb6')
      assert.ok(requestedUrl.endsWith('/api/dispatch-requests/6af1607673c78ab463a23fb6/prediction'))
      assert.deepEqual(prediction, {
        predictedDurationMinutes: 34.11,
        modelVersion: 'gradient_boosting-synthetic-916a99cdc260',
        predictionStatus: 'available',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('dispatch creation coordinates', () => {
  it('sends independently selected pickup and destination coordinates in the create request', async () => {
    const originalFetch = globalThis.fetch
    let requestedBody = ''
    const createInput = {
      customerId: '507f1f77bcf86cd799439012',
      pickup: { address: 'Pickup', city: 'Bengaluru', region: 'KA', postalCode: '560001', country: 'India', latitude: 12.9716, longitude: 77.5946 },
      delivery: { address: 'Destination', city: 'Bengaluru', region: 'KA', postalCode: '560002', country: 'India', latitude: 12.9352, longitude: 77.6245 },
      package: { description: 'Parcel', category: 'parcel' as const, weightKg: 1, quantity: 1 },
      priority: 'standard' as const,
    }

    globalThis.fetch = (async (_input, init) => {
      requestedBody = String(init?.body ?? '')
      return Response.json({
        success: true,
        message: 'Dispatch created.',
        data: { dispatchRequest: { _id: '507f1f77bcf86cd799439013' } },
      })
    }) as typeof fetch

    try {
      await createDispatchRequest(createInput)
      const sentRequest = JSON.parse(requestedBody)
      assert.deepEqual(sentRequest.pickup, createInput.pickup)
      assert.deepEqual(sentRequest.delivery, createInput.delivery)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

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

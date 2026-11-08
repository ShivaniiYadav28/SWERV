import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError } from '../src/lib/api.ts'
import { requestDeliveryTimePrediction } from '../src/lib/dispatchRequests.ts'

const requestId = '507f1f77bcf86cd799439011'
const validPrediction = {
  predictedDurationMinutes: 24.5,
  modelVersion: 'linear_regression-abc123',
  predictionStatus: 'available' as const,
}

describe('delivery time prediction request', () => {
  it('posts without a body and returns a valid prediction', async () => {
    const originalFetch = globalThis.fetch
    let requestedUrl = ''
    let requestedMethod = ''
    let requestedBody: BodyInit | null | undefined
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input)
      requestedMethod = init?.method ?? ''
      requestedBody = init?.body
      return Response.json({
        success: true,
        message: 'Prediction generated.',
        data: { prediction: validPrediction },
      })
    }) as typeof fetch

    try {
      const prediction = await requestDeliveryTimePrediction(requestId)
      assert.ok(requestedUrl.endsWith(`/api/dispatch-requests/${requestId}/prediction`))
      assert.equal(requestedMethod, 'POST')
      assert.equal(requestedBody, undefined)
      assert.deepEqual(prediction, validPrediction)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('preserves the backend unavailable status for the page to handle', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({
      success: false,
      message: 'Delivery time prediction is currently unavailable.',
    }, { status: 503 })) as typeof fetch

    try {
      await assert.rejects(
        requestDeliveryTimePrediction(requestId),
        (error: unknown) => error instanceof ApiError && error.status === 503,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not accept an invalid prediction as success', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({
      success: true,
      message: 'Prediction generated.',
      data: {
        prediction: { ...validPrediction, predictedDurationMinutes: 0 },
      },
    })) as typeof fetch

    try {
      await assert.rejects(
        requestDeliveryTimePrediction(requestId),
        /invalid prediction/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

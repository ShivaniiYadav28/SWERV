import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getAgentRecommendations } from '../src/lib/dispatchRequests.ts'

const requestId = '507f1f77bcf86cd799439011'
const validResult = {
  dispatchRequestId: requestId,
  recommendations: [{
    rank: 1,
    agent: { id: '507f1f77bcf86cd799439012', name: 'Taylor Driver', agentCode: 'AGT-12345678', vehicleType: 'van' },
    score: 72,
    workload: { activeDispatchCount: 1, maxOrders: 4 },
    distanceKm: 2.3,
    historicalCompletedDeliveries: 12,
    historicalMedianDurationMinutes: 24.5,
    explanation: ['Package and priority capabilities match (parcel_delivery).'],
  }],
  rankingData: {
    pickupCoordinatesAvailable: true,
    agentsWithFreshGps: 1,
    historicalPerformanceAvailable: true,
    minimumHistoricalDeliveries: 10,
  },
  notes: ['Vehicle type is not currently a restriction in SWERV assignment rules.'],
}

describe('agent recommendations request', () => {
  it('gets recommendations without sending a request body', async () => {
    const originalFetch = globalThis.fetch
    let requestedUrl = ''
    let requestedMethod = ''
    let requestedBody: BodyInit | null | undefined
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input)
      requestedMethod = init?.method ?? 'GET'
      requestedBody = init?.body
      return Response.json({ success: true, message: 'Recommendations ready.', data: validResult })
    }) as typeof fetch

    try {
      const result = await getAgentRecommendations(requestId)
      assert.ok(requestedUrl.endsWith(`/api/dispatch-requests/${requestId}/agent-recommendations`))
      assert.equal(requestedMethod, 'GET')
      assert.equal(requestedBody, undefined)
      assert.deepEqual(result, validResult)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects an invalid backend recommendation response', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({
      success: true,
      message: 'Recommendations ready.',
      data: { ...validResult, recommendations: [{ ...validResult.recommendations[0], distanceKm: -2 }] },
    })) as typeof fetch

    try {
      await assert.rejects(getAgentRecommendations(requestId), /invalid response/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

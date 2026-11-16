import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getAgentRecommendations } from '../src/lib/dispatchRequests.ts'

const requestId = '507f1f77bcf86cd799439011'
const recommendedAgent = {
  rank: 1,
  modelRank: 1,
  agent: { id: '507f1f77bcf86cd799439012', name: 'Taylor Driver', agentCode: 'AGT-12345678', vehicleType: 'van' },
  predictedDurationMinutes: 45,
  suitabilityScore: 72,
  scoreExplanation: ['The synthetic model predicts a shorter delivery duration.'],
  workload: { activeDispatchCount: 1, maxOrders: 4 },
  distanceKm: 2.3,
  historicalCompletedDeliveries: 12,
  historicalMedianDurationMinutes: 24.5,
  explanation: ['Package and priority capabilities match (parcel_delivery).'],
}
const validResult = {
  dispatchRequestId: requestId,
  recommendations: [recommendedAgent],
  recommendedAgent,
  rankedAlternatives: [],
  predictionStatus: 'available',
  modelVersion: 'gradient_boosting-synthetic-test',
  trainingSource: 'synthetic',
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
      assert.equal(result.recommendations[0]?.suitabilityScore, 72)
      assert.equal(result.recommendedAgent?.agent.id, recommendedAgent.agent.id)
      assert.equal(result.recommendations[0]?.scoreExplanation[0], 'The illustrative demo model predicts a shorter delivery duration.')
      assert.equal(result.modelVersion, validResult.modelVersion)
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

  it('rejects rankings that do not match the recommended agent or alternatives', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({
      success: true,
      message: 'Recommendations ready.',
      data: { ...validResult, recommendedAgent: null },
    })) as typeof fetch

    try {
      await assert.rejects(getAgentRecommendations(requestId), /invalid response/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects an out-of-range suitability score and malformed candidate data', async () => {
    const originalFetch = globalThis.fetch
    const invalidCandidate = { ...recommendedAgent, suitabilityScore: 101 }
    globalThis.fetch = (async () => Response.json({
      success: true,
      message: 'Recommendations ready.',
      data: {
        ...validResult,
        recommendations: [invalidCandidate],
        recommendedAgent: invalidCandidate,
      },
    })) as typeof fetch

    try {
      await assert.rejects(getAgentRecommendations(requestId), /invalid response/)
      globalThis.fetch = (async () => Response.json({
        success: true,
        message: 'Recommendations ready.',
        data: { ...validResult, recommendations: [null] },
      })) as typeof fetch
      await assert.rejects(getAgentRecommendations(requestId), /invalid response/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

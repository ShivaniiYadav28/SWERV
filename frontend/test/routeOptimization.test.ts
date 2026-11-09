import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { previewRoute } from '../src/lib/routeOptimization.ts'

const agentId = '507f1f77bcf86cd799439011'
const dispatchId = '507f1f77bcf86cd799439012'
const routeStop = {
  dispatchRequestId: dispatchId,
  stopType: 'pickup',
  latitude: 12.9716,
  longitude: 77.5946,
}
const validPreview = {
  agentId,
  routingProvider: 'OSRM',
  origin: { latitude: 12.9716, longitude: 77.5946, source: 'first_route_stop' },
  baselineLabel: 'Dispatch creation order',
  baseline: { stops: [routeStop], distanceMeters: 100, durationSeconds: 60, geometry: [[12.97, 77.59], [12.98, 77.60]] },
  optimized: { stops: [routeStop], distanceMeters: 90, durationSeconds: 50, geometry: [[12.97, 77.59], [12.98, 77.60]] },
  improvement: { distancePercent: 10, durationPercent: 16.7 },
}

describe('route optimization API helper', () => {
  it('sends selected dispatch IDs to the authenticated backend preview endpoint', async () => {
    const originalFetch = globalThis.fetch
    let requestUrl = ''
    let requestBody: BodyInit | null | undefined
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input)
      requestBody = init?.body
      return Response.json({ success: true, message: 'ready', data: { preview: validPreview } })
    }) as typeof fetch
    try {
      const preview = await previewRoute(agentId, [dispatchId])
      assert.ok(requestUrl.endsWith('/api/route-optimization/preview'))
      assert.deepEqual(JSON.parse(String(requestBody)), { agentId, dispatchRequestIds: [dispatchId] })
      assert.deepEqual(preview, validPreview)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects invalid provider results instead of showing fabricated route metrics', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({
      success: true, message: 'ready', data: { preview: { ...validPreview, routingProvider: 'unknown', optimized: { ...validPreview.optimized, distanceMeters: Number.NaN } } },
    })) as typeof fetch
    try {
      await assert.rejects(previewRoute(agentId, [dispatchId]), /invalid route preview/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

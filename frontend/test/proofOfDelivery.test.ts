import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getAdminPodImage, getPodRecords } from '../src/lib/proofOfDelivery.ts'
import { requestAgentPodOtp, submitAgentPod, uploadAgentPodImage, verifyAgentPodOtp } from '../src/lib/agentPortal.ts'

const dispatchId = '507f1f77bcf86cd799439011'

describe('proof of delivery API helpers', () => {
  it('uploads raw image bytes with their MIME type and filename', async () => {
    const originalFetch = globalThis.fetch
    let requestUrl = ''
    let requestBody: BodyInit | null | undefined
    let requestHeaders: HeadersInit | undefined
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input)
      requestBody = init?.body
      requestHeaders = init?.headers
      return Response.json({ success: true, message: 'saved', data: { uploaded: true } }, { status: 201 })
    }) as typeof fetch
    try {
      const photo = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
      await uploadAgentPodImage(dispatchId, 'photo', photo, 'delivery proof.png')
      assert.ok(requestUrl.endsWith(`/api/agent/deliveries/${dispatchId}/pod/photo`))
      assert.equal(requestBody, photo)
      assert.equal(new Headers(requestHeaders).get('Content-Type'), 'image/png')
      assert.equal(new Headers(requestHeaders).get('X-File-Name'), 'delivery%20proof.png')
    } finally { globalThis.fetch = originalFetch }
  })

  it('uses the backend OTP, verification, and completion routes', async () => {
    const originalFetch = globalThis.fetch
    const urls: string[] = []
    const methods: string[] = []
    globalThis.fetch = (async (input, init) => {
      urls.push(String(input)); methods.push(init?.method ?? 'GET')
      return Response.json({ success: true, message: 'ok', data: { deliveryMode: 'development_test_code', developmentOtp: '123456', expiresAt: '2026-01-01T00:05:00.000Z' } })
    }) as typeof fetch
    try {
      const code = await requestAgentPodOtp(dispatchId)
      assert.equal(code.developmentOtp, '123456')
      await verifyAgentPodOtp(dispatchId, code.developmentOtp)
      await submitAgentPod(dispatchId, { latitude: 12.9, longitude: 77.6, accuracyMeters: 12 })
      assert.ok(urls[0].endsWith(`/api/agent/deliveries/${dispatchId}/pod/otp`))
      assert.ok(urls[1].endsWith(`/api/agent/deliveries/${dispatchId}/pod/otp/verify`))
      assert.ok(urls[2].endsWith(`/api/agent/deliveries/${dispatchId}/pod/submit`))
      assert.deepEqual(methods, ['POST', 'POST', 'POST'])
    } finally { globalThis.fetch = originalFetch }
  })

  it('loads Admin POD records and authenticated evidence through the backend API', async () => {
    const originalFetch = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (input) => {
      urls.push(String(input))
      if (urls.length === 1) return Response.json({ success: true, message: 'ok', data: { records: [] } })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } })
    }) as typeof fetch
    try {
      assert.deepEqual(await getPodRecords(), [])
      assert.equal((await getAdminPodImage(dispatchId, 'signature')).type, 'image/png')
      assert.ok(urls[0].endsWith('/api/admin/pod'))
      assert.ok(urls[1].endsWith(`/api/admin/pod/${dispatchId}/evidence/signature`))
    } finally { globalThis.fetch = originalFetch }
  })
})

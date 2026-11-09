import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkIn, checkOut, getAdminAgentAttendance, getMyAttendance } from '../src/lib/agentAttendance.ts'

const record = {
  _id: 'attendance-1',
  agentId: 'agent-1',
  attendanceDate: '2026-03-01',
  checkInAt: '2026-03-01T03:30:00.000Z',
  checkOutAt: null,
  createdAt: '2026-03-01T03:30:00.000Z',
  updatedAt: '2026-03-01T03:30:00.000Z',
  durationMinutes: null,
}

const pageData = {
  records: [record],
  todayAttendance: record,
  summary: { totalRecords: 1, completedCheckouts: 0, openRecords: 1, totalDurationMinutes: 0 },
  pagination: { page: 1, limit: 10, total: 1, pages: 1 },
}

function apiUrl(value: string): URL {
  const url = new URL(value)
  assert.equal(url.origin, 'http://localhost:5000')
  return url
}

describe('agent attendance API helpers', () => {
  it('checks in and checks out without sending an agent ID or client timestamp', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body })
      return Response.json({ success: true, message: 'ok', data: { attendance: record } })
    }) as typeof fetch
    try {
      await checkIn()
      await checkOut()
      assert.deepEqual(calls.map(({ url, method }) => [apiUrl(url).pathname, method]), [
        ['/api/agent/attendance/check-in', 'POST'],
        ['/api/agent/attendance/check-out', 'POST'],
      ])
      for (const call of calls) {
        assert.deepEqual(JSON.parse(String(call.body)), {})
        assert.ok(!apiUrl(call.url).searchParams.has('agentId'))
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('loads personal history and admin records with the requested filters', async () => {
    const originalFetch = globalThis.fetch
    const requestedUrls: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      requestedUrls.push(url)
      const data = url.includes('/api/agent-attendance')
        ? { ...pageData, records: [{ ...record, agent: { _id: 'agent-1', name: 'Morgan Lee', email: 'morgan@example.com', agentCode: 'AGT-1001' }, status: 'checked_in' }] }
        : pageData
      return Response.json({ success: true, message: 'ok', data })
    }) as typeof fetch
    try {
      assert.deepEqual(await getMyAttendance({ page: 2, limit: 10, startDate: '2026-03-01' }), pageData)
      const adminResult = await getAdminAgentAttendance({ page: 1, limit: 20, agentId: 'agent-1', search: 'Morgan', endDate: '2026-03-31' })
      assert.equal(adminResult.records[0].agent.name, 'Morgan Lee')
      const personalUrl = apiUrl(requestedUrls[0])
      const adminUrl = apiUrl(requestedUrls[1])
      assert.equal(personalUrl.pathname, '/api/agent/attendance/me')
      assert.equal(personalUrl.searchParams.get('startDate'), '2026-03-01')
      assert.ok(!personalUrl.searchParams.has('agentId'))
      assert.equal(adminUrl.pathname, '/api/agent-attendance')
      assert.equal(adminUrl.searchParams.get('agentId'), 'agent-1')
      assert.equal(adminUrl.searchParams.get('search'), 'Morgan')
      assert.equal(adminUrl.searchParams.get('endDate'), '2026-03-31')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('shows duplicate check-in API errors to the caller', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ success: false, message: 'You have already checked in today.' }, { status: 409 })) as typeof fetch
    try {
      await assert.rejects(checkIn(), /already checked in/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

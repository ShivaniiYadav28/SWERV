import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'
import type { Root } from 'react-dom/client'

const sidebarStubId = '\0attendance-page-test-sidebar'
const sidebarStub = {
  name: 'attendance-page-test-sidebar',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    return importer?.endsWith('/AdminAttendancePage.tsx') && source === '../components/DashboardSidebar'
      ? sidebarStubId
      : undefined
  },
  load(id: string) {
    return id === sidebarStubId ? 'export function DashboardSidebar() { return null }' : undefined
  },
}

const browser = new Window({ url: 'http://localhost' })
Reflect.set(globalThis, 'window', browser)
Reflect.set(globalThis, 'document', browser.document)
Reflect.set(globalThis, 'navigator', browser.navigator)
Reflect.set(globalThis, 'HTMLElement', browser.HTMLElement)
Reflect.set(globalThis, 'HTMLInputElement', browser.HTMLInputElement)
Reflect.set(globalThis, 'HTMLSelectElement', browser.HTMLSelectElement)
Reflect.set(globalThis, 'Node', browser.Node)
Reflect.set(globalThis, 'Event', browser.Event)
Reflect.set(globalThis, 'MouseEvent', browser.MouseEvent)
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const apiOrigin = 'http://localhost:5000'
const checkInTime = new Date().toISOString()
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
const openRecord = {
  _id: 'attendance-open',
  agentId: 'agent-1',
  attendanceDate: today,
  checkInAt: checkInTime,
  checkOutAt: null,
  createdAt: checkInTime,
  updatedAt: checkInTime,
  durationMinutes: null,
}
const closedRecord = {
  ...openRecord,
  _id: 'attendance-closed',
  attendanceDate: '2026-03-01',
  checkInAt: '2026-03-01T03:30:00.000Z',
  checkOutAt: '2026-03-01T04:30:00.000Z',
  durationMinutes: 60,
}

const emptyAgentAttendance = {
  records: [],
  todayAttendance: null,
  summary: { totalRecords: 0, completedCheckouts: 0, openRecords: 0, totalDurationMinutes: 0 },
  pagination: { page: 1, limit: 10, total: 0, pages: 0 },
}
const emptyAdminAttendance = {
  records: [],
  summary: { totalRecords: 0, completedCheckouts: 0, openRecords: 0, totalDurationMinutes: 0 },
  pagination: { page: 1, limit: 20, total: 0, pages: 0 },
}

const agentProfile = {
  id: 'agent-1',
  name: 'Morgan Lee',
  email: 'morgan@example.com',
  agentCode: 'AGT-1001',
  status: 'available' as const,
  isActive: true,
}
const agentAuth = {
  agent: agentProfile,
  isLoading: false,
  loadError: null,
  login: async () => {},
  logout: async () => {},
  refreshAgent: async () => agentProfile,
  clearAgent: () => {},
}
const userAuth = {
  user: {
    id: 'user-1',
    name: 'Attendance Admin',
    email: 'admin@example.com',
    role: 'admin' as const,
    isActive: true,
    createdAt: checkInTime,
    updatedAt: checkInTime,
  },
  isLoading: false,
  loadError: null,
  login: async () => {},
  register: async () => {},
  logout: async () => {},
}

let vite: Awaited<ReturnType<typeof createServer>>
let root: Root | undefined
let originalFetch: typeof fetch
let AgentAttendancePage: (typeof import('../src/pages/AgentAttendancePage.tsx'))['AgentAttendancePage']
let AdminAttendancePage: (typeof import('../src/pages/AdminAttendancePage.tsx'))['AdminAttendancePage']
let AgentAuthContext: (typeof import('../src/context/agent-auth-context.ts'))['AgentAuthContext']
let AuthContext: (typeof import('../src/context/auth-context.ts'))['AuthContext']

before(async () => {
  vite = await createServer({
    configFile: 'vite.config.ts',
    plugins: [sidebarStub],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ AgentAttendancePage } = await vite.ssrLoadModule('/src/pages/AgentAttendancePage.tsx'))
  ;({ AdminAttendancePage } = await vite.ssrLoadModule('/src/pages/AdminAttendancePage.tsx'))
  ;({ AgentAuthContext } = await vite.ssrLoadModule('/src/context/agent-auth-context.ts'))
  ;({ AuthContext } = await vite.ssrLoadModule('/src/context/auth-context.ts'))
})

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
    root = undefined
  }
  browser.document.body.replaceChildren()
  globalThis.fetch = originalFetch
})

after(async () => {
  await vite.close()
  await browser.happyDOM.abort()
})

function response(data: unknown, status = 200): Response {
  return Response.json({ success: status < 400, message: status < 400 ? 'ok' : 'Request failed.', data }, { status })
}

function formatAttendanceTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value))
}

function setFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(new URL(String(input), apiOrigin), init)) as typeof fetch
}

function setControlValue(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = control instanceof browser.HTMLSelectElement
    ? browser.HTMLSelectElement.prototype
    : browser.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(control, value)
  control.dispatchEvent(new browser.Event('input', { bubbles: true }))
  control.dispatchEvent(new browser.Event('change', { bubbles: true }))
}

async function renderAgentPage(): Promise<HTMLElement> {
  const container = browser.document.createElement('div')
  browser.document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(AgentAuthContext.Provider, { value: agentAuth }, createElement(AgentAttendancePage)))
  })
  return container
}

async function renderAdminPage(): Promise<HTMLElement> {
  const container = browser.document.createElement('div')
  browser.document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(
      MemoryRouter,
      null,
      createElement(AuthContext.Provider, { value: userAuth }, createElement(AdminAttendancePage)),
    ))
  })
  return container
}

async function flushEffects(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
}

async function click(container: HTMLElement, buttonText: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(buttonText))
  assert.ok(button, `Expected a button containing "${buttonText}"`)
  await act(async () => {
    button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
}

function agentHistoryResponse(todayAttendance: typeof openRecord | null, records: unknown[] = []) {
  return {
    ...emptyAgentAttendance,
    records,
    todayAttendance,
    summary: { ...emptyAgentAttendance.summary, totalRecords: records.length },
    pagination: { page: 1, limit: 10, total: records.length, pages: records.length ? 1 : 0 },
  }
}

describe('agent attendance page', () => {
  it('checks in and refreshes the page to show the open attendance', async () => {
    let checkedIn = false
    const calls: string[] = []
    setFetch((url, init) => {
      calls.push(`${url.pathname}${url.search}`)
      if (url.pathname.endsWith('/check-in')) {
        checkedIn = true
        return response({ attendance: openRecord }, 201)
      }
      if (url.pathname.endsWith('/check-out')) return response({ attendance: closedRecord })
      return response(agentHistoryResponse(checkedIn ? openRecord : null, checkedIn ? [openRecord] : []))
    })

    const container = await renderAgentPage()
    await flushEffects()
    await click(container, 'Check in')

    assert.match(container.textContent ?? '', /You are checked in for today/)
    assert.match(container.textContent ?? '', /In Progress/)
    assert.equal(container.querySelectorAll('.attendance-event-card').length, 2)
    assert.match(container.querySelector('.attendance-event-card.is-check-in')?.textContent ?? '', /CHECK-IN/)
    assert.match(container.querySelector('.attendance-event-card.is-check-out')?.textContent ?? '', /CHECK-OUT/)
    assert.ok(container.querySelector('.attendance-event-card.is-check-in')?.textContent?.includes(formatAttendanceTime(checkInTime)))
    assert.match(container.querySelector('.attendance-event-card.is-check-out')?.textContent ?? '', /—/)
    assert.ok([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Check out')))
    assert.ok(calls.some((call) => call === '/api/agent/attendance/check-in'))
    assert.equal(calls.filter((call) => call.startsWith('/api/agent/attendance/me')).length, 2)
  })

  it('checks out an open attendance from an earlier IST date', async () => {
    const previousDayRecord = { ...openRecord, attendanceDate: '2026-03-01' }
    let checkedOut = false
    setFetch((url) => {
      if (url.pathname.endsWith('/check-out')) {
        checkedOut = true
        return response({ attendance: { ...previousDayRecord, checkOutAt: checkInTime } })
      }
      return response(agentHistoryResponse(checkedOut ? null : previousDayRecord, checkedOut ? [closedRecord] : [previousDayRecord]))
    })

    const container = await renderAgentPage()
    await flushEffects()
    assert.match(container.textContent ?? '', /OPEN ATTENDANCE · IST/)
    const previousDayLabel = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'full',
      timeZone: 'Asia/Kolkata',
    }).format(new Date('2026-03-01T00:00:00+05:30'))
    assert.ok(container.textContent?.includes(previousDayLabel))
    assert.ok(![...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Check in')))
    await click(container, 'Check out')

    assert.match(container.textContent ?? '', /Your attendance was checked out successfully/)
    assert.ok([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Check in')))
  })

  it('shows loading and API error states', async () => {
    let rejectAttendance: ((error: Error) => void) | undefined
    setFetch((url) => {
      if (url.pathname.endsWith('/me')) {
        return new Promise<Response>((_resolve, reject) => { rejectAttendance = reject })
      }
      return response({})
    })

    const container = await renderAgentPage()
    assert.match(container.textContent ?? '', /Loading today’s attendance/)
    await flushEffects()
    rejectAttendance?.(new Error('Attendance service unavailable.'))
    await flushEffects()

    assert.ok(container.querySelector('[role="alert"]'))
    assert.match(container.textContent ?? '', /backend CORS settings/)
    assert.match(container.textContent ?? '', /Attendance history is unavailable/)
  })

  it('shows attendance history records and pagination', async () => {
    const historyRecord = { ...closedRecord, _id: 'history-1' }
    setFetch((url) => response(url.pathname.endsWith('/me')
      ? {
          ...agentHistoryResponse(null, [historyRecord]),
          pagination: { page: 1, limit: 10, total: 11, pages: 2 },
        }
      : {}))

    const container = await renderAgentPage()
    await flushEffects()

    assert.match(container.textContent ?? '', /Attendance history/)
    assert.match(container.textContent ?? '', /Completed/)
    assert.match(container.textContent ?? '', /1h 0m/)
    assert.ok(container.querySelector('.attendance-event-time.is-check-in')?.textContent?.includes(formatAttendanceTime(closedRecord.checkInAt)))
    assert.ok(container.querySelector('.attendance-event-time.is-check-out')?.textContent?.includes(formatAttendanceTime(closedRecord.checkOutAt)))
    assert.match(container.textContent ?? '', /Page 1 of 2/)
    assert.ok([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Next')))
  })
})

describe('admin attendance page', () => {
  it('loads all agent dropdown pages, applies date and agent filters, and shows table pagination', async () => {
    const agentRequests: URL[] = []
    const attendanceRequests: URL[] = []
    setFetch((url) => {
      if (url.pathname === '/api/agents') {
        agentRequests.push(url)
        const page = Number(url.searchParams.get('page'))
        const isActive = url.searchParams.get('isActive') === 'true'
        const agents = isActive && page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              _id: `agent-${index + 1}`,
              name: `Agent ${index + 1}`,
              email: `agent${index + 1}@example.com`,
              agentCode: `AGT-${index + 1}`,
              isActive: true,
            }))
          : isActive
            ? [{ _id: 'agent-101', name: 'Agent 101', email: 'agent101@example.com', agentCode: 'AGT-101', isActive: true }]
            : []
        return response({ agents, pagination: { page, limit: 100, total: isActive ? 101 : 0, pages: isActive ? 2 : 1 } })
      }
      attendanceRequests.push(url)
      return response({
        ...emptyAdminAttendance,
        records: [{
          ...closedRecord,
          agentId: 'agent-101',
          agent: { _id: 'agent-101', name: 'Agent 101', email: 'agent101@example.com', agentCode: 'AGT-101' },
          status: 'checked_out',
        }],
        summary: { totalRecords: 21, completedCheckouts: 21, openRecords: 0, totalDurationMinutes: 1260 },
        pagination: { page: Number(url.searchParams.get('page') ?? 1), limit: 20, total: 21, pages: 2 },
      })
    })

    const container = await renderAdminPage()
    await flushEffects()

    const agentSelect = container.querySelector<HTMLSelectElement>('.attendance-filter-bar select')
    assert.ok(agentSelect)
    assert.ok([...agentSelect.options].some((option) => option.value === 'agent-101'))
    assert.equal(agentRequests.length, 3)
    assert.match(container.textContent ?? '', /Agent 101/)
    const previousDayLabel = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeZone: 'Asia/Kolkata',
    }).format(new Date('2026-03-01T00:00:00Z'))
    assert.ok(container.textContent?.includes(previousDayLabel))
    assert.match(container.textContent ?? '', /1h 0m/)
    assert.match(container.textContent ?? '', /Completed/)
    assert.ok(container.querySelector('.attendance-event-time.is-check-in')?.textContent?.includes(formatAttendanceTime(closedRecord.checkInAt)))
    assert.ok(container.querySelector('.attendance-event-time.is-check-out')?.textContent?.includes(formatAttendanceTime(closedRecord.checkOutAt)))

    const startDate = container.querySelector<HTMLInputElement>('input[type="date"]')
    const endDate = container.querySelectorAll<HTMLInputElement>('input[type="date"]')[1]
    assert.ok(startDate && endDate)
    await act(async () => {
      setControlValue(startDate, '2026-03-01')
      setControlValue(endDate, '2026-03-31')
      setControlValue(agentSelect, 'agent-101')
    })
    await flushEffects()
    await click(container, 'Apply filters')

    const filteredRequest = attendanceRequests.at(-1)
    assert.equal(filteredRequest?.searchParams.get('startDate'), '2026-03-01')
    assert.equal(filteredRequest?.searchParams.get('endDate'), '2026-03-31')
    assert.equal(filteredRequest?.searchParams.get('agentId'), 'agent-101')
    assert.match(container.textContent ?? '', /Page 1 of 2/)
    await click(container, 'Next')
    assert.equal(attendanceRequests.at(-1)?.searchParams.get('page'), '2')
  })

  it('shows an empty state when no attendance records match', async () => {
    setFetch((url) => url.pathname === '/api/agents'
      ? response({ agents: [], pagination: { page: 1, limit: 100, total: 0, pages: 0 } })
      : response(emptyAdminAttendance))

    const container = await renderAdminPage()
    await flushEffects()

    assert.match(container.textContent ?? '', /No attendance records found/)
    assert.match(container.textContent ?? '', /Try another date range or agent filter/)
  })
})

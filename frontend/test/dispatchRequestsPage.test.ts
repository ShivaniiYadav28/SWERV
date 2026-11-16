import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'
import type { Root } from 'react-dom/client'

const sidebarStubId = '\0dispatch-requests-page-test-sidebar'
const mapPickerStubId = '\0dispatch-requests-page-test-map-picker'
const realtimeStubId = '\0dispatch-requests-page-test-realtime'
const pageStubs = {
  name: 'dispatch-requests-page-test-stubs',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (!importer?.endsWith('/DispatchRequestsPage.tsx')) return undefined
    if (source === '../components/DashboardSidebar') return sidebarStubId
    if (source === '../components/LocationMapPicker') return mapPickerStubId
    if (source === '../lib/realtime') return realtimeStubId
    return undefined
  },
  load(id: string) {
    if (id === sidebarStubId) return 'export function DashboardSidebar() { return null }'
    if (id === mapPickerStubId) return 'export function LocationMapPicker() { return null }'
    if (id === realtimeStubId) {
      return `
        export const dispatchUpdateEvent = 'dispatch:updated';
        export function connectRealtime() {
          return { on() {}, off() {}, disconnect() {} };
        }
      `
    }
    return undefined
  },
}

const browser = new Window({ url: 'http://localhost' })
Reflect.set(globalThis, 'window', browser)
Reflect.set(globalThis, 'document', browser.document)
Reflect.set(globalThis, 'navigator', browser.navigator)
Reflect.set(globalThis, 'HTMLElement', browser.HTMLElement)
Reflect.set(globalThis, 'HTMLSelectElement', browser.HTMLSelectElement)
Reflect.set(globalThis, 'Node', browser.Node)
Reflect.set(globalThis, 'Event', browser.Event)
Reflect.set(globalThis, 'MouseEvent', browser.MouseEvent)
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const apiOrigin = 'http://localhost:5000'
const requestId = '507f1f77bcf86cd799439011'
const agentId = '507f1f77bcf86cd799439012'
const now = '2026-11-16T12:00:00.000Z'
const dispatchRequest = {
  _id: requestId,
  customer: { name: 'Morgan Lee', email: 'morgan@example.com', phone: '5551234567' },
  pickup: {
    address: '10 Main Street',
    city: 'Brooklyn',
    region: 'NY',
    postalCode: '11201',
    country: 'US',
    latitude: 40.69,
    longitude: -73.99,
  },
  delivery: {
    address: '20 Park Avenue',
    city: 'Brooklyn',
    region: 'NY',
    postalCode: '11215',
    country: 'US',
    latitude: 40.67,
    longitude: -73.98,
  },
  package: { description: 'Document packet', category: 'documents', weightKg: 1, quantity: 1 },
  priority: 'standard',
  status: 'pending',
  assignedAgent: null,
  createdAt: now,
  updatedAt: now,
}

function agentRecommendation(
  rank: number,
  id: string,
  name: string,
  suitabilityScore: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    rank,
    modelRank: rank,
    agent: { id, name, agentCode: `AGT-0000000${rank}`, vehicleType: 'van' },
    predictedDurationMinutes: rank === 1 ? 32.5 : 41.2,
    suitabilityScore,
    scoreExplanation: [
      rank === 1
        ? 'The synthetic model estimate and workload contribute to this score.'
        : 'The synthetic model estimate is ranked behind the leading candidate.',
    ],
    workload: { activeDispatchCount: rank - 1, maxOrders: 4 },
    distanceKm: rank === 1 ? 2.4 : 5.1,
    historicalCompletedDeliveries: 15,
    historicalMedianDurationMinutes: 28.5,
    explanation: ['Required delivery capabilities are available.'],
    ...overrides,
  }
}

const recommendationA = agentRecommendation(1, agentId, 'Taylor Driver', 88)
const recommendationB = agentRecommendation(2, '507f1f77bcf86cd799439013', 'Jordan Driver', 74)

function recommendationResult(overrides: Record<string, unknown> = {}) {
  return {
    dispatchRequestId: requestId,
    recommendations: [recommendationA, recommendationB],
    recommendedAgent: recommendationA,
    rankedAlternatives: [recommendationB],
    predictionStatus: 'available',
    modelVersion: 'gradient_boosting-synthetic-private-version',
    trainingSource: 'synthetic',
    rankingData: {
      pickupCoordinatesAvailable: true,
      agentsWithFreshGps: 2,
      historicalPerformanceAvailable: true,
      minimumHistoricalDeliveries: 10,
    },
    notes: ['Synthetic predictions are not verified operational outcomes.'],
    ...overrides,
  }
}

const activeAgent = {
  _id: agentId,
  name: 'Taylor Driver',
  email: 'taylor@example.com',
  phone: '5559876543',
  agentCode: 'AGT-00000001',
  vehicle: {
    vehicleType: 'van',
    registrationNumber: 'NY-12345',
    manufacturer: 'Ford',
    model: 'Transit',
  },
  capacity: { maxOrders: 4 },
  capabilities: ['document_delivery'],
  isActive: true,
  status: 'available',
  activeDispatchCount: 0,
  createdAt: now,
  updatedAt: now,
}

let vite: Awaited<ReturnType<typeof createServer>>
let root: Root | undefined
let originalFetch: typeof fetch
let DispatchRequestsPage: (typeof import('../src/pages/DispatchRequestsPage.tsx'))['DispatchRequestsPage']
let AuthContext: (typeof import('../src/context/auth-context.ts'))['AuthContext']

before(async () => {
  vite = await createServer({
    configFile: 'vite.config.ts',
    plugins: [pageStubs],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ DispatchRequestsPage } = await vite.ssrLoadModule('/src/pages/DispatchRequestsPage.tsx'))
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

function apiResponse(data: unknown, status = 200, message = 'ok'): Response {
  return Response.json({ success: status < 400, message, data }, { status })
}

function setFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (
    handler(new URL(String(input), apiOrigin), init)
  )) as typeof fetch
}

function userAuth(role: 'admin' | 'operator' | null) {
  return {
    user: role
      ? {
        id: `${role}-1`,
        name: `${role} user`,
        email: `${role}@example.com`,
        role,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }
      : null,
    isLoading: false,
    loadError: null,
    login: async () => {},
    register: async () => {},
    logout: async () => {},
  }
}

async function renderPage(role: 'admin' | 'operator' | null = 'admin'): Promise<HTMLElement> {
  const container = browser.document.createElement('div')
  browser.document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(
      MemoryRouter,
      { initialEntries: [`/dispatch-requests?dispatchId=${requestId}`] },
      createElement(
        AuthContext.Provider,
        { value: userAuth(role) },
        createElement(DispatchRequestsPage),
      ),
    ))
  })
  return container
}

async function flushEffects(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
}

async function click(container: HTMLElement, buttonText: string): Promise<void> {
  const button = [...container.querySelectorAll('button')]
    .find((item) => item.textContent?.includes(buttonText))
  assert.ok(button, `Expected a button containing "${buttonText}"`)
  await act(async () => {
    button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, value)
  select.dispatchEvent(new browser.Event('input', { bubbles: true }))
  select.dispatchEvent(new browser.Event('change', { bubbles: true }))
}

function setFetchForPage(options: {
  recommendation?: Record<string, unknown>
  recommendationStatus?: number
  recommendationMessage?: string
  assignmentStatus?: number
  assignmentMessage?: string
  assignmentCalls?: string[]
} = {}) {
  let assigned = false
  setFetch((url, init) => {
    if (url.pathname === '/api/dispatch-requests') {
      return apiResponse({ dispatchRequests: [], pagination: { page: 1, limit: 10, total: 0, pages: 0 } })
    }
    if (url.pathname === `/api/dispatch-requests/${requestId}`) {
      return apiResponse({
        dispatchRequest: {
          ...dispatchRequest,
          assignedAgent: assigned
            ? {
              _id: agentId,
              name: activeAgent.name,
              agentCode: activeAgent.agentCode,
              status: 'available',
              vehicle: { ...activeAgent.vehicle },
            }
            : null,
        },
        activity: [],
      })
    }
    if (url.pathname.endsWith('/agent-recommendations')) {
      return apiResponse(
        options.recommendation ?? recommendationResult(),
        options.recommendationStatus ?? 200,
        options.recommendationMessage ?? 'Recommendations ready.',
      )
    }
    if (url.pathname === '/api/agents') {
      return apiResponse({
        agents: [activeAgent],
        pagination: { page: 1, limit: 100, total: 1, pages: 1 },
      })
    }
    if (url.pathname.endsWith('/assignment') && init?.method === 'PATCH') {
      options.assignmentCalls?.push(String(init.body))
      const status = options.assignmentStatus ?? 200
      if (status < 400) assigned = true
      return apiResponse(
        { dispatchRequest: { ...dispatchRequest, assignedAgent: activeAgent } },
        status,
        options.assignmentMessage ?? 'Assignment updated.',
      )
    }
    return apiResponse({}, 404, 'Not found')
  })
}

describe('dispatch request agent recommendations', () => {
  it('renders recommendation score, duration, ranked alternatives, and safe explanatory context', async () => {
    setFetchForPage()
    const container = await renderPage()
    await flushEffects()
    await click(container, 'Find Best Agent')

    const text = container.textContent ?? ''
    assert.match(text, /Illustrative Demo Recommendations/)
    assert.match(text, /Recommended agent/)
    assert.match(text, /Taylor Driver/)
    assert.match(text, /88\/100/)
    assert.match(text, /32\.5 min/)
    assert.match(text, /Ranked alternatives/)
    assert.match(text, /Alternative #1/)
    assert.match(text, /Jordan Driver/)
    assert.match(text, /74\/100/)
    assert.match(text, /41\.2 min/)
    assert.match(text, /not probabilities/)
    assert.match(text, /Why this agent was recommended/)
    assert.match(text, /illustrative demo predictions are not verified operational outcomes/i)
    assert.doesNotMatch(text, /synthetic/i)
    assert.doesNotMatch(text, /gradient_boosting/i)
  })

  it('explains unavailable distance and history without inventing values', async () => {
    const top = agentRecommendation(1, agentId, 'Taylor Driver', 88, {
      distanceKm: null,
      historicalCompletedDeliveries: 3,
      historicalMedianDurationMinutes: null,
    })
    setFetchForPage({
      recommendation: recommendationResult({
        recommendations: [top],
        recommendedAgent: top,
        rankedAlternatives: [],
        rankingData: {
          pickupCoordinatesAvailable: false,
          agentsWithFreshGps: 0,
          historicalPerformanceAvailable: false,
          minimumHistoricalDeliveries: 10,
        },
      }),
    })
    const container = await renderPage()
    await flushEffects()
    await click(container, 'Find Best Agent')

    assert.match(container.textContent ?? '', /Distance unavailable: pickup coordinates are missing/)
    assert.match(container.textContent ?? '', /Historical context unavailable: 3 of 10 qualifying deliveries/)
  })

  it('shows loading, empty, and sanitized error states', async () => {
    let resolveRecommendations: ((response: Response) => void) | undefined
    setFetch((url) => {
      if (url.pathname === '/api/dispatch-requests') {
        return apiResponse({ dispatchRequests: [], pagination: { page: 1, limit: 10, total: 0, pages: 0 } })
      }
      if (url.pathname === `/api/dispatch-requests/${requestId}`) {
        return apiResponse({ dispatchRequest, activity: [] })
      }
      if (url.pathname.endsWith('/agent-recommendations')) {
        return new Promise<Response>((resolve) => { resolveRecommendations = resolve })
      }
      return apiResponse({})
    })
    const loadingContainer = await renderPage()
    await flushEffects()
    await click(loadingContainer, 'Find Best Agent')
    assert.match(loadingContainer.textContent ?? '', /Finding eligible agents/)
    await act(async () => {
      resolveRecommendations?.(apiResponse(recommendationResult()))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    const emptyResult = recommendationResult({
      recommendations: [],
      recommendedAgent: null,
      rankedAlternatives: [],
      predictionStatus: 'no_eligible_candidates',
    })
    setFetchForPage({ recommendation: emptyResult })
    const emptyContainer = await renderPage()
    await flushEffects()
    await click(emptyContainer, 'Find Best Agent')
    assert.match(emptyContainer.textContent ?? '', /No eligible agents currently meet/)

    setFetchForPage({
      recommendationStatus: 503,
      recommendationMessage: 'Synthetic service temporarily unavailable.',
    })
    const errorContainer = await renderPage()
    await flushEffects()
    await click(errorContainer, 'Find Best Agent')
    assert.match(errorContainer.textContent ?? '', /illustrative demo service temporarily unavailable/i)
    assert.doesNotMatch(errorContainer.textContent ?? '', /synthetic/i)
    assert.ok(errorContainer.querySelector('[role="alert"]'))
  })

  it('offers recommendations only to Admin and Operator users', async () => {
    for (const role of ['admin', 'operator'] as const) {
      setFetchForPage()
      const container = await renderPage(role)
      await flushEffects()
      assert.ok([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Find Best Agent')))
      await act(async () => root?.unmount())
      root = undefined
      browser.document.body.replaceChildren()
    }

    setFetchForPage()
    const unauthenticatedContainer = await renderPage(null)
    await flushEffects()
    assert.equal(
      [...unauthenticatedContainer.querySelectorAll('button')]
        .some((button) => button.textContent?.includes('Find Best Agent')),
      false,
    )
  })

  it('keeps recommendation selection read-only until assignment is reviewed and confirmed', async () => {
    const assignmentCalls: string[] = []
    setFetchForPage({ assignmentCalls })
    const container = await renderPage()
    await flushEffects()
    await click(container, 'Find Best Agent')
    await click(container, 'Select this agent')
    assert.equal(assignmentCalls.length, 0)

    await click(container, 'Continue with selected agent')
    await flushEffects()
    const agentSelect = container.querySelector('.dispatch-agent-select-label select')
    assert.ok(agentSelect instanceof browser.HTMLSelectElement)
    await act(async () => {
      setSelectValue(agentSelect, agentId)
    })
    await click(container, 'Review assignment')
    assert.ok(container.querySelector('[aria-label="Confirm agent assignment"]'))
    assert.equal(assignmentCalls.length, 0)
    await click(container, 'Confirm assignment')
    await flushEffects()

    assert.equal(assignmentCalls.length, 1)
    assert.deepEqual(JSON.parse(assignmentCalls[0] ?? '{}'), { agentId })
    assert.match(container.textContent ?? '', /Agent assignment updated successfully/)
  })

  it('shows assignment failure feedback without assigning the selected agent', async () => {
    setFetchForPage({
      assignmentStatus: 409,
      assignmentMessage: 'The agent is no longer available.',
    })
    const container = await renderPage()
    await flushEffects()
    await click(container, 'Find Best Agent')
    await click(container, 'Select this agent')
    await click(container, 'Continue with selected agent')
    await flushEffects()
    await click(container, 'Review assignment')
    await click(container, 'Confirm assignment')

    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /no longer available/i)
    assert.doesNotMatch(container.textContent ?? '', /Agent assignment updated successfully/)
  })
})

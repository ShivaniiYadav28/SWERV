import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'
import type { Root } from 'react-dom/client'

const sidebarStubId = '\0anomaly-detection-page-test-sidebar'
const sidebarStub = {
  name: 'anomaly-detection-page-test-sidebar',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    return importer?.endsWith('/AnomalyDetectionPage.tsx') && source === '../components/DashboardSidebar'
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
Reflect.set(globalThis, 'HTMLSelectElement', browser.HTMLSelectElement)
Reflect.set(globalThis, 'HTMLTextAreaElement', browser.HTMLTextAreaElement)
Reflect.set(globalThis, 'Node', browser.Node)
Reflect.set(globalThis, 'Event', browser.Event)
Reflect.set(globalThis, 'MouseEvent', browser.MouseEvent)
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const apiOrigin = 'http://localhost:5000'
const now = '2026-11-16T12:00:00.000Z'
const userAuth = {
  user: {
    id: 'admin-1',
    name: 'Anomaly Admin',
    email: 'admin@example.com',
    role: 'admin' as const,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  },
  isLoading: false,
  loadError: null,
  login: async () => {},
  register: async () => {},
  logout: async () => {},
}

const realFinding = {
  _id: 'real-alert-1',
  anomalyType: 'invalid_status_transition',
  severity: 'high' as const,
  dispatchId: 'dispatch-1001',
  agentId: null,
  explanation: 'Recorded status transition pending -> delivered is not allowed by the SWERV lifecycle.',
  evidence: 'pending -> delivered',
  evidenceTimestamp: now,
  measuredValue: 'pending -> delivered',
  threshold: ['assigned', 'cancelled'],
  detectionMethod: 'documented_status_transition_table',
  modelName: null,
  modelVersion: null,
  modelProvenance: null,
  dataSource: 'real' as const,
  detectionMode: 'real' as const,
  dataQualityNotes: [],
  reviewStatus: 'new' as const,
  reviewNotes: '',
  createdAt: now,
}

const demoFindings = [
  {
    _id: 'demo-alert-1',
    anomalyType: 'unsupervised_outlier',
    severity: 'high' as const,
    dispatchId: null,
    agentId: null,
    explanation: 'Isolation Forest score 0.920000 exceeds threshold 0.100000 by 0.820000. Scenario category is a generated dataset label, not a model prediction.',
    evidence: {
      scenarioId: 'demo-route-1',
      scenarioTimestamp: now,
      scenarioCategory: 'route_deviation',
      scenarioCategorySource: 'generated_demo_label',
      scenarioCategoryIsModelPrediction: false,
    },
    evidenceTimestamp: null,
    measuredValue: 0.92,
    threshold: 0.1,
    detectionMethod: 'machine_learning',
    modelName: 'isolation_forest',
    modelVersion: 'isolation_forest-synthetic-test-version',
    modelProvenance: 'Generated demo scenarios; these are not confirmed operational incidents.',
    dataSource: 'synthetic_demo' as const,
    detectionMode: 'synthetic_demo' as const,
    dataQualityNotes: [],
    reviewStatus: 'new' as const,
    reviewNotes: '',
    createdAt: now,
  },
  {
    _id: 'demo-alert-2',
    anomalyType: 'unsupervised_outlier',
    severity: 'medium' as const,
    dispatchId: null,
    agentId: null,
    explanation: 'Isolation Forest score 0.120000 exceeds threshold 0.100000. Scenario category is a generated dataset label, not a model prediction.',
    evidence: {
      scenarioId: 'demo-delay-2',
      scenarioTimestamp: now,
      scenarioCategory: 'delivery_delay',
      scenarioCategorySource: 'generated_demo_label',
      scenarioCategoryIsModelPrediction: false,
    },
    evidenceTimestamp: null,
    measuredValue: 0.12,
    threshold: 0.1,
    detectionMethod: 'machine_learning',
    modelName: 'isolation_forest',
    modelVersion: 'isolation_forest-synthetic-test-version',
    modelProvenance: 'Generated demo scenarios; these are not confirmed operational incidents.',
    dataSource: 'synthetic_demo' as const,
    detectionMode: 'synthetic_demo' as const,
    dataQualityNotes: [],
    reviewStatus: 'new' as const,
    reviewNotes: '',
    createdAt: now,
  },
  {
    _id: 'demo-alert-3',
    anomalyType: 'unsupervised_outlier',
    severity: 'critical' as const,
    dispatchId: null,
    agentId: null,
    explanation: 'Isolation Forest score 0.400000 exceeds threshold 0.100000. Scenario category is a generated dataset label, not a model prediction.',
    evidence: {
      scenarioId: 'demo-distance-3',
      scenarioTimestamp: now,
      scenarioCategory: 'abnormal_delivery_distance',
      scenarioCategorySource: 'generated_demo_label',
      scenarioCategoryIsModelPrediction: false,
    },
    evidenceTimestamp: null,
    measuredValue: 0.4,
    threshold: 0.1,
    detectionMethod: 'machine_learning',
    modelName: 'isolation_forest',
    modelVersion: 'isolation_forest-synthetic-test-version',
    modelProvenance: 'Generated demo scenarios; these are not confirmed operational incidents.',
    dataSource: 'synthetic_demo' as const,
    detectionMode: 'synthetic_demo' as const,
    dataQualityNotes: [],
    reviewStatus: 'new' as const,
    reviewNotes: '',
    createdAt: now,
  },
]

let vite: Awaited<ReturnType<typeof createServer>>
let root: Root | undefined
let originalFetch: typeof fetch
let AnomalyDetectionPage: (typeof import('../src/pages/AnomalyDetectionPage.tsx'))['AnomalyDetectionPage']
let AuthContext: (typeof import('../src/context/auth-context.ts'))['AuthContext']

before(async () => {
  vite = await createServer({
    configFile: 'vite.config.ts',
    plugins: [sidebarStub],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ AnomalyDetectionPage } = await vite.ssrLoadModule('/src/pages/AnomalyDetectionPage.tsx'))
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

function summary(mode: 'real' | 'synthetic_demo') {
  const total = mode === 'real' ? 1 : demoFindings.length
  return { mode, total, new: total, highSeverity: mode === 'real' ? 1 : 2, underReview: 0, resolved: 0 }
}

function alertPage(mode: 'real' | 'synthetic_demo', filters: URLSearchParams) {
  let alerts = mode === 'real' ? [realFinding] : demoFindings
  const severity = filters.get('severity')
  const category = filters.get('anomalyType')
  const reviewStatus = filters.get('reviewStatus')
  if (severity) alerts = alerts.filter((alert) => alert.severity === severity)
  if (reviewStatus) alerts = alerts.filter((alert) => alert.reviewStatus === reviewStatus)
  if (mode === 'real' && category) alerts = alerts.filter((alert) => alert.anomalyType === category)
  const page = Number(filters.get('page') ?? 1)
  const limit = Number(filters.get('limit') ?? 10)
  const total = alerts.length
  const visible = alerts.slice((page - 1) * limit, page * limit)
  return { alerts: visible, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }
}

function detectionResult(mode: 'real' | 'synthetic_demo') {
  const isDemo = mode === 'synthetic_demo'
  return {
    mode,
    detectionSource: isDemo ? 'machine_learning_demo' : 'backend_rule_based',
    modelName: isDemo ? 'isolation_forest' : 'Backend rule checks',
    modelVersion: isDemo ? 'isolation_forest-synthetic-test-version' : null,
    trainingDataSource: isDemo ? 'synthetic' : 'not_applicable',
    syntheticProvenance: isDemo
      ? 'Generated demo scenarios; these are not confirmed operational incidents.'
      : 'These findings were produced by backend rules. No ML model was called.',
    scenarioCount: isDemo ? 30 : 1,
    candidateCount: isDemo ? 2 : 1,
    savedAlerts: isDemo ? 2 : 1,
    duplicateAlertsSkipped: 0,
    limitations: [],
  }
}

function setFetchForMode(mode: 'real' | 'synthetic_demo') {
  setFetch((url, init) => {
    if (url.pathname === '/api/anomaly-detection/summary') {
      return apiResponse(summary(mode))
    }
    if (url.pathname === '/api/anomaly-detection/alerts') {
      return apiResponse(alertPage(mode, url.searchParams))
    }
    if (url.pathname.endsWith('/detect')) {
      const body = JSON.parse(String(init?.body)) as { mode: string }
      return apiResponse(detectionResult(body.mode as 'real' | 'synthetic_demo'))
    }
    if (url.pathname.endsWith('/review')) {
      const alert = mode === 'real' ? realFinding : demoFindings[0]
      const body = JSON.parse(String(init?.body)) as { reviewStatus?: string; reviewNotes?: string }
      return apiResponse({ alert: { ...alert, ...body } })
    }
    if (url.pathname.includes('/alerts/')) {
      const alert = mode === 'real' ? realFinding : demoFindings.find((item) => item._id === url.pathname.split('/').at(-1)) ?? demoFindings[0]
      return apiResponse({ alert })
    }
    return apiResponse({}, 404, 'Not found')
  })
}

async function renderPage(): Promise<HTMLElement> {
  const container = browser.document.createElement('div')
  browser.document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(
      MemoryRouter,
      null,
      createElement(AuthContext.Provider, { value: userAuth }, createElement(AnomalyDetectionPage)),
    ))
  })
  return container
}

async function flushEffects(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
}

async function click(container: HTMLElement, buttonText: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(buttonText))
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

async function chooseDemo(container: HTMLElement): Promise<void> {
  await click(container, 'Anomaly Detection Demo')
  await flushEffects()
}

function assertNoForbiddenWord(container: HTMLElement): void {
  assert.doesNotMatch(container.textContent ?? '', /synthetic/i)
}

describe('AI Anomaly Detection page', () => {
  it('renders Real Data Mode as backend rules with no model score or confidence', async () => {
    setFetchForMode('real')
    const container = await renderPage()
    await flushEffects()

    const text = container.textContent ?? ''
    assert.match(text, /Rule-based operational findings/)
    assert.match(text, /backend rules/i)
    assert.match(text, /invalid status transition/)
    assert.doesNotMatch(text, /Anomaly score|model confidence|Isolation Forest/)
    assertNoForbiddenWord(container)
    assert.ok(container.querySelector('[aria-label^="Severity counts:"]'))
    assert.ok(container.querySelector('[aria-label^="Rule finding category counts:"]'))
  })

  it('renders Demo candidates, score, scenario ID, and generated category as context only', async () => {
    setFetchForMode('real')
    const container = await renderPage()
    await flushEffects()
    setFetchForMode('synthetic_demo')
    await chooseDemo(container)
    await click(container, 'Details')

    const text = container.textContent ?? ''
    assert.match(text, /Anomaly Detection Demo/)
    assert.match(text, /Illustrative scenarios — these are not confirmed operational incidents\./)
    assert.match(text, /unsupervised_outlier/)
    assert.match(text, /0\.9200/)
    assert.match(text, /demo-route-1/)
    assert.match(text, /route deviation/)
    assert.match(text, /generated label, not a model prediction/)
    assert.doesNotMatch(text, /isolation_forest-synthetic-test-version/i)
    assertNoForbiddenWord(container)
  })

  it('handles scenario metadata and missing anomaly scores without inventing a score', async () => {
    const withoutScore = { ...demoFindings[0], measuredValue: null, modelVersion: null }
    setFetch((url) => {
      if (url.pathname.endsWith('/summary')) return apiResponse(summary('synthetic_demo'))
      if (url.pathname.endsWith('/alerts')) return apiResponse({ alerts: [withoutScore], pagination: { page: 1, limit: 100, total: 1, pages: 1 } })
      return apiResponse({})
    })
    const container = await renderPage()
    await flushEffects()
    await chooseDemo(container)

    assert.match(container.textContent ?? '', /Not available/)
    assert.match(container.textContent ?? '', /demo-route-1/)
    assertNoForbiddenWord(container)
  })

  it('filters demo severity and scenario context from actual evidence metadata', async () => {
    setFetchForMode('real')
    const container = await renderPage()
    await flushEffects()
    setFetchForMode('synthetic_demo')
    await chooseDemo(container)

    const severitySelect = container.querySelectorAll('.anomaly-filters select')[0]
    const categorySelect = container.querySelectorAll('.anomaly-filters select')[1]
    assert.ok(severitySelect instanceof browser.HTMLSelectElement)
    assert.ok(categorySelect instanceof browser.HTMLSelectElement)
    await act(async () => {
      setSelectValue(severitySelect, 'high')
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    await act(async () => {
      setSelectValue(categorySelect, 'route_deviation')
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    assert.match(container.textContent ?? '', /demo-route-1/)
    assert.doesNotMatch(container.textContent ?? '', /demo-delay-2|demo-distance-3/)
  })

  it('re-analyzes only the selected mode and reports backend counts', async () => {
    const detectBodies: unknown[] = []
    setFetch((url, init) => {
      if (url.pathname.endsWith('/summary')) return apiResponse(summary(url.searchParams.get('mode') === 'real' ? 'real' : 'synthetic_demo'))
      if (url.pathname.endsWith('/alerts')) return apiResponse(alertPage(url.searchParams.get('mode') === 'real' ? 'real' : 'synthetic_demo', url.searchParams))
      if (url.pathname.endsWith('/detect')) {
        const body = JSON.parse(String(init?.body)) as unknown
        detectBodies.push(body)
        const mode = (body as { mode: 'real' | 'synthetic_demo' }).mode
        return apiResponse(detectionResult(mode))
      }
      return apiResponse({})
    })

    const container = await renderPage()
    await flushEffects()
    await chooseDemo(container)
    await click(container, 'Re-analyze demo')
    await flushEffects()

    assert.deepEqual(detectBodies, [{ mode: 'synthetic_demo' }])
    assert.match(container.textContent ?? '', /Demo analysis complete: 2 model candidates/)
    assertNoForbiddenWord(container)
  })

  it('preserves Admin review notes and status actions for existing findings', async () => {
    const patches: Array<Record<string, unknown>> = []
    setFetch((url, init) => {
      if (url.pathname.endsWith('/summary')) return apiResponse(summary('real'))
      if (url.pathname.endsWith('/alerts') && !url.pathname.endsWith('/review')) return apiResponse(alertPage('real', url.searchParams))
      if (url.pathname.endsWith('/review')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        patches.push(body)
        return apiResponse({ alert: { ...realFinding, ...body } })
      }
      if (url.pathname.includes('/alerts/')) return apiResponse({ alert: realFinding })
      return apiResponse({})
    })
    const container = await renderPage()
    await flushEffects()
    await click(container, 'Details')

    const note = container.querySelector('textarea')
    assert.ok(note instanceof browser.HTMLTextAreaElement)
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(note, 'Verified against dispatch history.')
      note.dispatchEvent(new browser.Event('input', { bubbles: true }))
      note.dispatchEvent(new browser.Event('change', { bubbles: true }))
    })
    await click(container, 'Save Note')
    await click(container, 'Mark under review')
    await flushEffects()

    assert.deepEqual(patches, [
      { reviewNotes: 'Verified against dispatch history.' },
      { reviewStatus: 'under_review', reviewNotes: 'Verified against dispatch history.' },
    ])
    assert.match(container.textContent ?? '', /Backend rule-based finding/)
    assert.doesNotMatch(container.textContent ?? '', /Anomaly score|model confidence/)
    assertNoForbiddenWord(container)
  })

  it('shows loading, empty, and sanitized error states', async () => {
    let resolveSummary: ((value: Response) => void) | undefined
    setFetch((url) => {
      if (url.pathname.endsWith('/summary')) {
        return new Promise<Response>((resolve) => { resolveSummary = resolve })
      }
      return apiResponse({ alerts: [], pagination: { page: 1, limit: 10, total: 0, pages: 0 } })
    })
    const loadingContainer = await renderPage()
    assert.match(loadingContainer.textContent ?? '', /Loading anomaly findings/)
    await flushEffects()
    await act(async () => {
      resolveSummary?.(apiResponse(summary('real')))
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    assert.match(loadingContainer.textContent ?? '', /No rule findings in this view/)

    await act(async () => root?.unmount())
    root = undefined
    browser.document.body.replaceChildren()
    setFetch((url) => url.pathname.endsWith('/summary')
      ? apiResponse({}, 503, 'Synthetic service diagnostic is private.')
      : apiResponse({ alerts: [], pagination: { page: 1, limit: 10, total: 0, pages: 0 } }))
    const errorContainer = await renderPage()
    await flushEffects()
    assert.ok(errorContainer.querySelector('[role="alert"]'))
    assert.doesNotMatch(errorContainer.textContent ?? '', /synthetic/i)
  })
})
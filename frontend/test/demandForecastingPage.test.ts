import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'
import type { Root } from 'react-dom/client'

const sidebarStubId = '\0demand-forecasting-page-test-sidebar'
const sidebarStub = {
  name: 'demand-forecasting-page-test-sidebar',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    return importer?.endsWith('/DemandForecastingPage.tsx') && source === '../components/DashboardSidebar'
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
Reflect.set(globalThis, 'Node', browser.Node)
Reflect.set(globalThis, 'Event', browser.Event)
Reflect.set(globalThis, 'MouseEvent', browser.MouseEvent)
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const apiOrigin = 'http://localhost:5000'
const forecastStartTimestamp = new Date(
  (Math.floor(Date.now() / (60 * 60 * 1_000)) + 1) * 60 * 60 * 1_000,
).toISOString()
const userAuth = {
  user: {
    id: 'admin-1',
    name: 'Demand Admin',
    email: 'demand-admin@example.com',
    role: 'admin' as const,
    isActive: true,
    createdAt: forecastStartTimestamp,
    updatedAt: forecastStartTimestamp,
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
let DemandForecastingPage: (typeof import('../src/pages/DemandForecastingPage.tsx'))['DemandForecastingPage']
let AuthContext: (typeof import('../src/context/auth-context.ts'))['AuthContext']

before(async () => {
  vite = await createServer({
    configFile: 'vite.config.ts',
    plugins: [sidebarStub],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  ;({ DemandForecastingPage } = await vite.ssrLoadModule('/src/pages/DemandForecastingPage.tsx'))
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
  return Response.json({
    success: status < 400,
    message: status < 400 ? 'ok' : 'Forecast service unavailable.',
    data,
  }, { status })
}

function setFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (
    handler(new URL(String(input), apiOrigin), init)
  )) as typeof fetch
}

function forecastResponse(startTimestamp: string, periods: number, requestCount = 2) {
  return {
    mode: 'synthetic_demo',
    historySource: 'synthetic_hourly_demand.csv',
    historyProvenance: 'Bundled synthetic data; not actual SWERV demand.',
    forecastStartTimestamp: startTimestamp,
    forecastPeriods: periods,
    predictions: Array.from({ length: periods }, (_, index) => ({
      timestamp: new Date(Date.parse(startTimestamp) + index * 60 * 60 * 1_000).toISOString(),
      requestCount,
    })),
    modelVersion: 'gradient_boosting-synthetic-a62c1700d5fb',
    trainingSource: 'synthetic',
    syntheticProvenance: 'Synthetic-only evaluation; real-world accuracy is not validated.',
  }
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
      createElement(AuthContext.Provider, { value: userAuth }, createElement(DemandForecastingPage)),
    ))
  })
  return container
}

async function flushEffects(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
}

function setHorizonValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, value)
  select.dispatchEvent(new browser.Event('input', { bubbles: true }))
  select.dispatchEvent(new browser.Event('change', { bubbles: true }))
}

describe('demand forecasting page', () => {
  it('loads forecasts from the backend and exposes synthetic-only horizon options', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    setFetch((url, init) => {
      if (url.pathname.endsWith('/forecast')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        requestBodies.push(body)
        return response({
          forecast: forecastResponse(
            String(body.forecastStartTimestamp),
            Number(body.forecastPeriods),
          ),
        })
      }
      return response({}, 404)
    })

    const container = await renderPage()
    await flushEffects()

    assert.match(container.textContent ?? '', /Synthetic Demo — not actual SWERV demand/)
    assert.match(container.textContent ?? '', /A demonstration forecast using only generated synthetic hourly data/)
    assert.equal(container.querySelectorAll('.hourly-demand-column').length, 24)
    assert.deepEqual(
      [...container.querySelectorAll('#demand-horizon option')].map((option) => option.textContent),
      ['24 hours', '3 days', '7 days'],
    )
    assert.equal(requestBodies.length, 1)
    assert.deepEqual(Object.keys(requestBodies[0] ?? {}).sort(), ['forecastPeriods', 'forecastStartTimestamp'])
    assert.equal(requestBodies[0]?.forecastPeriods, 24)
    assert.equal(Date.parse(String(requestBodies[0]?.forecastStartTimestamp)) % (60 * 60 * 1_000), 0)
    assert.doesNotMatch(container.textContent ?? '', /Real history|Fleet capacity|Capacity estimate/)

    const horizonSelect = container.querySelector('#demand-horizon')
    assert.ok(horizonSelect instanceof browser.HTMLSelectElement)
    await act(async () => {
      setHorizonValue(horizonSelect, '72')
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    assert.equal(requestBodies.at(-1)?.forecastPeriods, 72)
    assert.equal(container.querySelectorAll('.hourly-demand-column').length, 72)
  })

  it('shows loading and unavailable-service error states', async () => {
    let rejectForecast: ((error: Error) => void) | undefined
    setFetch((url) => {
      if (url.pathname.endsWith('/forecast')) {
        return new Promise<Response>((_resolve, reject) => { rejectForecast = reject })
      }
      return response({})
    })

    const container = await renderPage()
    assert.match(container.textContent ?? '', /Requesting a synthetic demo forecast/)
    await flushEffects()
    rejectForecast?.(new Error('connection unavailable'))
    await flushEffects()

    assert.ok(container.querySelector('[role="alert"]'))
    assert.match(container.textContent ?? '', /Forecast could not be loaded/)
    assert.match(container.textContent ?? '', /Unable to reach SWERV API/)
  })

  it('shows an unavailable ML history error without falling back to operational data', async () => {
    let forecastRequested = false
    setFetch((url) => {
      forecastRequested = true
      return response({}, 503)
    })

    const container = await renderPage()
    await flushEffects()

    assert.match(container.textContent ?? '', /Forecast could not be loaded/)
    assert.match(container.textContent ?? '', /Forecast service unavailable/)
    assert.equal(forecastRequested, true)
  })

  it('shows a zero-demand forecast without fabricating positive demand', async () => {
    setFetch((url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        forecastStartTimestamp: string
        forecastPeriods: number
      }
      return response({
        forecast: forecastResponse(body.forecastStartTimestamp, body.forecastPeriods, 0),
      })
    })

    const container = await renderPage()
    await flushEffects()

    assert.match(container.textContent ?? '', /No positive peak demand was predicted/)
    assert.equal(container.querySelectorAll('.hourly-demand-column').length, 24)
    assert.match(container.querySelector('.demand-summary-card')?.textContent ?? '', /0/)
  })
})

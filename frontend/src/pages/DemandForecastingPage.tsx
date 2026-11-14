import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, AlertTriangle, BarChart3, Menu, RefreshCw, TrendingUp } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import { requestDemandForecast } from '../lib/demandForecast'
import type { DemandForecast, HourlyDemandPrediction } from '../types/demandForecast'
import '../App.css'
import './demand-forecasting.css'

type ForecastHorizon = 24 | 72 | 168

type ForecastPageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; forecast: DemandForecast }

type DailyForecast = { date: string; requestCount: number }

const horizonOptions: { value: ForecastHorizon; label: string }[] = [
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' },
]

const hourFormatter = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  hour: 'numeric',
  timeZone: 'UTC',
})

const dayFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

function aggregateByUtcDay(predictions: HourlyDemandPrediction[]): DailyForecast[] {
  const dailyCounts = new Map<string, number>()
  for (const prediction of predictions) {
    const date = prediction.timestamp.slice(0, 10)
    dailyCounts.set(date, (dailyCounts.get(date) ?? 0) + prediction.requestCount)
  }
  return [...dailyCounts.entries()].map(([date, requestCount]) => ({ date, requestCount }))
}

function formatHour(timestamp: string): string {
  return hourFormatter.format(new Date(timestamp))
}

function formatDay(date: string): string {
  return dayFormatter.format(new Date(`${date}T00:00:00.000Z`))
}

export function DemandForecastingPage() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [horizon, setHorizon] = useState<ForecastHorizon>(24)
  const [pageState, setPageState] = useState<ForecastPageState>({ status: 'loading' })
  const [refreshKey, setRefreshKey] = useState(0)
  const latestRequest = useRef(0)
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const loadForecast = useCallback(async () => {
    const requestNumber = ++latestRequest.current
    setPageState({ status: 'loading' })
    try {
      const forecastStartTimestamp = new Date(
        (Math.floor(Date.now() / (60 * 60 * 1_000)) + 1) * 60 * 60 * 1_000,
      ).toISOString()
      const forecast = await requestDemandForecast({
        forecastStartTimestamp,
        forecastPeriods: horizon,
      })
      if (requestNumber !== latestRequest.current) return
      setPageState({ status: 'success', forecast })
    } catch (error) {
      if (requestNumber !== latestRequest.current) return
      setPageState({
        status: 'error',
        message: error instanceof Error ? error.message : 'The demand forecast could not be loaded.',
      })
    }
  }, [horizon])

  useEffect(() => {
    const loadTimer = window.setTimeout(() => void loadForecast(), 0)
    return () => window.clearTimeout(loadTimer)
  }, [loadForecast, refreshKey])

  async function handleLogout() {
    try {
      await logout()
    } catch {
      // Clear the local session even if the API is unavailable.
    }
    navigate('/login', { replace: true })
  }

  const forecast = pageState.status === 'success' ? pageState.forecast : null
  const dailyForecast = useMemo(
    () => forecast ? aggregateByUtcDay(forecast.predictions) : [],
    [forecast],
  )
  const peakCount = forecast
    ? Math.max(...forecast.predictions.map((prediction) => prediction.requestCount))
    : 0
  const peakHours = forecast
    ? [...forecast.predictions]
      .sort((first, second) => second.requestCount - first.requestCount
        || first.timestamp.localeCompare(second.timestamp))
      .slice(0, 3)
    : []
  const dailyMax = Math.max(...dailyForecast.map((day) => day.requestCount), 0)

  return (
    <div className="app-shell">
      {user && (
        <DashboardSidebar
          user={user}
          activePage="demandForecast"
          menuOpen={menuOpen}
          onMenuClose={() => setMenuOpen(false)}
          onLogout={() => void handleLogout()}
        />
      )}
      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-toggle" type="button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            <span>Workspace</span><span className="crumb-slash">/</span><strong>Demand forecasting</strong>
          </div>
          <div className="topbar-actions">
            <div className="environment-pill"><i /> Synthetic demo</div>
            <div className="top-avatar">{user?.name.trim().charAt(0).toUpperCase()}</div>
          </div>
        </header>

        <div className="content-wrap demand-content">
          <section className="welcome-row">
            <div>
              <div className="eyebrow">ADMIN WORKSPACE <span className="eyebrow-dot" /> AI FORECASTING</div>
              <h1>Demand Forecasting</h1>
              <p className="page-subtitle">A demonstration forecast using only generated synthetic hourly data.</p>
            </div>
            <button
              className="dashboard-refresh"
              type="button"
              disabled={pageState.status === 'loading'}
              onClick={() => setRefreshKey((key) => key + 1)}
            >
              <RefreshCw size={14} className={pageState.status === 'loading' ? 'refresh-spinning' : ''} />
              {pageState.status === 'loading' ? 'Refreshing' : 'Refresh forecast'}
            </button>
          </section>

          <section className="demand-warning" role="note">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <strong>Synthetic Demo — not actual SWERV demand</strong>
              <p>Both the input history and forecast use generated data. This model has not been validated on real business or operational records and must not be used for operational decisions.</p>
            </div>
          </section>

          <section className="demand-controls panel" aria-label="Forecast horizon">
            <div>
              <label htmlFor="demand-horizon">Forecast horizon</label>
              <p>Predictions are grouped by UTC hour.</p>
            </div>
            <select
              id="demand-horizon"
              value={horizon}
              onChange={(event) => setHorizon(Number(event.target.value) as ForecastHorizon)}
            >
              {horizonOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </section>

          {pageState.status === 'loading' && (
            <section className="demand-state panel" role="status">
              <span className="spinner spinner-small" />
              <strong>Requesting a synthetic demo forecast…</strong>
              <p>The ML service validates and loads the bundled synthetic history.</p>
            </section>
          )}

          {pageState.status === 'error' && (
            <section className="demand-state demand-error panel" role="alert">
              <div>
                <h2>Forecast could not be loaded</h2>
                <p>{pageState.message}</p>
              </div>
              <button type="button" className="demand-secondary-button" onClick={() => setRefreshKey((key) => key + 1)}>
                Try again
              </button>
            </section>
          )}

          {forecast && (
            <>
              <section className="demand-summary-grid" aria-label="Forecast summary">
                <article className="panel demand-summary-card">
                  <span>Peak hourly demand</span>
                  <strong>{peakCount.toLocaleString()}</strong>
                  <small>Illustrative synthetic requests in one UTC hour</small>
                </article>
                <article className="panel demand-summary-card">
                  <span>Model version</span>
                  <strong className="demand-model-version">{forecast.modelVersion}</strong>
                  <small>Training source: {forecast.trainingSource}</small>
                </article>
              </section>

              <section className="panel demand-chart-panel">
                <div className="panel-heading">
                  <div><h2><BarChart3 size={16} /> Hourly predicted requests</h2><p>Forecast starts {new Date(forecast.forecastStartTimestamp).toLocaleString('en', { timeZone: 'UTC', timeZoneName: 'short' })}</p></div>
                  <span>{forecast.forecastPeriods} hours</span>
                </div>
                <div className="hourly-demand-chart" role="img" aria-label={`Predicted request counts for ${forecast.predictions.length} UTC hours`}>
                  {forecast.predictions.map((prediction, index) => {
                    const isPeak = prediction.requestCount === peakCount && peakCount > 0
                    const labelInterval = Math.max(1, Math.ceil(forecast.predictions.length / 12))
                    const barHeight = peakCount ? (prediction.requestCount / peakCount) * 100 : 0
                    return (
                      <div className="hourly-demand-column" key={prediction.timestamp} title={`${formatHour(prediction.timestamp)} UTC · ${prediction.requestCount} requests`}>
                        <strong>{prediction.requestCount}</strong>
                        <div className="hourly-demand-bar-track">
                          <span className={isPeak ? 'hourly-demand-bar peak' : 'hourly-demand-bar'} style={{ height: `${barHeight}%` }} />
                        </div>
                        <small>{index % labelInterval === 0 ? formatHour(prediction.timestamp) : ''}</small>
                      </div>
                    )
                  })}
                </div>
                {peakCount === 0 && <p className="demand-chart-note">No positive peak demand was predicted for these hours.</p>}
              </section>

              <section className="demand-lower-grid">
                <article className="panel demand-chart-panel daily-demand-panel">
                  <div className="panel-heading">
                    <div><h2><Activity size={16} /> Daily aggregated forecast</h2><p>Hourly predictions summed by UTC calendar day</p></div>
                  </div>
                  <div className="daily-demand-chart" role="img" aria-label={`Daily forecast totals for ${dailyForecast.length} UTC days`}>
                    {dailyForecast.map((day) => {
                      const height = dailyMax ? (day.requestCount / dailyMax) * 100 : 0
                      return (
                        <div className="daily-demand-column" key={day.date}>
                          <strong>{day.requestCount}</strong>
                          <div className="daily-demand-bar-track"><span className="daily-demand-bar" style={{ height: `${height}%` }} /></div>
                          <small>{formatDay(day.date)}</small>
                        </div>
                      )
                    })}
                  </div>
                </article>

                <article className="panel peak-hours-panel">
                  <div className="panel-heading">
                    <div><h2><TrendingUp size={16} /> Peak-demand hours</h2><p>Highest predicted hourly counts</p></div>
                  </div>
                  {peakCount === 0 ? (
                    <p className="demand-chart-note">There are no positive peak hours in this forecast.</p>
                  ) : (
                    <ol>
                      {peakHours.map((item) => (
                        <li key={item.timestamp}><span>{formatHour(item.timestamp)} UTC</span><strong>{item.requestCount} requests</strong></li>
                      ))}
                    </ol>
                  )}
                </article>
              </section>

              <p className="demand-provenance">History source: {forecast.historySource}. {forecast.historyProvenance} Model: {forecast.syntheticProvenance}</p>
            </>
          )}

          <footer className="page-footer"><span>SWERV</span><span>Demand Forecasting · UTC hourly buckets · Synthetic prototype</span></footer>
        </div>
      </main>
    </div>
  )
}

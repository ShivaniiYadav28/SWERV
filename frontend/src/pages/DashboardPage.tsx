import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Menu,
  PackageCheck,
  RefreshCw,
  Truck,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import { getDispatchAnalytics } from '../lib/dispatchAnalytics'
import type { DispatchAnalytics } from '../types/dispatchAnalytics'
import type { DispatchRequestStatus } from '../types/dispatchRequest'
import '../App.css'
import { connectRealtime, dispatchUpdateEvent } from '../lib/realtime'

const dateLabel = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})
  .format(new Date())
  .toUpperCase()

const statusRows: { status: DispatchRequestStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'assigned', label: 'Assigned' },
  { status: 'picked_up', label: 'Picked up' },
  { status: 'in_transit', label: 'In transit' },
  { status: 'delivered', label: 'Delivered' },
  { status: 'failed', label: 'Failed' },
  { status: 'cancelled', label: 'Cancelled' },
]

const priorityRows = [
  { priority: 'standard' as const, label: 'Standard' },
  { priority: 'express' as const, label: 'Express' },
  { priority: 'urgent' as const, label: 'Urgent' },
]

function formatTrendDate(date: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`))
}

export function DashboardPage() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [analytics, setAnalytics] = useState<DispatchAnalytics | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const firstName = user?.name.trim().split(/\s+/)[0] ?? 'there'
  const initials = user?.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()

  const loadDashboardAnalytics = useCallback(async () => {
    setIsLoading(true)
    setLoadError('')
    try {
      setAnalytics(await getDispatchAnalytics())
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Dispatch analytics could not be loaded.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    const request = window.setTimeout(() => void loadDashboardAnalytics(), 0)
    return () => window.clearTimeout(request)
  }, [loadDashboardAnalytics, refreshKey])

  useEffect(() => {
    const socket = connectRealtime()
    const onDispatchUpdate = () => setRefreshKey((current) => current + 1)
    socket.on(dispatchUpdateEvent, onDispatchUpdate)
    return () => {
      socket.off(dispatchUpdateEvent, onDispatchUpdate)
      socket.disconnect()
    }
  }, [])

  async function handleLogout() {
    try {
      await logout()
    } catch {
      // The local session is cleared even if the API cannot be reached.
    }
    navigate('/login', { replace: true })
  }

  const metrics = analytics
    ? [
        { label: 'Total requests', value: analytics.counts.total, icon: Activity },
        { label: 'Pending requests', value: analytics.counts.pending, icon: Clock3 },
        { label: 'Assigned requests', value: analytics.counts.assigned, icon: Truck },
        { label: 'Active deliveries', value: analytics.counts.activeDeliveries, icon: PackageCheck },
        { label: 'Delivered requests', value: analytics.counts.delivered, icon: CheckCircle2 },
        { label: 'Failed requests', value: analytics.counts.failed, icon: AlertCircle },
        { label: 'Cancelled requests', value: analytics.counts.cancelled, icon: AlertCircle },
      ]
    : []
  const isEmpty = analytics?.counts.total === 0
  const maxDailyDeliveries = Math.max(...(analytics?.deliveryTrend.daily.map((day) => day.delivered) ?? [0]))

  return (
    <div className="app-shell">
      {user && (
        <DashboardSidebar
          user={user}
          activePage="dashboard"
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
            <span>Workspace</span><span className="crumb-slash">/</span><strong>Overview</strong>
          </div>
          <div className="topbar-actions">
            <div className="environment-pill"><i /> Live operations</div>
            <div className="top-avatar">{initials}</div>
          </div>
        </header>

        <div className="content-wrap">
          <section className="welcome-row">
            <div>
              <div className="eyebrow">{dateLabel} <span className="eyebrow-dot" /> OPERATIONS</div>
              <h1>Good morning, {firstName}</h1>
              <p className="page-subtitle">Dispatch activity and delivery performance at a glance.</p>
            </div>
            <button className="dashboard-refresh" type="button" disabled={isLoading} onClick={() => setRefreshKey((key) => key + 1)}>
              <RefreshCw size={14} className={isLoading ? 'refresh-spinning' : ''} />
              {isLoading ? 'Refreshing' : 'Refresh'}
            </button>
          </section>

          {loadError && (
            <div className="dashboard-error" role="alert">
              <span>{loadError}</span>
              <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Try again</button>
            </div>
          )}

          {!loadError && isEmpty && (
            <div className="dashboard-empty" role="status">
              <Activity size={17} />
              <span>No dispatch requests yet. Analytics will update when requests are recorded.</span>
            </div>
          )}

          <section className="metric-grid" aria-label="Dispatch request metrics">
            {metrics.map(({ label, value, icon: Icon }, index) => (
              <article className="metric-card" key={label}>
                <div className="metric-top">
                  <span>{label}</span>
                  <span className={`metric-icon metric-icon-${index % 4}`}><Icon size={17} /></span>
                </div>
                <div className="metric-value">{isLoading && !analytics ? '—' : value.toLocaleString()}</div>
                <div className="metric-foot"><span>All dispatch requests</span></div>
              </article>
            ))}
            {isLoading && !analytics && Array.from({ length: 7 }, (_, index) => (
              <article className="metric-card metric-card-loading" key={`loading-${index}`} aria-hidden="true">
                <span /><span />
              </article>
            ))}
          </section>

          {analytics && (
            <section className="analytics-grid" aria-label="Dispatch analytics charts">
              <article className="panel analytics-panel">
                <div className="panel-heading"><div><h2>Priority distribution</h2><p>{analytics.counts.total.toLocaleString()} requests by priority</p></div><BarChart3 size={17} /></div>
                <div className="distribution-list">
                  {priorityRows.map(({ priority, label }) => {
                    const value = analytics.priorityDistribution[priority]
                    const percentage = analytics.counts.total ? (value / analytics.counts.total) * 100 : 0
                    return <div className="distribution-row" key={priority}><div className="distribution-label"><span>{label}</span><strong>{value.toLocaleString()}</strong></div><div className="distribution-track"><span className={`distribution-fill priority-fill-${priority}`} style={{ width: `${percentage}%` }} /></div></div>
                  })}
                </div>
              </article>

              <article className="panel analytics-panel status-distribution-panel">
                <div className="panel-heading"><div><h2>Delivery status distribution</h2><p>Requests by current status</p></div><BarChart3 size={17} /></div>
                <div className="distribution-list status-distribution-list">
                  {statusRows.map(({ status, label }) => {
                    const value = analytics.counts[status]
                    const percentage = analytics.counts.total ? (value / analytics.counts.total) * 100 : 0
                    return <div className="distribution-row" key={status}><div className="distribution-label"><span>{label}</span><strong>{value.toLocaleString()}</strong></div><div className="distribution-track"><span className={`distribution-fill status-fill-${status}`} style={{ width: `${percentage}%` }} /></div></div>
                  })}
                </div>
              </article>

              <article className="panel analytics-panel trend-panel">
                <div className="panel-heading"><div><h2>Daily deliveries</h2><p>Completed delivery status transitions · UTC · {analytics.deliveryTrend.startDate} — {analytics.deliveryTrend.endDate}</p></div><Activity size={17} /></div>
                <div className="trend-chart" role="img" aria-label="Daily completed deliveries over the last seven UTC dates">
                  {analytics.deliveryTrend.daily.map((day) => {
                    const barHeight = maxDailyDeliveries ? Math.max((day.delivered / maxDailyDeliveries) * 100, day.delivered ? 8 : 0) : 0
                    return <div className="trend-day" key={day.date}><strong>{day.delivered}</strong><div className="trend-bar-area"><span className="trend-bar" style={{ height: `${barHeight}%` }} /></div><small>{formatTrendDate(day.date)}</small></div>
                  })}
                </div>
              </article>
            </section>
          )}

          <footer className="page-footer"><span>SWERV</span><span>Dispatch analytics · All times UTC where date ranges apply</span></footer>
        </div>
      </main>
    </div>
  )
}

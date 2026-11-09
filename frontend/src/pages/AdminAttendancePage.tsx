import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { CalendarDays, CheckCircle2, Clock3, LogIn, LogOut, Menu, RefreshCw, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import { getAgents } from '../lib/agents'
import { getAdminAgentAttendance, type AttendanceFilters } from '../lib/agentAttendance'
import type { AdminAgentAttendancePage as AttendancePageData } from '../types/agentAttendance'
import type { Agent } from '../types/agent'
import '../App.css'
import './agent-attendance.css'

const defaultFilters: AttendanceFilters = { page: 1, limit: 20, search: '' }

async function getAllAgents(isActive: boolean): Promise<Agent[]> {
  const filters = { page: 1, limit: 100, search: '', status: '', vehicleType: '', capability: '', isActive }
  const firstPage = await getAgents(filters)
  const agents = [...firstPage.agents]

  for (let page = 2; page <= firstPage.pagination.pages; page += 1) {
    const result = await getAgents({ ...filters, page })
    agents.push(...result.agents)
  }

  return agents
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(`${value}T00:00:00Z`))
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(value))
}

function formatDuration(minutes: number): string {
  const totalMinutes = Math.floor(minutes)
  const hours = Math.floor(totalMinutes / 60)
  const remainingMinutes = totalMinutes % 60
  return hours ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`
}

export function AdminAttendancePage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [filters, setFilters] = useState<AttendanceFilters>(defaultFilters)
  const [appliedFilters, setAppliedFilters] = useState<AttendanceFilters>(defaultFilters)
  const [attendance, setAttendance] = useState<AttendancePageData | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [agentLoadError, setAgentLoadError] = useState('')
  const [error, setError] = useState('')

  const loadAttendance = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      setAttendance(await getAdminAgentAttendance(appliedFilters))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Attendance records could not be loaded.')
    } finally {
      setIsLoading(false)
    }
  }, [appliedFilters])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAttendance(), 0)
    return () => window.clearTimeout(timer)
  }, [loadAttendance])

  useEffect(() => {
    let active = true
    void Promise.all([
      getAllAgents(true),
      getAllAgents(false),
    ]).then(([activeAgents, archivedAgents]) => {
      if (active) setAgents([...activeAgents, ...archivedAgents])
    }).catch((cause: unknown) => {
      if (active) setAgentLoadError(cause instanceof Error ? cause.message : 'Agent list could not be loaded.')
    })
    return () => { active = false }
  }, [])

  async function handleLogout() {
    try { await logout() } catch { /* The local session still clears if the API is offline. */ }
    navigate('/login', { replace: true })
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAppliedFilters({ ...filters, page: 1 })
    setFilters((current) => ({ ...current, page: 1 }))
  }

  function resetFilters() {
    setFilters(defaultFilters)
    setAppliedFilters(defaultFilters)
  }

  function changePage(page: number) {
    setFilters((current) => ({ ...current, page }))
    setAppliedFilters((current) => ({ ...current, page }))
  }

  const summary = attendance?.summary
  const pagination = attendance?.pagination

  return <div className="app-shell">
    {user && <DashboardSidebar user={user} activePage="attendance" menuOpen={menuOpen} onMenuClose={() => setMenuOpen(false)} onLogout={() => void handleLogout()} />}
    <main className="main-area">
      <header className="topbar"><button className="icon-button menu-toggle" type="button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>Fleet operations</span><span className="crumb-slash">/</span><strong>Attendance</strong></div><button className="quiet-button" type="button" onClick={() => void loadAttendance()} disabled={isLoading}><RefreshCw size={15} />Refresh</button></header>
      <div className="attendance-admin-page">
        <section className="attendance-admin-heading"><div><span className="attendance-admin-eyebrow">AGENT RECORDS</span><h1>Attendance management</h1><p>Review recorded check-ins and check-outs. Missing records are not treated as absences.</p></div><span className="attendance-admin-count"><CalendarDays size={15} />Asia/Kolkata</span></section>

        <section className="attendance-summary-grid" aria-label="Attendance summary">
          <article><span className="attendance-summary-icon coral"><CalendarDays size={18} /></span><div><small>Total records</small><strong>{isLoading ? '—' : summary?.totalRecords ?? 0}</strong><span>In selected period</span></div></article>
          <article><span className="attendance-summary-icon green"><CheckCircle2 size={18} /></span><div><small>Checked out</small><strong>{isLoading ? '—' : summary?.completedCheckouts ?? 0}</strong><span>Completed records</span></div></article>
          <article><span className="attendance-summary-icon amber"><Clock3 size={18} /></span><div><small>Currently open</small><strong>{isLoading ? '—' : summary?.openRecords ?? 0}</strong><span>Awaiting check-out</span></div></article>
          <article><span className="attendance-summary-icon slate"><Users size={18} /></span><div><small>Recorded duration</small><strong>{isLoading ? '—' : formatDuration(summary?.totalDurationMinutes ?? 0)}</strong><span>Completed records only</span></div></article>
        </section>

        <form className="attendance-filter-bar" onSubmit={applyFilters}>
          <label>Start date<input type="date" value={filters.startDate ?? ''} onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value || undefined }))} /></label>
          <label>End date<input type="date" value={filters.endDate ?? ''} onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value || undefined }))} /></label>
          <label>Agent<select value={filters.agentId ?? ''} onChange={(event) => setFilters((current) => ({ ...current, agentId: event.target.value || undefined }))}>
            <option value="">All agents</option>{agents.map((agent) => <option key={agent._id} value={agent._id}>{agent.name} · {agent.agentCode}</option>)}
          </select></label>
          <label className="attendance-search-label">Search agent<input type="search" value={filters.search ?? ''} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Name or email" /></label>
          <div className="attendance-filter-actions"><button type="submit" className="attendance-filter-apply" disabled={isLoading}>Apply filters</button><button type="button" className="attendance-filter-reset" onClick={resetFilters} disabled={isLoading}>Reset</button></div>
        </form>

        {agentLoadError && <p className="attendance-admin-note" role="status">{agentLoadError} You can still search by agent name or email.</p>}
        {error && <div className="attendance-admin-error" role="alert">{error}<button type="button" onClick={() => void loadAttendance()}>Try again</button></div>}

        <section className="attendance-admin-table-section" aria-label="Attendance records">
          <div className="attendance-admin-table-heading"><div><h2>Attendance records</h2><p>{pagination?.total ?? 0} matching records</p></div></div>
          {isLoading ? <div className="attendance-admin-state" role="status">Loading attendance records…</div> : error ? <div className="attendance-admin-state">Attendance records are unavailable right now.</div> : attendance?.records.length ? <>
            <div className="attendance-table-wrap"><table className="attendance-table"><thead><tr><th>Agent</th><th>Date</th><th>Check-in</th><th>Check-out</th><th>Duration</th><th>Status</th></tr></thead><tbody>
              {attendance.records.map((record) => <tr key={record._id}><td><strong>{record.agent?.name ?? 'Agent unavailable'}</strong><small>{record.agent?.email ?? record.agentId}</small></td><td>{formatDate(record.attendanceDate)}</td><td><span className="attendance-event-time is-check-in"><LogIn size={14} /><strong>{formatTime(record.checkInAt)}</strong></span></td><td><span className="attendance-event-time is-check-out"><LogOut size={14} /><strong>{formatTime(record.checkOutAt)}</strong></span></td><td>{record.durationMinutes === null ? '—' : formatDuration(record.durationMinutes)}</td><td><span className={`attendance-status-pill ${record.status === 'checked_out' ? 'is-complete' : 'is-open'}`}>{record.status === 'checked_out' ? 'Completed' : 'In Progress'}</span></td></tr>)}
            </tbody></table></div>
            <div className="attendance-pagination"><span>Page {pagination?.page ?? 1} of {Math.max(1, pagination?.pages ?? 0)}</span><div><button type="button" onClick={() => changePage(Math.max(1, (pagination?.page ?? 1) - 1))} disabled={(pagination?.page ?? 1) <= 1 || isLoading}>Previous</button><button type="button" onClick={() => changePage(Math.min(pagination?.pages ?? 1, (pagination?.page ?? 1) + 1))} disabled={(pagination?.page ?? 1) >= (pagination?.pages ?? 0) || isLoading}>Next</button></div></div>
          </> : <div className="attendance-admin-state"><CalendarDays size={24} /><strong>No attendance records found</strong><span>Try another date range or agent filter.</span></div>}
        </section>
      </div>
    </main>
  </div>
}

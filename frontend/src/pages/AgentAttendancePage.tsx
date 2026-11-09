import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, CheckCircle2, Clock3, LogIn, LogOut, RefreshCw } from 'lucide-react'
import { useAgentAuth } from '../hooks/useAgentAuth'
import { ApiError } from '../lib/api'
import { checkIn, checkOut, getMyAttendance } from '../lib/agentAttendance'
import type { AgentAttendancePage as AttendancePageData, AgentAttendanceRecord } from '../types/agentAttendance'
import './agent-portal.css'
import './agent-attendance.css'

const pageLimit = 10
const businessTimeZone = 'Asia/Kolkata'

function todayInIndia(): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: businessTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: businessTimeZone }).format(new Date(`${value}T00:00:00+05:30`))
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: businessTimeZone }).format(new Date(value))
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return '—'
  const totalMinutes = Math.floor(minutes)
  const hours = Math.floor(totalMinutes / 60)
  const remainingMinutes = totalMinutes % 60
  return hours ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`
}

export function AgentAttendancePage() {
  const { agent, clearAgent } = useAgentAuth()
  const [attendance, setAttendance] = useState<AttendancePageData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<'check-in' | 'check-out' | ''>('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [page, setPage] = useState(1)

  const loadAttendance = useCallback(async (showLoading = true) => {
    if (showLoading) setIsLoading(true)
    setError('')
    try {
      setAttendance(await getMyAttendance({ page, limit: pageLimit }))
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) clearAgent()
      setError(cause instanceof Error ? cause.message : 'Attendance could not be loaded.')
    } finally {
      if (showLoading) setIsLoading(false)
    }
  }, [clearAgent, page])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAttendance(), 0)
    return () => window.clearTimeout(timer)
  }, [loadAttendance])

  const todayRecord = attendance?.todayAttendance ?? null

  async function submitAttendance(action: 'check-in' | 'check-out') {
    if (busyAction) return
    setBusyAction(action)
    setError('')
    setSuccess('')
    try {
      const updatedRecord: AgentAttendanceRecord = action === 'check-in' ? await checkIn() : await checkOut()
      setSuccess(action === 'check-in' ? 'You are checked in for today.' : 'Your attendance was checked out successfully.')
      setAttendance((current) => current ? {
        ...current,
        records: [updatedRecord, ...current.records.filter((record) => record._id !== updatedRecord._id)],
      } : current)
      await loadAttendance(false)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) clearAgent()
      setError(cause instanceof Error ? cause.message : 'Attendance could not be updated.')
    } finally {
      setBusyAction('')
    }
  }

  const pageCount = attendance?.pagination.pages ?? 0
  const attendanceDate = todayRecord?.attendanceDate ?? todayInIndia()
  const isPreviousAttendance = Boolean(todayRecord && attendanceDate !== todayInIndia())
  const attendanceStatus = todayRecord?.checkOutAt
    ? 'Completed'
    : todayRecord
      ? 'In Progress'
      : 'Not checked in'

  return <div className="agent-attendance-page">
    <section className="agent-page-heading">
      <div><div className="agent-eyebrow"><span />DAILY CHECK-IN</div><h1>Attendance</h1><p>Record the start and end of your workday.</p></div>
      <button className="agent-refresh-button" type="button" onClick={() => void loadAttendance()} disabled={isLoading}><RefreshCw size={16} className={isLoading ? 'agent-refreshing' : ''} /><span>Refresh</span></button>
    </section>

    {error && <div className="agent-alert" role="alert"><span>{error}</span><button type="button" onClick={() => void loadAttendance()}>Try again</button></div>}
    {success && <div className="attendance-success" role="status"><CheckCircle2 size={16} />{success}</div>}

    <section className="attendance-today-card" aria-labelledby="attendance-today-title">
      <div className="attendance-today-heading">
        <span className="attendance-icon"><CalendarDays size={19} /></span>
        <div><span className="agent-eyebrow">{isPreviousAttendance ? 'OPEN ATTENDANCE · IST' : 'TODAY · IST'}</span><h2 id="attendance-today-title">{formatDate(attendanceDate)}</h2><p>{agent?.name}</p></div>
        <span className={`attendance-status-pill ${todayRecord ? todayRecord.checkOutAt ? 'is-complete' : 'is-open' : 'is-not-started'}`}>
          {attendanceStatus}
        </span>
      </div>
      {isLoading && !attendance ? <div className="attendance-inline-state" role="status">Loading today’s attendance…</div> : <>
        <div className="attendance-event-grid">
          <div className="attendance-event-card is-check-in">
            <span className="attendance-event-icon"><LogIn size={17} /></span>
            <div><small>CHECK-IN</small><strong>{todayRecord ? formatTime(todayRecord.checkInAt) : '—'}</strong></div>
          </div>
          <div className="attendance-event-card is-check-out">
            <span className="attendance-event-icon"><LogOut size={17} /></span>
            <div><small>CHECK-OUT</small><strong>{formatTime(todayRecord?.checkOutAt ?? null)}</strong></div>
          </div>
        </div>
        <div className="attendance-duration-row">
          <span><Clock3 size={15} />Recorded duration</span>
          <strong>{todayRecord ? formatDuration(todayRecord.durationMinutes) : '—'}</strong>
          {todayRecord && <span className={`attendance-status-pill ${todayRecord.checkOutAt ? 'is-complete' : 'is-open'}`}>{attendanceStatus}</span>}
        </div>
        <div className="attendance-actions">
          {attendance && !todayRecord && <button className="agent-primary-button" type="button" onClick={() => void submitAttendance('check-in')} disabled={Boolean(busyAction) || isLoading}><LogIn size={16} />{busyAction === 'check-in' ? 'Checking in…' : 'Check in'}</button>}
          {todayRecord && !todayRecord.checkOutAt && <button className="agent-primary-button" type="button" onClick={() => void submitAttendance('check-out')} disabled={Boolean(busyAction) || isLoading}><LogOut size={16} />{busyAction === 'check-out' ? 'Checking out…' : 'Check out'}</button>}
          {todayRecord?.checkOutAt && <span className="attendance-complete-note"><CheckCircle2 size={15} />Attendance recorded for today</span>}
        </div>
      </>}
    </section>

    <section className="attendance-history-section" aria-labelledby="attendance-history-title">
      <div className="attendance-section-heading"><div><div className="agent-eyebrow"><span />YOUR RECORDS</div><h2 id="attendance-history-title">Attendance history</h2><p>Your recorded check-ins and check-outs.</p></div><span className="agent-count-pill"><Clock3 size={14} />{attendance?.summary.totalRecords ?? 0} records</span></div>
      {isLoading && !attendance ? <div className="agent-state-card" role="status">Loading attendance history…</div> : error && !attendance ? <div className="agent-state-card">Attendance history is unavailable right now.</div> : attendance?.records.length ? <>
        <div className="attendance-table-wrap"><table className="attendance-table"><thead><tr><th>Date</th><th>Check-in</th><th>Check-out</th><th>Duration</th><th>Status</th></tr></thead><tbody>
          {attendance.records.map((record) => <tr key={record._id}><td>{formatDate(record.attendanceDate)}</td><td><span className="attendance-event-time is-check-in"><LogIn size={14} /><strong>{formatTime(record.checkInAt)}</strong></span></td><td><span className="attendance-event-time is-check-out"><LogOut size={14} /><strong>{formatTime(record.checkOutAt)}</strong></span></td><td>{formatDuration(record.durationMinutes)}</td><td><span className={`attendance-status-pill ${record.checkOutAt ? 'is-complete' : 'is-open'}`}>{record.checkOutAt ? 'Completed' : 'In Progress'}</span></td></tr>)}
        </tbody></table></div>
        <div className="attendance-pagination"><span>Page {page} of {pageCount}</span><div><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || isLoading}>Previous</button><button type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount || isLoading}>Next</button></div></div>
      </> : <div className="agent-empty-card"><span><CalendarDays size={20} /></span><strong>No attendance records yet</strong><p>Check in when you start your workday to see your history here.</p></div>}
    </section>
  </div>
}

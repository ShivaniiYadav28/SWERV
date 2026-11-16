import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, BarChart3, ChevronLeft, ChevronRight, Menu, RefreshCw, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import { getAnomalyAlert, getAnomalyAlerts, getAnomalySummary, reviewAnomalyAlert, runAnomalyDetection, saveAnomalyAlertNote } from '../lib/anomalyDetection'
import type { AnomalyAlert, AnomalySummary, DetectionMode, DetectionResult, ReviewStatus, ScenarioEvidence, Severity } from '../types/anomalyDetection'
import '../App.css'
import './anomaly-detection.css'

const ruleAnomalyTypes = [
  'gps_missing_coordinates', 'gps_invalid_coordinates', 'gps_invalid_timestamp', 'gps_invalid_timestamp_order',
  'gps_stale_submission', 'gps_stale_update', 'gps_implausible_jump', 'repeated_dispatch_reassignment', 'unusual_delivery_duration', 'invalid_status_transition',
]

function readable(value: string) {
  if (value === 'unsupervised_outlier') return value
  return value.replaceAll('_', ' ')
}

function safeDisplayText(value: string): string {
  return value.replace(/synthetic_demo/gi, 'demo').replace(/synthetic/gi, 'generated')
}

function safeValue(value: unknown) {
  if (value === null || value === undefined) return 'Not available'
  return safeDisplayText(typeof value === 'object' ? JSON.stringify(value) : String(value))
}

function safeUserError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback
  return safeDisplayText(message)
}

function scenarioEvidence(alert: AnomalyAlert): ScenarioEvidence | null {
  return alert.evidence && typeof alert.evidence === 'object' && !Array.isArray(alert.evidence)
    ? alert.evidence as ScenarioEvidence
    : null
}

function scenarioCategory(alert: AnomalyAlert): string | null {
  const value = scenarioEvidence(alert)?.scenarioCategory
  return typeof value === 'string' && value.trim() ? value : null
}

function scenarioIdentifier(alert: AnomalyAlert): string | null {
  const value = scenarioEvidence(alert)?.scenarioId
  return typeof value === 'string' && value.trim() ? value : null
}

function findingTimestamp(alert: AnomalyAlert, mode: DetectionMode): string | null {
  const contextTimestamp = mode === 'synthetic_demo' ? scenarioEvidence(alert)?.scenarioTimestamp : null
  const value = typeof contextTimestamp === 'string' ? contextTimestamp : alert.evidenceTimestamp
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : alert.createdAt
}

function scoreValue(alert: AnomalyAlert): number | null {
  return typeof alert.measuredValue === 'number' && Number.isFinite(alert.measuredValue)
    ? alert.measuredValue
    : null
}

export function AnomalyDetectionPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<DetectionMode>('real')
  const [summary, setSummary] = useState<AnomalySummary | null>(null)
  const [alerts, setAlerts] = useState<AnomalyAlert[]>([])
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  const [severity, setSeverity] = useState<Severity | ''>('')
  const [anomalyType, setAnomalyType] = useState('')
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus | ''>('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [lastDetection, setLastDetection] = useState<DetectionResult | null>(null)
  const [selected, setSelected] = useState<AnomalyAlert | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [reviewNotes, setReviewNotes] = useState('')
  const [savingReview, setSavingReview] = useState(false)
  const [savingNote, setSavingNote] = useState(false)
  const latestRequest = useRef(0)

  const loadPage = useCallback(async () => {
    const requestNumber = ++latestRequest.current
    setLoading(true)
    setError('')
    try {
      const requestLimit = mode === 'synthetic_demo' ? 100 : 10
      const [nextSummary, nextAlerts] = await Promise.all([
        getAnomalySummary(mode),
        getAnomalyAlerts({
          mode,
          page,
          limit: requestLimit,
          severity: severity || undefined,
          anomalyType: mode === 'real' ? anomalyType || undefined : undefined,
          reviewStatus: reviewStatus || undefined,
        }),
      ])
      if (requestNumber === latestRequest.current) {
        setSummary(nextSummary)
        setAlerts(nextAlerts.alerts)
        setTotalPages(mode === 'synthetic_demo' ? 1 : Math.max(1, nextAlerts.pagination.pages))
      }
    } catch (loadError) {
      if (requestNumber === latestRequest.current) {
        setError(safeUserError(loadError, 'Anomaly history could not be loaded.'))
        setSummary(null)
        setAlerts([])
      }
    } finally {
      if (requestNumber === latestRequest.current) setLoading(false)
    }
  }, [mode, page, severity, anomalyType, reviewStatus])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPage(), 0)
    return () => window.clearTimeout(timer)
  }, [loadPage])

  async function handleLogout() {
    try { await logout() } catch { /* The session is cleared locally if the API is offline. */ }
    navigate('/login', { replace: true })
  }

  async function handleRunDetection() {
    setRunning(true)
    setError('')
    setSuccess('')
    try {
      const result = await runAnomalyDetection(mode)
      setLastDetection(result)
      setSuccess(mode === 'real'
        ? `Rule checks complete: ${result.candidateCount} findings; ${result.savedAlerts} new alerts and ${result.duplicateAlertsSkipped} already recorded.`
        : `Demo analysis complete: ${result.candidateCount} model candidates; ${result.savedAlerts} new alerts and ${result.duplicateAlertsSkipped} already recorded.`)
      await loadPage()
    } catch (runError) {
      setError(safeUserError(runError, 'Anomaly detection could not be completed.'))
    } finally { setRunning(false) }
  }

  async function openDetails(alert: AnomalyAlert) {
    setSelected(null)
    setDetailLoading(true)
    setReviewNotes(alert.reviewNotes)
    try { setSelected(await getAnomalyAlert(alert._id, mode)) }
    catch (detailError) { setError(safeUserError(detailError, 'Alert details could not be loaded.')) }
    finally { setDetailLoading(false) }
  }

  async function saveReview(reviewStatusNext: Exclude<ReviewStatus, 'new'>) {
    if (!selected) return
    if ((reviewStatusNext === 'resolved' || reviewStatusNext === 'dismissed') && !window.confirm(`Mark this alert as ${readable(reviewStatusNext)}?`)) return
    setSavingReview(true)
    setError('')
    setSuccess('')
    try {
      const updatedAlert = await reviewAnomalyAlert(selected._id, mode, reviewStatusNext, reviewNotes.trim() || undefined)
      setSelected(updatedAlert)
      setSuccess('Alert review was saved.')
      await loadPage()
    } catch (saveError) {
      setError(safeUserError(saveError, 'Alert review could not be saved.'))
    } finally { setSavingReview(false) }
  }

  async function saveReviewNote() {
    if (!selected) return
    const note = reviewNotes.trim()
    if (!note) {
      setError('Enter a review note before saving.')
      setSuccess('')
      return
    }
    setSavingNote(true)
    setError('')
    setSuccess('')
    try {
      const updatedAlert = await saveAnomalyAlertNote(selected._id, mode, note)
      setSelected(updatedAlert)
      setReviewNotes(updatedAlert.reviewNotes)
      setSuccess('Review note saved.')
    } catch (saveError) {
      setError(safeUserError(saveError, 'Review note could not be saved.'))
    } finally { setSavingNote(false) }
  }

  const modeLabel = mode === 'real' ? 'Real Data Mode' : 'Anomaly Detection Demo'
  const visibleAlerts = mode === 'synthetic_demo' && anomalyType
    ? alerts.filter((alert) => scenarioCategory(alert) === anomalyType)
    : alerts
  const severityDistribution = ['critical', 'high', 'medium', 'low'].map((level) => ({
    label: level,
    count: visibleAlerts.filter((alert) => alert.severity === level).length,
  }))
  const categoryCounts = new Map<string, number>()
  for (const alert of visibleAlerts) {
    const category = mode === 'synthetic_demo' ? scenarioCategory(alert) : alert.anomalyType
    if (category) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
  }
  const categoryDistribution = [...categoryCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((first, second) => second.count - first.count || first.category.localeCompare(second.category))
  const maxSeverityCount = Math.max(1, ...severityDistribution.map((item) => item.count))
  const maxCategoryCount = Math.max(1, ...categoryDistribution.map((item) => item.count))
  const demoCategories = [...new Set(alerts.map(scenarioCategory).filter((value): value is string => value !== null))]
  const categoryOptions = mode === 'real' ? ruleAnomalyTypes : demoCategories

  return <div className="app-shell">
    {user && <DashboardSidebar user={user} activePage="anomalyDetection" menuOpen={menuOpen} onMenuClose={() => setMenuOpen(false)} onLogout={() => void handleLogout()} />}
    <main className="main-area">
      <header className="topbar">
        <button className="icon-button menu-toggle" type="button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
        <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>AI Anomaly Detection</strong></div>
        <div className="topbar-actions"><div className="environment-pill"><i /> Administrator</div><div className="top-avatar">{user?.name.slice(0, 1).toUpperCase()}</div></div>
      </header>
      <div className="content-wrap anomaly-content">
        <section className="dispatch-heading">
          <div>
            <div className="eyebrow">OPERATIONS INTELLIGENCE <span className="eyebrow-dot" /> ADMINISTRATION</div>
            <h1>AI Anomaly Detection</h1>
            <p className="page-subtitle">Review model-generated demo candidates separately from operational rule findings.</p>
          </div>
          <button className="admin-users-secondary" type="button" onClick={() => void loadPage()} disabled={loading}>
            <RefreshCw size={15} /> Refresh history
          </button>
        </section>

        {success && <div className="admin-users-success" role="status"><span>{success}</span><button type="button" aria-label="Dismiss" onClick={() => setSuccess('')}><X size={15} /></button></div>}
        {error && <div className="admin-users-alert" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError('')}><X size={15} /></button></div>}

        <section className="anomaly-controls admin-users-panel" aria-label="Detection mode and actions">
          <div className="anomaly-mode-control">
            <strong>Detection mode</strong>
            <div className="anomaly-mode-switch" role="group" aria-label="Detection mode">
              <button type="button" aria-pressed={mode === 'real'} className={mode === 'real' ? 'active' : ''} onClick={() => {
                setMode('real'); setPage(1); setSeverity(''); setAnomalyType(''); setReviewStatus(''); setSelected(null); setLastDetection(null); setSuccess('')
              }}>Real Data</button>
              <button type="button" aria-pressed={mode === 'synthetic_demo'} className={mode === 'synthetic_demo' ? 'active' : ''} onClick={() => {
                setMode('synthetic_demo'); setPage(1); setSeverity(''); setAnomalyType(''); setReviewStatus(''); setSelected(null); setLastDetection(null); setSuccess('')
              }}>Anomaly Detection Demo</button>
            </div>
          </div>
          <button className="dispatch-create-button" type="button" onClick={() => void handleRunDetection()} disabled={running || loading}>
            {running ? <><span className="spinner spinner-small" /> {mode === 'real' ? 'Checking rules…' : 'Analyzing demo…'}</> : <><AlertTriangle size={15} /> {mode === 'real' ? 'Run rule checks' : 'Re-analyze demo'}</>}
          </button>
        </section>

        {lastDetection && <section className="anomaly-last-run" role="status">
          <strong>{lastDetection.detectionSource === 'backend_rule_based' ? 'Rule check complete' : 'Demo analysis complete'}</strong>
          <p>{lastDetection.scenarioCount} {mode === 'real' ? 'dispatch records checked' : 'illustrative scenarios analyzed'} · {lastDetection.candidateCount} findings · {lastDetection.savedAlerts} new alerts · {lastDetection.duplicateAlertsSkipped} already recorded</p>
          {lastDetection.limitations.length > 0 && <ul>{lastDetection.limitations.slice(0, 3).map((note, index) => <li key={`${index}-${note}`}>{safeUserError(new Error(note), note)}</li>)}</ul>}
        </section>}

        <section className="anomaly-summary-grid" aria-label={`${modeLabel} summary`}>
          {[
            ['Total findings', summary?.total],
            ['New', summary?.new],
            ['High / critical', summary?.highSeverity],
            ['Under review', summary?.underReview],
            ['Resolved', summary?.resolved],
          ].map(([label, count]) => <article className="anomaly-summary-card" key={String(label)}>
            <span>{label}</span>
            <strong>{loading ? '—' : Number(count ?? 0).toLocaleString()}</strong>
          </article>)}
        </section>

        <section className="anomaly-distribution-grid" aria-label="Finding distributions">
          <article className="admin-users-panel anomaly-distribution-panel">
            <div className="anomaly-panel-heading"><div><h2><BarChart3 size={16} /> Severity distribution</h2><p>Counts in the visible findings</p></div></div>
            {loading ? <div className="anomaly-chart-state">Loading severity summary…</div> : (
              <div className="anomaly-bar-chart" role="img" aria-label={`Severity counts: ${severityDistribution.map((item) => `${item.label} ${item.count}`).join(', ')}`}>
                {severityDistribution.map((item) => <div className="anomaly-bar-row" key={item.label}>
                  <span className={`anomaly-bar-label severity-text-${item.label}`}>{item.label}</span>
                  <div className="anomaly-bar-track"><span className={`anomaly-bar-fill severity-fill-${item.label}`} style={{ width: `${item.count / maxSeverityCount * 100}%` }} /></div>
                  <strong>{item.count}</strong>
                </div>)}
              </div>
            )}
          </article>
          <article className="admin-users-panel anomaly-distribution-panel">
            <div className="anomaly-panel-heading"><div><h2><BarChart3 size={16} /> {mode === 'real' ? 'Finding categories' : 'Scenario context'}</h2><p>{mode === 'real' ? 'Rule categories in the visible findings' : 'Generated labels attached to visible model candidates'}</p></div></div>
            {loading ? <div className="anomaly-chart-state">Loading category breakdown…</div> : categoryDistribution.length === 0 ? (
              <p className="anomaly-chart-state">No category metadata is available in this view.</p>
            ) : (
              <div className="anomaly-bar-chart anomaly-category-chart" role="img" aria-label={`${mode === 'real' ? 'Rule finding' : 'Scenario context'} category counts: ${categoryDistribution.map((item) => `${readable(item.category)} ${item.count}`).join(', ')}`}>
                {categoryDistribution.map((item) => <div className="anomaly-bar-row" key={item.category}>
                  <span className="anomaly-bar-label">{readable(item.category)}</span>
                  <div className="anomaly-bar-track"><span className="anomaly-bar-fill anomaly-category-fill" style={{ width: `${item.count / maxCategoryCount * 100}%` }} /></div>
                  <strong>{item.count}</strong>
                </div>)}
              </div>
            )}
          </article>
        </section>

        <section className="admin-users-panel anomaly-table-panel">
          <div className="anomaly-toolbar">
            <div><h2>{mode === 'real' ? 'Rule-based operational findings' : 'Demo model candidates'}</h2><p>{mode === 'real' ? 'Findings are produced by backend rules.' : 'Generated examples for review, not confirmed incidents.'}</p></div>
            <div className="anomaly-filters">
              <label><span className="visually-hidden">Filter by severity</span><select value={severity} onChange={(event) => { setSeverity(event.target.value as Severity | ''); setPage(1) }}><option value="">All severity</option>{['low', 'medium', 'high', 'critical'].map((item) => <option key={item} value={item}>{readable(item)}</option>)}</select></label>
              <label><span className="visually-hidden">Filter by {mode === 'real' ? 'finding category' : 'scenario context'}</span><select value={anomalyType} onChange={(event) => { setAnomalyType(event.target.value); setPage(1) }}><option value="">All {mode === 'real' ? 'categories' : 'scenario context'}</option>{categoryOptions.map((item) => <option key={item} value={item}>{readable(item)}</option>)}</select></label>
              <label><span className="visually-hidden">Filter by review status</span><select value={reviewStatus} onChange={(event) => { setReviewStatus(event.target.value as ReviewStatus | ''); setPage(1) }}><option value="">All review states</option>{['new', 'under_review', 'resolved', 'dismissed'].map((item) => <option key={item} value={item}>{readable(item)}</option>)}</select></label>
            </div>
          </div>
          {loading ? (
            <div className="dispatch-state" role="status"><span className="spinner spinner-small" /> Loading anomaly findings…</div>
          ) : visibleAlerts.length === 0 ? (
            <div className="dispatch-state dispatch-empty">
              <AlertTriangle size={22} />
              <strong>{mode === 'real' ? 'No rule findings in this view' : 'No demo candidates in this view'}</strong>
              <p>{mode === 'real' ? 'Run the rule checks or adjust the filters.' : 'Run the demo analysis or adjust the filters. Demo results are separate from operational findings.'}</p>
            </div>
          ) : (
            <div className="admin-users-table-wrap">
              <table className="admin-users-table anomaly-table">
                <thead><tr>
                  <th>Finding type</th><th>Severity</th>
                  {mode === 'synthetic_demo' ? <><th>Anomaly score</th><th>Scenario</th></> : <><th>Dispatch</th><th>Agent</th></>}
                  <th>Detected</th><th>Source</th><th>Review</th><th />
                </tr></thead>
                <tbody>{visibleAlerts.map((alert) => <tr key={alert._id}>
                  <td>{mode === 'synthetic_demo' ? <code>unsupervised_outlier</code> : readable(alert.anomalyType)}</td>
                  <td><span className={`anomaly-severity severity-${alert.severity}`}>{alert.severity}</span></td>
                  {mode === 'synthetic_demo' ? <>
                    <td>{scoreValue(alert) === null ? 'Not available' : scoreValue(alert)?.toFixed(4)}</td>
                    <td><code>{scenarioIdentifier(alert) ?? 'Not available'}</code></td>
                  </> : <><td>{alert.dispatchId ?? '—'}</td><td>{alert.agentId ?? '—'}</td></>}
                  <td>{new Date(findingTimestamp(alert, mode) ?? alert.createdAt).toLocaleString()}</td>
                  <td>{mode === 'synthetic_demo' ? 'Isolation Forest' : 'Backend rules'}</td>
                  <td>{readable(alert.reviewStatus)}</td>
                  <td><button className="anomaly-detail-button" type="button" onClick={() => void openDetails(alert)}>Details</button></td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
          <div className="dispatch-pagination">
            <span>{summary?.total ?? 0} findings · {visibleAlerts.length} shown</span>
            <div><span>Page {page} of {totalPages}</span><button type="button" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} /></button><button type="button" aria-label="Next page" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button></div>
          </div>
        </section>
        {detailLoading && <div className="anomaly-detail-loading" role="status"><span className="spinner spinner-small" /> Loading alert details…</div>}
        {selected && <section className="anomaly-detail admin-users-panel" aria-label="Finding details">
          <header>
            <div><span className="eyebrow">{modeLabel.toUpperCase()}</span><h2>{mode === 'synthetic_demo' ? 'unsupervised_outlier' : readable(selected.anomalyType)}</h2></div>
            <button type="button" className="icon-button" aria-label="Close finding details" onClick={() => setSelected(null)}><X size={17} /></button>
          </header>
          <p>{safeDisplayText(selected.explanation)}</p>
          <dl>
            <dt>Finding source</dt><dd>{mode === 'synthetic_demo' ? 'Isolation Forest demo candidate' : 'Backend rule-based finding'}</dd>
            {mode === 'synthetic_demo' ? <>
              <dt>Anomaly score</dt><dd>{scoreValue(selected)?.toFixed(6) ?? 'Not available'}</dd>
              <dt>Decision threshold</dt><dd>{safeValue(selected.threshold)}</dd>
              <dt>Scenario identifier</dt><dd><code>{scenarioIdentifier(selected) ?? 'Not available'}</code></dd>
              <dt>Scenario context</dt><dd>{scenarioCategory(selected) ? `${readable(scenarioCategory(selected) ?? '')} · generated label, not a model prediction` : 'Not available'}</dd>
              <dt>Model</dt><dd>Isolation Forest</dd>
            </> : <>
              <dt>Rule measurement</dt><dd>{safeValue(selected.measuredValue)}</dd>
              <dt>Rule threshold</dt><dd>{safeValue(selected.threshold)}</dd>
              <dt>Dispatch</dt><dd>{selected.dispatchId ?? '—'}</dd>
              <dt>Agent</dt><dd>{selected.agentId ?? '—'}</dd>
            </>}
            <dt>Detection method</dt><dd>{readable(selected.detectionMethod)}</dd>
            <dt>Data-quality notes</dt><dd>{selected.dataQualityNotes.length ? safeDisplayText(selected.dataQualityNotes.join(' · ')) : 'None reported'}</dd>
            <dt>Evidence time</dt><dd>{new Date(findingTimestamp(selected, mode) ?? selected.createdAt).toLocaleString()}</dd>
          </dl>
          <label className="anomaly-review-notes">Review notes<textarea maxLength={1000} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Add a note for the alert review" /></label>
          <button className="anomaly-save-note" type="button" onClick={() => void saveReviewNote()} disabled={savingNote || savingReview}>{savingNote ? <><span className="spinner spinner-small" /> Saving note…</> : 'Save Note'}</button>
          <div className="anomaly-review-actions"><span>Current status: <strong>{readable(selected.reviewStatus)}</strong></span><button type="button" onClick={() => void saveReview('under_review')} disabled={savingReview || savingNote}>Mark under review</button><button type="button" onClick={() => void saveReview('resolved')} disabled={savingReview || savingNote}>Resolve</button><button type="button" onClick={() => void saveReview('dismissed')} disabled={savingReview || savingNote}>Dismiss</button></div>
        </section>}
        <footer className="page-footer"><span>SWERV</span><span>AI Anomaly Detection · Admin review only</span></footer>
      </div>
    </main>
  </div>
}

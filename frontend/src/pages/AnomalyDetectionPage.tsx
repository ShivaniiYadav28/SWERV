import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Menu, RefreshCw, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import { getAnomalyAlert, getAnomalyAlerts, getAnomalySummary, reviewAnomalyAlert, runAnomalyDetection, saveAnomalyAlertNote } from '../lib/anomalyDetection'
import type { AnomalyAlert, AnomalySummary, DetectionMode, DetectionResult, ReviewStatus, Severity } from '../types/anomalyDetection'
import '../App.css'
import './anomaly-detection.css'

const anomalyTypes = [
  'gps_missing_coordinates', 'gps_invalid_coordinates', 'gps_invalid_timestamp', 'gps_invalid_timestamp_order',
  'gps_stale_submission', 'gps_stale_update', 'gps_implausible_jump', 'repeated_dispatch_reassignment', 'unusual_delivery_duration', 'invalid_status_transition',
]

function readable(value: string) {
  return value.replaceAll('_', ' ')
}

function safeValue(value: unknown) {
  if (value === null || value === undefined) return 'Not available'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
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
      const [nextSummary, nextAlerts] = await Promise.all([
        getAnomalySummary(mode),
        getAnomalyAlerts({ mode, page, limit: 10, severity: severity || undefined, anomalyType: anomalyType || undefined, reviewStatus: reviewStatus || undefined }),
      ])
      if (requestNumber === latestRequest.current) {
        setSummary(nextSummary)
        setAlerts(nextAlerts.alerts)
        setTotalPages(Math.max(1, nextAlerts.pagination.pages))
      }
    } catch (loadError) {
      if (requestNumber === latestRequest.current) {
        setError(loadError instanceof Error ? loadError.message : 'Anomaly history could not be loaded.')
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
      setSuccess(`${mode === 'real' ? 'Real-data' : 'Synthetic demo'} detection saved ${result.savedAlerts} new alerts; ${result.duplicateAlertsSkipped} duplicates were skipped.`)
      await loadPage()
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Anomaly detection could not be completed.')
    } finally { setRunning(false) }
  }

  async function openDetails(alert: AnomalyAlert) {
    setSelected(null)
    setDetailLoading(true)
    setReviewNotes(alert.reviewNotes)
    try { setSelected(await getAnomalyAlert(alert._id, mode)) }
    catch (detailError) { setError(detailError instanceof Error ? detailError.message : 'Alert details could not be loaded.') }
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
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'Alert review could not be saved.') }
    finally { setSavingReview(false) }
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
      setError(saveError instanceof Error ? saveError.message : 'Review note could not be saved.')
    } finally { setSavingNote(false) }
  }

  const modeLabel = mode === 'real' ? 'Real Data Mode' : 'Synthetic Demo Mode'

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
          <div><div className="eyebrow">OPERATIONS INTELLIGENCE <span className="eyebrow-dot" /> ADMINISTRATION</div><h1>AI Anomaly Detection</h1><p className="page-subtitle">Review data-quality findings and model-generated anomaly candidates.</p></div>
          <button className="admin-users-secondary" type="button" onClick={() => void loadPage()} disabled={loading}><RefreshCw size={15} /> Refresh</button>
        </section>

        <section className={`anomaly-notice ${mode === 'real' ? 'anomaly-notice-real' : ''}`} role="status"><AlertTriangle size={18} /><div><strong>{mode === 'real' ? 'Real SWERV records · synthetic-trained model' : 'Synthetic demonstration only'}</strong><p>{mode === 'real' ? 'Rule-based findings use recorded evidence. Any ML candidates come from a model trained only on generated scenarios and are not validated for real SWERV operations.' : 'These generated scenarios and alerts are not actual SWERV deliveries or agent incidents. Model results are not validated for real operations.'}</p></div></section>
        {success && <div className="admin-users-success" role="status"><span>{success}</span><button type="button" aria-label="Dismiss" onClick={() => setSuccess('')}><X size={15} /></button></div>}
        {error && <div className="admin-users-alert" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError('')}><X size={15} /></button></div>}

        <section className="anomaly-controls admin-users-panel">
          <div><strong>Detection source</strong><p>Real and demo alerts are stored and counted separately.</p></div>
          <label><span>Mode</span><select value={mode} onChange={(event) => { setMode(event.target.value as DetectionMode); setPage(1); setSelected(null); setLastDetection(null); setSuccess('') }}><option value="real">Real Data Mode</option><option value="synthetic_demo">Synthetic Demo Mode</option></select></label>
          <button className="dispatch-create-button" type="button" onClick={() => void handleRunDetection()} disabled={running || loading}>{running ? <><span className="spinner spinner-small" /> Running…</> : <><AlertTriangle size={15} /> Run Detection</>}</button>
        </section>
        <p className="anomaly-mode-label">Active view: <strong>{modeLabel}</strong>{mode === 'real' && ' — operational data only; no missing events or values are generated.'}</p>

        {lastDetection && <section className="anomaly-last-run"><strong>Last detection:</strong> {lastDetection.scenarioCount} scenarios checked · {lastDetection.modelName} ({lastDetection.modelVersion}) · trained on {lastDetection.trainingDataSource} data. {lastDetection.syntheticProvenance}{lastDetection.limitations.length > 0 && <ul>{lastDetection.limitations.slice(0, 3).map((note) => <li key={note}>{note}</li>)}</ul>}</section>}

        <section className="anomaly-summary-grid" aria-label={`${modeLabel} summary`}>
          {[['Total alerts', summary?.total], ['New alerts', summary?.new], ['High severity', summary?.highSeverity], ['Under review', summary?.underReview], ['Resolved', summary?.resolved]].map(([label, count]) => <article className="anomaly-summary-card" key={String(label)}><span>{label}</span><strong>{loading ? '—' : Number(count ?? 0).toLocaleString()}</strong></article>)}
        </section>

        <section className="admin-users-panel anomaly-table-panel">
          <div className="anomaly-toolbar"><div><h2>Alert history</h2><p>{modeLabel} results</p></div><div className="anomaly-filters">
            <label><span className="visually-hidden">Filter by severity</span><select value={severity} onChange={(event) => { setSeverity(event.target.value as Severity | ''); setPage(1) }}><option value="">All severity</option>{['low', 'medium', 'high', 'critical'].map((item) => <option key={item} value={item}>{readable(item)}</option>)}</select></label>
            <label><span className="visually-hidden">Filter by anomaly type</span><select value={anomalyType} onChange={(event) => { setAnomalyType(event.target.value); setPage(1) }}><option value="">All types</option>{anomalyTypes.map((item) => <option key={item} value={item}>{readable(item)}</option>)}</select></label>
            <label><span className="visually-hidden">Filter by review status</span><select value={reviewStatus} onChange={(event) => { setReviewStatus(event.target.value as ReviewStatus | ''); setPage(1) }}><option value="">All review states</option>{['new', 'under_review', 'resolved', 'dismissed'].map((item) => <option key={item} value={item}>{readable(item)}</option>)}</select></label>
          </div></div>
          {loading ? <div className="dispatch-state"><span className="spinner spinner-small" /> Loading alert history…</div> : alerts.length === 0 ? <div className="dispatch-state dispatch-empty"><AlertTriangle size={22} /><strong>No alerts in this view</strong><p>Run detection or adjust the filters. Data from the other mode is kept separately.</p></div> : <div className="admin-users-table-wrap"><table className="admin-users-table anomaly-table"><thead><tr><th>Anomaly</th><th>Severity</th><th>Dispatch</th><th>Agent</th><th>Detected</th><th>Method</th><th>Review</th><th /></tr></thead><tbody>{alerts.map((alert) => <tr key={alert._id}><td>{readable(alert.anomalyType)}</td><td><span className={`anomaly-severity severity-${alert.severity}`}>{alert.severity}</span></td><td>{alert.dispatchId ?? '—'}</td><td>{alert.agentId ?? '—'}</td><td>{new Date(alert.createdAt).toLocaleString()}</td><td>{readable(alert.detectionMethod)}</td><td>{readable(alert.reviewStatus)}</td><td><button className="anomaly-detail-button" type="button" onClick={() => void openDetails(alert)}>Details</button></td></tr>)}</tbody></table></div>}
          <div className="dispatch-pagination"><span>{summary?.total ?? 0} alerts in {modeLabel.toLowerCase()}</span><div><span>Page {page} of {totalPages}</span><button type="button" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} /></button><button type="button" aria-label="Next page" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button></div></div>
        </section>
        {detailLoading && <div className="anomaly-detail-loading" role="status"><span className="spinner spinner-small" /> Loading alert details…</div>}
        {selected && <section className="anomaly-detail admin-users-panel" aria-label="Alert details"><header><div><span className="eyebrow">{modeLabel.toUpperCase()}</span><h2>{readable(selected.anomalyType)}</h2></div><button type="button" className="icon-button" aria-label="Close alert details" onClick={() => setSelected(null)}><X size={17} /></button></header>
          <p>{selected.explanation}</p><dl><dt>Evidence</dt><dd>{safeValue(selected.evidence)}</dd><dt>Measured value</dt><dd>{safeValue(selected.measuredValue)}</dd><dt>Threshold</dt><dd>{safeValue(selected.threshold)}</dd><dt>Detection method</dt><dd>{readable(selected.detectionMethod)}</dd><dt>Model</dt><dd>{selected.modelName ? `${selected.modelName} · ${selected.modelVersion}` : 'Rule based'}</dd><dt>Model provenance</dt><dd>{selected.modelProvenance ?? 'No ML model was used for this rule-based finding.'}</dd><dt>Data source / mode</dt><dd>{selected.dataSource} / {selected.detectionMode}</dd><dt>Data-quality notes</dt><dd>{selected.dataQualityNotes.length ? selected.dataQualityNotes.join(' · ') : 'None reported'}</dd><dt>Evidence time</dt><dd>{selected.evidenceTimestamp ? new Date(selected.evidenceTimestamp).toLocaleString() : 'Not available'}</dd></dl>
          <label className="anomaly-review-notes">Review notes<textarea maxLength={1000} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Add a note for the alert review" /></label><button className="anomaly-save-note" type="button" onClick={() => void saveReviewNote()} disabled={savingNote || savingReview}>{savingNote ? <><span className="spinner spinner-small" /> Saving note…</> : 'Save Note'}</button><div className="anomaly-review-actions"><span>Current status: <strong>{readable(selected.reviewStatus)}</strong></span><button type="button" onClick={() => void saveReview('under_review')} disabled={savingReview || savingNote}>Mark under review</button><button type="button" onClick={() => void saveReview('resolved')} disabled={savingReview || savingNote}>Resolve</button><button type="button" onClick={() => void saveReview('dismissed')} disabled={savingReview || savingNote}>Dismiss</button></div>
        </section>}
        <footer className="page-footer"><span>SWERV</span><span>AI Anomaly Detection · Admin review only</span></footer>
      </div>
    </main>
  </div>
}

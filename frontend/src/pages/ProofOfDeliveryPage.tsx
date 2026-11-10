import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, ClipboardCheck, MapPin, Menu, RefreshCw, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import { getAdminPodEvidence, getPodRecord, getPodRecords } from '../lib/proofOfDelivery'
import type { PodRecord } from '../types/proofOfDelivery'
import '../App.css'
import './proof-of-delivery.css'

type EvidenceUrls = { photo: string | null; signature: string | null }

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function ProofOfDeliveryPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [records, setRecords] = useState<PodRecord[]>([])
  const [selected, setSelected] = useState<PodRecord | null>(null)
  const [evidence, setEvidence] = useState<EvidenceUrls | null>(null)
  const [evidenceWarning, setEvidenceWarning] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')

  const loadRecords = useCallback(async () => {
    setLoading(true); setError('')
    try { setRecords(await getPodRecords()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Proof records could not be loaded.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRecords(), 0)
    return () => window.clearTimeout(timer)
  }, [loadRecords])
  useEffect(() => () => {
    if (evidence?.photo != null) URL.revokeObjectURL(evidence.photo)
    if (evidence?.signature != null) URL.revokeObjectURL(evidence.signature)
  }, [evidence])

  async function openRecord(dispatchId: string) {
    setDetailLoading(true); setError(''); setEvidenceWarning('')
    try {
      const record = await getPodRecord(dispatchId)
      const files = await getAdminPodEvidence(dispatchId)
      setSelected(record)
      setEvidence({
        photo: files.photo ? URL.createObjectURL(files.photo) : null,
        signature: files.signature ? URL.createObjectURL(files.signature) : null,
      })
      const missing = [
        !files.photo ? 'Delivery photo' : '',
        !files.signature ? 'Customer signature' : '',
      ].filter(Boolean)
      setEvidenceWarning(missing.length ? `${missing.join(' and ')} unavailable in storage.` : '')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Proof details could not be loaded.') }
    finally { setDetailLoading(false) }
  }

  function closeDetails() {
    setEvidence(null); setSelected(null); setEvidenceWarning('')
  }

  async function handleLogout() {
    try { await logout() } catch { /* The local session still clears if the API is offline. */ }
    navigate('/login', { replace: true })
  }

  return <div className="app-shell">
    {user && <DashboardSidebar user={user} activePage="pod" menuOpen={menuOpen} onMenuClose={() => setMenuOpen(false)} onLogout={() => void handleLogout()} />}
    <main className="main-area">
      <header className="topbar"><button className="icon-button menu-toggle" type="button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>Administration</span><span className="crumb-slash">/</span><strong>Proof of delivery</strong></div><button className="quiet-button" type="button" onClick={() => void loadRecords()} disabled={loading}><RefreshCw size={15} />Refresh</button></header>
      <div className="pod-admin-page"><section className="pod-admin-heading"><div><span className="pod-admin-eyebrow">DELIVERY VERIFICATION</span><h1>Proof of delivery</h1><p>Review immutable delivery evidence submitted by agents.</p></div><span className="pod-admin-count"><ClipboardCheck size={15} />{records.length} records</span></section>
        {error && <div className="pod-admin-error" role="alert">{error}<button type="button" onClick={() => void loadRecords()}>Try again</button></div>}
        {loading ? <div className="pod-admin-state" role="status">Loading proof records…</div> : records.length === 0 ? <div className="pod-admin-state"><ClipboardCheck size={24} /><strong>No completed POD records</strong><span>Submitted delivery proof will appear here.</span></div> : <div className="pod-admin-table-wrap"><table className="pod-admin-table"><thead><tr><th>Dispatch</th><th>Agent</th><th>Delivered</th><th>Verification</th><th></th></tr></thead><tbody>{records.map((record) => <tr key={record._id}><td><strong>#{record.dispatchRequestId.slice(-8).toUpperCase()}</strong><small>{record.dispatchRequestId}</small></td><td>{record.agent?.name ?? 'Agent unavailable'}<small>{record.agent?.agentCode ?? record.agentId}</small></td><td>{formatDate(record.deliveredAt)}</td><td><span className="pod-verified-pill"><CheckCircle2 size={14} />OTP verified</span><small>{record.locationStatus === 'captured' ? 'GPS captured' : 'GPS unavailable'}</small></td><td><button className="pod-view-button" type="button" onClick={() => void openRecord(record.dispatchRequestId)} disabled={detailLoading}>{detailLoading ? 'Loading…' : 'View proof'}</button></td></tr>)}</tbody></table></div>}
      </div>
    </main>
    {selected && <div className="pod-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetails() }}><section className="pod-modal" role="dialog" aria-modal="true" aria-labelledby="pod-modal-title"><header><div><span className="pod-admin-eyebrow">IMMUTABLE EVIDENCE</span><h2 id="pod-modal-title">Dispatch #{selected.dispatchRequestId.slice(-8).toUpperCase()}</h2></div><button type="button" aria-label="Close proof details" onClick={closeDetails}><X size={18} /></button></header><div className="pod-modal-facts"><div><span>Agent</span><strong>{selected.agent?.name ?? 'Agent unavailable'} · {selected.agent?.agentCode ?? selected.agentId}</strong></div><div><span>Delivery time</span><strong>{formatDate(selected.deliveredAt)}</strong></div><div><span>Customer verification</span><strong>OTP verified · {formatDate(selected.otpVerifiedAt)}</strong></div><div><span>Location</span><strong>{selected.locationStatus === 'captured' && selected.latitude !== null && selected.longitude !== null ? <><MapPin size={14} />{selected.latitude.toFixed(6)}, {selected.longitude.toFixed(6)}{selected.accuracyMeters !== null ? ` · ±${Math.round(selected.accuracyMeters)} m` : ''}</> : `Unavailable (${selected.locationUnavailableReason?.replaceAll('_', ' ') ?? 'not provided'})`}</strong></div></div>{evidence && <><div className="pod-evidence-grid"><figure>{evidence.photo ? <img src={evidence.photo} alt="Delivery photograph" /> : <div className="pod-evidence-missing">Delivery photo unavailable</div>}<figcaption>Delivery photo</figcaption></figure><figure>{evidence.signature ? <img src={evidence.signature} alt="Customer digital signature" /> : <div className="pod-evidence-missing">Customer signature unavailable</div>}<figcaption>Customer signature</figcaption></figure></div>{evidenceWarning && <p className="pod-evidence-warning" role="status">{evidenceWarning} Historical files missing from storage cannot be restored by this application.</p>}</>}<p className="pod-immutable-note">Submitted evidence is read-only.</p></section></div>}
  </div>
}

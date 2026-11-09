import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock3, MapPin, Menu, Navigation, Route, Sparkles } from 'lucide-react'
import L from 'leaflet'
import { MapContainer, Marker, Polyline, Popup, TileLayer, ZoomControl, useMap } from 'react-leaflet'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import { getAgents } from '../lib/agents'
import { applyRoute, getRouteDeliveries, getSavedRoutePlan, previewRoute } from '../lib/routeOptimization'
import type { Agent } from '../types/agent'
import type { RouteDeliveryOption, RoutePreview, RouteStop, SavedRoutePlan } from '../types/routeOptimization'
import '../App.css'
import './route-optimization.css'
import 'leaflet/dist/leaflet.css'

function shortDispatchId(id: string) {
  return id.slice(-8).toUpperCase()
}

function stopName(stop: RouteStop) {
  return `${stop.stopType === 'pickup' ? 'Pickup' : 'Destination'} · #${shortDispatchId(stop.dispatchRequestId)}`
}

function formatDistance(meters: number) {
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} km` : `${Math.round(meters)} m`
}

function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours} hr ${remainingMinutes} min`
}

function improvementLabel(value: number | null, unit: string) {
  if (value === null) return `${unit} comparison unavailable`
  if (Math.abs(value) < 0.05) return `No ${unit} change`
  return value > 0 ? `${value.toFixed(1)}% less ${unit}` : `${Math.abs(value).toFixed(1)}% more ${unit}`
}

export function RouteOptimizationPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [deliveries, setDeliveries] = useState<RouteDeliveryOption[]>([])
  const [selectedDispatchIds, setSelectedDispatchIds] = useState<string[]>([])
  const [savedPlan, setSavedPlan] = useState<SavedRoutePlan | null>(null)
  const [preview, setPreview] = useState<RoutePreview | null>(null)
  const [isLoadingAgents, setIsLoadingAgents] = useState(true)
  const [isLoadingDeliveries, setIsLoadingDeliveries] = useState(false)
  const [isOptimizing, setIsOptimizing] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [showConfirmation, setShowConfirmation] = useState(false)

  useEffect(() => {
    let active = true
    async function loadAgents() {
      setIsLoadingAgents(true)
      try {
        const result = await getAgents({
          page: 1, limit: 100, search: '', status: '', vehicleType: '', capability: '', isActive: true,
        })
        if (active) {
          const selectableAgents = result.agents.filter((agent) => agent.status !== 'suspended')
          setAgents(selectableAgents)
          setSelectedAgentId((current) => current || selectableAgents[0]?._id || '')
        }
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Agents could not be loaded.')
      } finally {
        if (active) setIsLoadingAgents(false)
      }
    }
    void loadAgents()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!selectedAgentId) return
    let active = true
    async function loadAgentRouteData() {
      setIsLoadingDeliveries(true)
      setLoadError('')
      setActionError('')
      setSuccessMessage('')
      setPreview(null)
      try {
        const [routeDeliveries, routePlan] = await Promise.all([
          getRouteDeliveries(selectedAgentId),
          getSavedRoutePlan(selectedAgentId),
        ])
        if (!active) return
        setDeliveries(routeDeliveries)
        setSavedPlan(routePlan)
        setSelectedDispatchIds(routeDeliveries
          .filter((delivery) => delivery.missingCoordinates.length === 0)
          .slice(0, 12)
          .map((delivery) => delivery.dispatchRequestId))
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Agent route data could not be loaded.')
      } finally {
        if (active) setIsLoadingDeliveries(false)
      }
    }
    void loadAgentRouteData()
    return () => { active = false }
  }, [selectedAgentId])

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent._id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  )
  async function handleLogout() {
    try { await logout() } catch { /* The local session clears if the API is offline. */ }
    navigate('/login', { replace: true })
  }

  function toggleDelivery(dispatchRequestId: string) {
    if (!selectedDispatchIds.includes(dispatchRequestId) && selectedDispatchIds.length >= 12) {
      setActionError('Select no more than 12 deliveries for one route calculation.')
      return
    }
    setSelectedDispatchIds((current) => current.includes(dispatchRequestId)
      ? current.filter((id) => id !== dispatchRequestId)
      : [...current, dispatchRequestId])
    setPreview(null)
    setActionError('')
    setSuccessMessage('')
  }

  async function handlePreview() {
    if (!selectedAgentId || selectedDispatchIds.length === 0) return
    setIsOptimizing(true)
    setActionError('')
    setSuccessMessage('')
    try {
      setPreview(await previewRoute(selectedAgentId, selectedDispatchIds))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Road routes could not be calculated.')
      setPreview(null)
    } finally {
      setIsOptimizing(false)
    }
  }

  async function handleApply() {
    if (!preview) return
    setIsApplying(true)
    setActionError('')
    try {
      const routePlan = await applyRoute(selectedAgentId, selectedDispatchIds, preview.optimized.stops)
      setSavedPlan(routePlan)
      setShowConfirmation(false)
      setSuccessMessage('The optimized stop sequence was saved for this agent. Dispatch statuses were not changed.')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The optimized route could not be saved.')
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <div className="app-shell">
      {user && <DashboardSidebar user={user} activePage="routeOptimization" menuOpen={menuOpen} onMenuClose={() => setMenuOpen(false)} onLogout={() => void handleLogout()} />}
      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-toggle" type="button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>Route optimization</strong></div>
          <div className="topbar-actions"><div className="environment-pill"><i /> Operations</div><div className="top-avatar">{user?.name.slice(0, 1).toUpperCase()}</div></div>
        </header>

        <div className="content-wrap route-content">
          <section className="route-heading">
            <div><div className="eyebrow">FLEET OPERATIONS <span className="eyebrow-dot" /> ROAD ROUTING</div><h1>Route Optimization</h1><p className="page-subtitle">Plan a pickup and delivery order for one agent’s active dispatches.</p></div>
            <span className="route-provider-pill"><Route size={14} /> OSRM road estimates</span>
          </section>

          <div className="route-provider-notice" role="note">
            <AlertCircle size={17} /> Road distance and time come from the configured OSRM routing server. Estimates do not include live traffic. The public OSRM demo is best for prototypes and may be rate-limited or unavailable.
          </div>

          {loadError && <div className="route-alert" role="alert"><span>{loadError}</span><button type="button" onClick={() => window.location.reload()}>Retry</button></div>}
          {actionError && <div className="route-alert" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError('')}>Dismiss</button></div>}
          {successMessage && <div className="route-success" role="status"><CheckCircle2 size={16} />{successMessage}</div>}

          <section className="route-planner-layout">
            <aside className="route-selection-panel">
              <div className="route-panel-title"><div><span className="eyebrow">PLAN YOUR STOPS</span><h2>Agent and deliveries</h2></div><Navigation size={17} /></div>
              <label className="route-agent-field"><span>Select agent</span><select value={selectedAgentId} onChange={(event) => { setSelectedAgentId(event.target.value); setPreview(null); setDeliveries([]); setSelectedDispatchIds([]); setSavedPlan(null); setIsLoadingDeliveries(false) }} disabled={isLoadingAgents || agents.length === 0}><option value="">{isLoadingAgents ? 'Loading agents…' : 'Select an agent'}</option>{agents.map((agent) => <option key={agent._id} value={agent._id}>{agent.name} · {agent.agentCode}</option>)}</select></label>

              {selectedAgent && <div className="route-agent-summary"><span className="route-agent-avatar">{selectedAgent.name.trim().slice(0, 1).toUpperCase()}</span><div><strong>{selectedAgent.name}</strong><small>{selectedAgent.agentCode} · {selectedAgent.vehicle.vehicleType}</small></div><span className={`route-status status-${selectedAgent.status}`}>{selectedAgent.status.replaceAll('_', ' ')}</span></div>}

              <div className="route-deliveries-heading"><div><strong>Eligible active deliveries</strong><small>{selectedDispatchIds.length} selected · maximum 12</small></div>{deliveries.some((delivery) => delivery.missingCoordinates.length === 0) && <button type="button" onClick={() => { setSelectedDispatchIds(deliveries.filter((delivery) => delivery.missingCoordinates.length === 0).slice(0, 12).map((delivery) => delivery.dispatchRequestId)); setPreview(null) }}>Select up to 12</button>}</div>

              {isLoadingAgents || isLoadingDeliveries ? <div className="route-empty-state"><span className="spinner spinner-small" />Loading route data…</div> : !selectedAgentId ? <div className="route-empty-state">Select an agent to review assigned deliveries.</div> : deliveries.length === 0 ? <div className="route-empty-state"><PackageCheckIcon />No active assigned deliveries for this agent.</div> : (
                <div className="route-delivery-list">{deliveries.map((delivery) => {
                  const unavailable = delivery.missingCoordinates.length > 0
                  return <label className={`route-delivery-row ${unavailable ? 'coordinates-missing' : ''}`} key={delivery.dispatchRequestId}>
                    <input type="checkbox" checked={selectedDispatchIds.includes(delivery.dispatchRequestId)} disabled={unavailable} onChange={() => toggleDelivery(delivery.dispatchRequestId)} />
                    <span className="route-delivery-copy"><strong>Dispatch #{shortDispatchId(delivery.dispatchRequestId)}</strong><small>{delivery.status.replaceAll('_', ' ')} · {delivery.priority}</small>{unavailable && <small className="route-missing-note">Missing {delivery.missingCoordinates.join(' and ')} coordinates</small>}</span>
                    <span className="route-delivery-pin"><MapPin size={15} /></span>
                  </label>
                })}</div>
              )}

              {savedPlan && <div className="route-saved-plan-note"><CheckCircle2 size={15} /><span>Saved route order last applied {new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(savedPlan.appliedAt))}.</span></div>}
              <button className="route-primary-button" type="button" onClick={() => void handlePreview()} disabled={isOptimizing || isLoadingDeliveries || !selectedDispatchIds.length}>{isOptimizing ? <><span className="spinner spinner-small" />Calculating road route…</> : <><Sparkles size={15} />Optimize selected route</>}</button>
              <p className="route-selection-footnote">Only active deliveries assigned to the selected agent can be included. Pending requests must first be assigned through Dispatch. Missing coordinates are shown and excluded.</p>
            </aside>

            <div className="route-results-panel">
              {!preview ? <div className="route-results-empty"><span><Route size={22} /></span><strong>Your route preview will appear here</strong><p>Select coordinate-ready deliveries and calculate a road-network route.</p></div> : <>
                <div className="route-results-header"><div><span className="eyebrow">ROUTE COMPARISON</span><h2>Optimized stop sequence</h2><p>Baseline: {preview.baselineLabel}. Every pickup remains before its delivery.</p></div><span className="route-provider-pill"><Clock3 size={13} /> Provider estimate</span></div>

                <div className="route-metrics-grid">
                  <RouteMetric title="Baseline distance" value={formatDistance(preview.baseline.distanceMeters)} detail={preview.baselineLabel} />
                  <RouteMetric title="Optimized distance" value={formatDistance(preview.optimized.distanceMeters)} detail={improvementLabel(preview.improvement.distancePercent, 'distance')} highlight />
                  <RouteMetric title="Baseline time" value={formatDuration(preview.baseline.durationSeconds)} detail="Estimated road travel time" />
                  <RouteMetric title="Optimized time" value={formatDuration(preview.optimized.durationSeconds)} detail={improvementLabel(preview.improvement.durationPercent, 'travel time')} highlight />
                </div>

                <div className="route-map-wrapper"><RouteMap preview={preview} /></div>

                <div className="route-orders-grid">
                  <RouteOrder title="Original route order" subtitle={preview.baselineLabel} stops={preview.baseline.stops} />
                  <RouteOrder title="Optimized route order" subtitle="Pickup-before-delivery sequence" stops={preview.optimized.stops} optimized />
                </div>

                {preview.origin.source === 'first_route_stop' && <p className="route-origin-note">No fresh agent GPS was available. Both comparisons start at the first planned stop; this is not an estimate from the agent’s current position.</p>}
                <div className="route-apply-row"><p>Applying saves the stop order only. It does not assign deliveries or change their statuses.</p><button className="route-primary-button" type="button" onClick={() => setShowConfirmation(true)}><CheckCircle2 size={15} />Apply optimization</button></div>
              </>}
            </div>
          </section>
          <footer className="page-footer"><span>SWERV</span><span>Road route estimates depend on the configured routing server and map data.</span></footer>
        </div>
      </main>

      {showConfirmation && preview && <div className="route-confirm-backdrop"><section className="route-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="route-confirm-title"><span className="route-confirm-icon"><CheckCircle2 size={19} /></span><h2 id="route-confirm-title">Apply this stop order?</h2><p>Save {preview.optimized.stops.length} stops for {selectedAgent?.name ?? 'this agent'}? Existing dispatch assignments and statuses will not change.</p><div className="route-confirm-actions"><button type="button" onClick={() => setShowConfirmation(false)} disabled={isApplying}>Review route</button><button type="button" onClick={() => void handleApply()} disabled={isApplying}>{isApplying ? 'Saving…' : 'Confirm and save'}</button></div></section></div>}
    </div>
  )
}

function RouteMetric({ title, value, detail, highlight = false }: { title: string; value: string; detail: string; highlight?: boolean }) {
  return <article className={`route-metric-card ${highlight ? 'highlight' : ''}`}><span>{title}</span><strong>{value}</strong><small>{detail}</small></article>
}

function RouteOrder({ title, subtitle, stops, optimized = false }: { title: string; subtitle: string; stops: RouteStop[]; optimized?: boolean }) {
  return <section className={`route-order-card ${optimized ? 'optimized' : ''}`}><header><div><h3>{title}</h3><small>{subtitle}</small></div><span>{stops.length} stops</span></header><ol>{stops.map((stop, index) => <li key={`${stop.dispatchRequestId}-${stop.stopType}`}><span className="route-order-number">{index + 1}</span><span><strong>{stopName(stop)}</strong><small>{stop.stopType === 'pickup' ? 'Collect package' : 'Deliver package'}</small></span></li>)}</ol></section>
}

function RouteMap({ preview }: { preview: RoutePreview }) {
  const positions = [
    ...preview.baseline.geometry,
    ...preview.optimized.geometry,
    [preview.origin.latitude, preview.origin.longitude] as [number, number],
  ]
  const startPoint: [number, number] = [preview.origin.latitude, preview.origin.longitude]
  return <MapContainer center={startPoint} zoom={12} scrollWheelZoom zoomControl={false}>
    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
    <ZoomControl position="bottomright" />
    <RouteMapViewport positions={positions} />
    <Polyline positions={preview.baseline.geometry} pathOptions={{ color: '#869bb3', weight: 4, opacity: 0.7, dashArray: '7 7' }}><Popup>Baseline road route</Popup></Polyline>
    <Polyline positions={preview.optimized.geometry} pathOptions={{ color: '#e8897c', weight: 5, opacity: 0.95 }}><Popup>Optimized road route</Popup></Polyline>
    {preview.optimized.stops.map((stop, index) => <Marker key={`${stop.dispatchRequestId}-${stop.stopType}`} position={[stop.latitude, stop.longitude]} icon={routeStopIcon(index + 1)}><Popup>{stopName(stop)}</Popup></Marker>)}
    {preview.origin.source === 'fresh_agent_gps' && <Marker position={startPoint} icon={L.divIcon({ className: 'route-origin-marker', html: '<span>Start</span>', iconSize: [48, 20], iconAnchor: [24, 10] })}><Popup>Fresh agent GPS start</Popup></Marker>}
  </MapContainer>
}

function RouteMapViewport({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length) map.fitBounds(L.latLngBounds(positions), { padding: [30, 30], maxZoom: 14 })
  }, [map, positions])
  return null
}

function routeStopIcon(order: number) {
  return L.divIcon({ className: 'route-stop-icon-wrap', html: `<span>${order}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] })
}

function PackageCheckIcon() {
  return <Navigation size={19} />
}

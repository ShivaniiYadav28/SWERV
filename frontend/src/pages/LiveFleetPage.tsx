import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock3,
  MapPin,
  Menu,
  Navigation,
  RefreshCw,
  Search,
  Truck,
} from 'lucide-react'
import L from 'leaflet'
import { MapContainer, Marker, Popup, TileLayer, ZoomControl, useMap } from 'react-leaflet'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import { getLatestAgentLocations } from '../lib/agentLocations'
import { agentStatuses, type AgentStatus } from '../types/agent'
import type { AgentLocation } from '../types/agentLocation'
import '../App.css'
import './live-fleet.css'
import 'leaflet/dist/leaflet.css'

const refreshInterval = 15_000
const staleAfter = 2 * 60_000

const statusLabels: Record<AgentStatus, string> = {
  available: 'Available',
  unavailable: 'Unavailable',
  on_duty: 'On duty',
  suspended: 'Suspended',
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatAge(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} hr${hours === 1 ? '' : 's'} ago`
}

function isLocationStale(location: AgentLocation) {
  return Date.now() - new Date(location.recordedAt).getTime() > staleAfter
}

function markerIcon(status: AgentStatus, selected = false) {
  return L.divIcon({
    className: 'live-marker-wrap',
    html: `<span class="live-marker live-marker-${status}${selected ? ' is-selected' : ''}" aria-hidden="true"></span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

const markerIcons: Record<AgentStatus, L.DivIcon> = {
  available: markerIcon('available'),
  unavailable: markerIcon('unavailable'),
  on_duty: markerIcon('on_duty'),
  suspended: markerIcon('suspended'),
}

const selectedMarkerIcons: Record<AgentStatus, L.DivIcon> = {
  available: markerIcon('available', true),
  unavailable: markerIcon('unavailable', true),
  on_duty: markerIcon('on_duty', true),
  suspended: markerIcon('suspended', true),
}

export function LiveFleetPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [locations, setLocations] = useState<AgentLocation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<AgentStatus | ''>('')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const requestInProgress = useRef(false)
  const isMounted = useRef(false)
  const firstRequestComplete = useRef(false)

  const refreshLocations = useCallback(async () => {
    if (requestInProgress.current) return
    requestInProgress.current = true
    setIsRefreshing(true)
    if (!firstRequestComplete.current) setIsLoading(true)

    try {
      const latestLocations = await getLatestAgentLocations()
      if (isMounted.current) {
        setLocations(latestLocations)
        setLastRefreshAt(new Date())
        setLoadError('')
      }
    } catch (error) {
      if (isMounted.current) {
        setLoadError(error instanceof Error ? error.message : 'Live fleet locations could not be loaded.')
      }
    } finally {
      requestInProgress.current = false
      firstRequestComplete.current = true
      if (isMounted.current) {
        setIsLoading(false)
        setIsRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    isMounted.current = true
    const initialRequest = window.setTimeout(() => void refreshLocations(), 0)
    const interval = window.setInterval(() => void refreshLocations(), refreshInterval)
    return () => {
      isMounted.current = false
      window.clearTimeout(initialRequest)
      window.clearInterval(interval)
    }
  }, [refreshLocations])

  async function handleLogout() {
    try {
      await logout()
    } catch {
      // Local auth state still clears if the API is unavailable.
    }
    navigate('/login', { replace: true })
  }

  function selectAgent(agentId: string) {
    setSelectedAgentId(agentId)
  }

  const visibleLocations = useMemo(() => {
    const term = search.trim().replace(/\s+/g, ' ').toLowerCase()
    return locations.filter((location) => {
      const name = location.agent.name.trim().replace(/\s+/g, ' ').toLowerCase()
      const agentCode = location.agent.agentCode.trim().toLowerCase()
      const matchesSearch = !term || name.includes(term) || agentCode.includes(term)
      const matchesStatus = !statusFilter || location.agent.status === statusFilter
      return matchesSearch && matchesStatus
    })
  }, [locations, search, statusFilter])

  const selectedLocation = locations.find((location) => location.agentId === selectedAgentId) ?? null
  const visibleSelectedLocation = visibleLocations.find((location) => location.agentId === selectedAgentId) ?? null
  const staleCount = locations.filter(isLocationStale).length
  const availableCount = locations.filter((location) => location.agent.status === 'available').length
  const onDutyCount = locations.filter((location) => location.agent.status === 'on_duty').length
  const metrics = [
    { label: 'Agents reporting', value: locations.length, icon: MapPin },
    { label: 'Available', value: availableCount, icon: Truck },
    { label: 'On duty', value: onDutyCount, icon: Navigation },
    { label: 'Stale locations', value: staleCount, icon: Clock3, stale: staleCount > 0 },
  ]

  return (
    <div className="app-shell">
      {user && <DashboardSidebar user={user} activePage="liveFleet" menuOpen={menuOpen} onMenuClose={() => setMenuOpen(false)} onLogout={() => void handleLogout()} />}
      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-toggle" type="button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>Live fleet</strong></div>
          <div className="topbar-actions"><div className="environment-pill"><i /> Operations</div><div className="top-avatar">{user?.name.slice(0, 1).toUpperCase()}</div></div>
        </header>

        <div className="content-wrap live-fleet-content">
          <section className="live-fleet-heading">
            <div><div className="eyebrow">FLEET OPERATIONS <span className="eyebrow-dot" /> LIVE TRACKING</div><h1>Live Fleet</h1><p className="page-subtitle">Latest reported agent locations and current fleet status.</p></div>
            <div className="live-fleet-refresh"><div className="live-fleet-refreshed">{lastRefreshAt ? <>Last refreshed <strong>{formatDate(lastRefreshAt.toISOString())}</strong></> : 'Waiting for first update'}</div><button className="dispatch-create-button" type="button" onClick={() => void refreshLocations()} disabled={isRefreshing}><RefreshCw size={15} className={isRefreshing ? 'refresh-spinning' : ''} />{isRefreshing ? 'Refreshing…' : 'Refresh'}</button></div>
          </section>

          {loadError && <div className="live-fleet-alert" role="alert"><span>{locations.length ? `Could not refresh locations: ${loadError}` : loadError}</span><button type="button" onClick={() => void refreshLocations()} disabled={isRefreshing}>{locations.length ? 'Retry' : 'Try again'}</button></div>}

          <section className="live-fleet-metrics" aria-label="Fleet location summary">
            {metrics.map(({ label, value, icon: Icon, stale }) => <article className={`live-fleet-metric ${stale ? 'metric-stale' : ''}`} key={label}><span className="live-fleet-metric-icon"><Icon size={16} /></span><div><span>{label}</span><strong>{isLoading ? '—' : value}</strong></div></article>)}
          </section>

          <section className="live-fleet-layout">
            <div className="live-fleet-map-panel">
              <header className="live-fleet-panel-heading"><div><h2>Agent locations</h2><span>{visibleLocations.length} of {locations.length} agents shown</span></div><span className="live-fleet-refreshing">{isRefreshing && <><i /> Updating</>}</span></header>
              {isLoading && !locations.length ? <div className="live-fleet-map-state"><span className="spinner spinner-small" /> Loading agent locations…</div> : loadError && !lastRefreshAt ? <div className="live-fleet-map-state live-fleet-map-error"><strong>Location data is unavailable</strong><button type="button" onClick={() => void refreshLocations()}>Retry</button></div> : !locations.length ? <div className="live-fleet-map-state"><span className="live-fleet-empty-icon"><MapPin size={20} /></span><strong>No agent locations yet</strong><p>Agent locations will appear here after a device submits GPS data.</p></div> : !visibleLocations.length ? <div className="live-fleet-map-state"><span className="live-fleet-empty-icon"><Search size={20} /></span><strong>No agents match these filters</strong><p>Try a different name, code, or status.</p></div> : (
                <div className="live-fleet-map">
                  <MapContainer center={[20, 0]} zoom={2} scrollWheelZoom zoomControl={false}>
                    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                    <ZoomControl position="bottomright" />
                    <MapViewport locations={visibleLocations} selectedLocation={visibleSelectedLocation} />
                    {visibleLocations.map((location) => <Marker key={location.agentId} position={[location.latitude, location.longitude]} icon={location.agentId === selectedAgentId ? selectedMarkerIcons[location.agent.status] : markerIcons[location.agent.status]} eventHandlers={{ click: () => selectAgent(location.agentId) }}>
                      <Popup><AgentPopup location={location} /></Popup>
                    </Marker>)}
                  </MapContainer>
                </div>
              )}
              <div className="live-fleet-map-legend"><span><i className="legend-available" /> Available</span><span><i className="legend-on-duty" /> On duty</span><span><i className="legend-other" /> Other status</span></div>
            </div>

            <aside className="live-fleet-list-panel">
              <header className="live-fleet-panel-heading"><div><h2>Agents</h2><span>{visibleLocations.length} agents match</span></div><Truck size={16} /></header>
              <div className="live-fleet-filters"><label className="dispatch-search"><Search size={15} /><span className="visually-hidden">Search agents</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or agent code" /></label><label><span className="visually-hidden">Filter by status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AgentStatus | '')}><option value="">All statuses</option>{agentStatuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label></div>
              {selectedLocation && <SelectedAgentDetails location={selectedLocation} />}
              <div className="live-fleet-agent-list">
                {isLoading && !locations.length ? <div className="live-fleet-list-state"><span className="spinner spinner-small" /> Loading agents…</div> : loadError && !locations.length ? <div className="live-fleet-list-state">Location data is unavailable. Use Retry above.</div> : !locations.length ? <div className="live-fleet-list-state">No agents have reported a location.</div> : !visibleLocations.length ? <div className="live-fleet-list-state">No agents found. Try another search or status.</div> : visibleLocations.map((location) => <button type="button" key={location.agentId} aria-pressed={location.agentId === selectedAgentId} className={`live-fleet-agent-row ${location.agentId === selectedAgentId ? 'selected' : ''}`} onClick={() => selectAgent(location.agentId)}>
                  <span className={`live-fleet-agent-dot status-${location.agent.status}`} />
                  <span className="live-fleet-agent-copy"><strong>{location.agent.name}</strong><small>{location.agent.agentCode} · {location.agent.vehicle.vehicleType} · {location.agent.vehicle.registrationNumber}</small><small className={isLocationStale(location) ? 'stale-text' : ''}>{isLocationStale(location) ? 'Stale · ' : ''}GPS {formatAge(location.recordedAt)}</small></span>
                  <span className={`live-fleet-status status-${location.agent.status}`}>{statusLabels[location.agent.status]}</span>
                </button>)}
              </div>
            </aside>
          </section>
          <footer className="page-footer"><span>SWERV</span><span>Location times use the GPS recorded time; refresh time is shown above.</span></footer>
        </div>
      </main>
    </div>
  )
}

function MapViewport({ locations, selectedLocation }: { locations: AgentLocation[]; selectedLocation: AgentLocation | null }) {
  const map = useMap()
  const previousSelection = useRef('')
  const previousAgentIds = useRef('')

  useEffect(() => {
    if (selectedLocation) {
      if (previousSelection.current !== selectedLocation.agentId) {
        map.flyTo([selectedLocation.latitude, selectedLocation.longitude], Math.max(map.getZoom(), 13), { duration: 0.5 })
      }
      previousSelection.current = selectedLocation.agentId
      return
    }

    const agentIds = locations.map((location) => location.agentId).sort().join(',')
    if (locations.length && (previousSelection.current || previousAgentIds.current !== agentIds)) {
      const bounds = L.latLngBounds(locations.map((location) => [location.latitude, location.longitude] as [number, number]))
      map.fitBounds(bounds, { padding: [38, 38], maxZoom: 13 })
    }
    previousSelection.current = ''
    previousAgentIds.current = agentIds
  }, [locations, map, selectedLocation])

  return null
}

function AgentPopup({ location }: { location: AgentLocation }) {
  return <div className="live-fleet-popup"><strong>{location.agent.name}</strong><span>{location.agent.agentCode} · {statusLabels[location.agent.status]}</span><span>{location.agent.vehicle.vehicleType} · {location.agent.vehicle.registrationNumber}</span><span>Coordinates: {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</span><span>Speed: {location.speed == null ? '—' : `${location.speed.toFixed(1)} m/s`} · Accuracy: {location.accuracy == null ? '—' : `${Math.round(location.accuracy)} m`}</span><span>GPS recorded: {formatDate(location.recordedAt)}</span></div>
}

function SelectedAgentDetails({ location }: { location: AgentLocation }) {
  const stale = isLocationStale(location)
  return <section className="live-fleet-selected-details"><div className="live-fleet-selected-heading"><div><span className="eyebrow">SELECTED AGENT</span><h3>{location.agent.name}</h3><span>{location.agent.agentCode} · {location.agent.vehicle.manufacturer} {location.agent.vehicle.model}</span></div><span className={`live-fleet-status status-${location.agent.status}`}>{statusLabels[location.agent.status]}</span></div><div className="live-fleet-location-facts"><div><small>GPS recorded</small><strong className={stale ? 'stale-text' : ''}>{formatDate(location.recordedAt)}{stale && ' · Stale'}</strong></div><div><small>Received by server</small><strong>{formatDate(location.receivedAt)}</strong></div><div><small>Coordinates</small><strong>{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</strong></div><div><small>Speed / accuracy</small><strong>{location.speed == null ? '—' : `${location.speed.toFixed(1)} m/s`} / {location.accuracy == null ? '—' : `${Math.round(location.accuracy)} m`}</strong></div></div></section>
}

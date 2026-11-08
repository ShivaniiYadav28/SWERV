import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Edit3,
  Menu,
  Plus,
  RotateCcw,
  Search,
  Truck,
  X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { archiveAgent, getAgent, getAgents, restoreAgent, saveAgent, setAgentStatus, type AgentFilters, type AgentPage } from '../lib/agents'
import { useAuth } from '../hooks/useAuth'
import type { Agent, AgentActivity, AgentCapability, AgentInput, AgentStatus, VehicleType } from '../types/agent'
import '../App.css'
import './fleet-agents.css'

const capabilityOptions: { value: AgentCapability; label: string }[] = [
  { value: 'parcel_delivery', label: 'Parcel delivery' },
  { value: 'food_delivery', label: 'Food delivery' },
  { value: 'document_delivery', label: 'Document delivery' },
  { value: 'heavy_goods', label: 'Heavy goods' },
  { value: 'express_delivery', label: 'Express delivery' },
]
const vehicleOptions: { value: VehicleType; label: string }[] = [
  { value: 'car', label: 'Car' },
  { value: 'van', label: 'Van' },
  { value: 'motorcycle', label: 'Motorcycle' },
  { value: 'truck', label: 'Truck' },
  { value: 'bicycle', label: 'Bicycle' },
]
const statusLabels: Record<AgentStatus, string> = {
  available: 'Available',
  unavailable: 'Unavailable',
  on_duty: 'On duty',
  suspended: 'Suspended',
}
const initialFilters: AgentFilters = {
  page: 1,
  limit: 10,
  search: '',
  status: '',
  vehicleType: '',
  capability: '',
  isActive: true,
}

function emptyAgentInput(): AgentInput {
  return {
    name: '',
    email: '',
    phone: '',
    vehicle: { vehicleType: 'van', registrationNumber: '', manufacturer: '', model: '' },
    capacity: { maxOrders: 1 },
    capabilities: [],
  }
}

function getStatusOptions(status: AgentStatus, isAdmin: boolean): AgentStatus[] {
  const transitions: Record<AgentStatus, AgentStatus[]> = {
    available: ['unavailable', 'on_duty', 'suspended'],
    unavailable: ['available', 'suspended'],
    on_duty: ['available', 'unavailable', 'suspended'],
    suspended: ['unavailable'],
  }
  if (status === 'suspended' && !isAdmin) return []
  return transitions[status].filter(
    (nextStatus) => isAdmin || nextStatus !== 'suspended',
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export function FleetAgentsPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin'
  const [menuOpen, setMenuOpen] = useState(false)
  const [filters, setFilters] = useState(initialFilters)
  const [directory, setDirectory] = useState<AgentPage | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const latestListRequest = useRef(0)
  const [loadError, setLoadError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [activity, setActivity] = useState<AgentActivity[]>([])
  const [detailError, setDetailError] = useState('')
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [editor, setEditor] = useState<{ agent?: Agent; input: AgentInput } | null>(null)
  const [formError, setFormError] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [nextStatus, setNextStatus] = useState<AgentStatus | ''>('')
  const [statusError, setStatusError] = useState('')
  const [isChangingStatus, setIsChangingStatus] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [isArchiving, setIsArchiving] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const [isRestoring, setIsRestoring] = useState(false)

  const loadDirectory = useCallback(async () => {
    const requestNumber = ++latestListRequest.current
    setIsLoading(true)
    setLoadError('')
    try {
      const result = await getAgents(filters)
      if (requestNumber === latestListRequest.current) setDirectory(result)
    } catch (error) {
      if (requestNumber === latestListRequest.current) {
        setDirectory(null)
        setLoadError(error instanceof Error ? error.message : 'Could not load agents.')
      }
    } finally {
      if (requestNumber === latestListRequest.current) setIsLoading(false)
    }
  }, [filters])

  useEffect(() => {
    const request = window.setTimeout(() => void loadDirectory(), 0)
    return () => window.clearTimeout(request)
  }, [loadDirectory, refreshKey])

  async function openDetails(agent: Agent) {
    setSelectedAgent(agent)
    setActivity([])
    setDetailError('')
    setIsLoadingDetail(true)
    setNextStatus('')
    setStatusError('')
    setArchiveError('')
    setRestoreError('')
    try {
      const details = await getAgent(agent._id)
      setSelectedAgent(details.agent)
      setActivity(details.activity)
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'Could not load agent details.')
    } finally {
      setIsLoadingDetail(false)
    }
  }

  async function handleLogout() {
    try {
      await logout()
    } catch {
      // The local session is cleared even if the API cannot be reached.
    } finally {
      navigate('/login', { replace: true })
    }
  }

  function changeFilter(name: 'status' | 'vehicleType' | 'capability' | 'isActive', value: string | boolean) {
    setFilters((current) => ({ ...current, [name]: value, page: 1 }))
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    setFormError('')
    setIsSaving(true)
    try {
      const response = await saveAgent(editor.input, editor.agent?._id)
      const editedAgent = editor.agent
      const shouldRefreshDetails = editedAgent && selectedAgent?._id === editedAgent._id
      setEditor(null)
      setRefreshKey((key) => key + 1)
      if (shouldRefreshDetails && response.data?.agent) {
        setSelectedAgent(response.data.agent)
        try {
          const details = await getAgent(editedAgent._id)
          setSelectedAgent(details.agent)
          setActivity(details.activity)
          setDetailError('')
        } catch (error) {
          setDetailError(error instanceof Error ? error.message : 'Agent was saved, but its activity could not be refreshed.')
        }
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not save agent.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleStatusChange() {
    if (!selectedAgent || !nextStatus) return
    setStatusError('')
    setIsChangingStatus(true)
    try {
      await setAgentStatus(selectedAgent._id, nextStatus)
      setNextStatus('')
      await openDetails(selectedAgent)
      setRefreshKey((key) => key + 1)
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not update agent status.')
    } finally {
      setIsChangingStatus(false)
    }
  }

  async function handleArchive() {
    if (!selectedAgent || !window.confirm(`Archive ${selectedAgent.name}?`)) return
    setArchiveError('')
    setIsArchiving(true)
    try {
      await archiveAgent(selectedAgent._id)
      setSelectedAgent(null)
      setRefreshKey((key) => key + 1)
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'Could not archive agent.')
    } finally {
      setIsArchiving(false)
    }
  }

  async function handleRestore() {
    if (!selectedAgent) return
    setRestoreError('')
    setIsRestoring(true)
    try {
      await restoreAgent(selectedAgent._id)
      setSelectedAgent(null)
      setFilters((current) => ({ ...current, isActive: true, page: 1 }))
      setRefreshKey((key) => key + 1)
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : 'Could not restore agent.')
    } finally {
      setIsRestoring(false)
    }
  }

  function startEdit(agent: Agent) {
    setFormError('')
    setEditor({
      agent,
      input: {
        name: agent.name,
        email: agent.email,
        phone: agent.phone,
        vehicle: { ...agent.vehicle },
        capacity: { ...agent.capacity },
        capabilities: [...agent.capabilities],
      },
    })
  }

  const page = directory?.pagination.page ?? filters.page
  const pageCount = directory?.pagination.pages ?? 0

  return (
    <div className="app-shell">
      {user && (
        <DashboardSidebar
          user={user}
          activePage="agents"
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
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>Fleet agents</strong></div>
          <div className="topbar-actions">
            <div className="environment-pill"><i /> Operations</div>
            <div className="top-avatar">{user?.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</div>
          </div>
        </header>

        <div className="content-wrap agents-content">
          <section className="agents-heading">
            <div>
              <div className="eyebrow">FLEET OPERATIONS <span className="eyebrow-dot" /> DIRECTORY</div>
              <h1>Fleet agents</h1>
              <p className="page-subtitle">Manage your people, vehicles and operational status.</p>
            </div>
            {isAdmin && <button className="agent-primary-button" type="button" onClick={() => { setFormError(''); setEditor({ input: emptyAgentInput() }) }}><Plus size={17} /> Add agent</button>}
          </section>

          <section className="agents-panel panel">
            <div className="agents-toolbar">
              <label className="agent-search">
                <Search size={16} />
                <span className="visually-hidden">Search agents</span>
                <input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, page: 1, search: event.target.value }))} placeholder="Search name, email or agent code" />
              </label>
              <div className="agent-filters">
                <label><span className="visually-hidden">Status</span><select value={filters.status} onChange={(event) => changeFilter('status', event.target.value)}><option value="">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                <label><span className="visually-hidden">Vehicle type</span><select value={filters.vehicleType} onChange={(event) => changeFilter('vehicleType', event.target.value)}><option value="">All vehicles</option>{vehicleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label><span className="visually-hidden">Capability</span><select value={filters.capability} onChange={(event) => changeFilter('capability', event.target.value)}><option value="">All capabilities</option>{capabilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label><span className="visually-hidden">Agent activity</span><select value={String(filters.isActive)} onChange={(event) => changeFilter('isActive', event.target.value === 'true')}><option value="true">Active agents</option><option value="false">Archived agents</option></select></label>
              </div>
            </div>

            {loadError && <div className="agent-alert" role="alert">{loadError}<button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Try again</button></div>}
            <div className="agents-table-wrap">
              <table className="agents-table">
                <thead><tr><th>Agent</th><th>Vehicle</th><th>Capacity</th><th>Status</th><th>Joined</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
                <tbody>
                  {isLoading ? <tr><td colSpan={6}><div className="agent-loading"><span className="spinner spinner-small" /> Loading agents…</div></td></tr> : directory?.agents.length ? directory.agents.map((agent) => (
                    <tr key={agent._id}>
                      <td><button type="button" className="agent-identity" onClick={() => void openDetails(agent)}><span className="agent-avatar">{agent.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span><span><strong>{agent.name}</strong><small>{agent.agentCode} · {agent.email}</small></span></button></td>
                      <td><span className="vehicle-name"><Truck size={14} /> {agent.vehicle.manufacturer} {agent.vehicle.model}</span><small className="table-subtext">{agent.vehicle.registrationNumber} · {agent.vehicle.vehicleType}</small></td>
                      <td>{agent.capacity.maxOrders} orders</td>
                      <td><span className={`agent-status status-${agent.status}`}><i />{statusLabels[agent.status]}</span></td>
                      <td>{new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(agent.createdAt))}</td>
                      <td><button type="button" className="agent-row-action" onClick={() => void openDetails(agent)}>View <ChevronRight size={15} /></button></td>
                    </tr>
                  )) : <tr><td colSpan={6}><div className="agent-empty"><span className="agent-empty-icon"><Truck size={21} /></span><strong>{filters.isActive ? 'No agents found' : 'No archived agents found'}</strong><p>{filters.search || filters.status || filters.vehicleType || filters.capability ? 'Try changing or clearing your filters.' : isAdmin ? 'Add your first fleet agent to get started.' : 'Agents will appear here when they are registered.'}</p>{isAdmin && filters.isActive && !filters.search && <button className="agent-secondary-button" type="button" onClick={() => { setFormError(''); setEditor({ input: emptyAgentInput() }) }}><Plus size={15} /> Add agent</button>}</div></td></tr>}
                </tbody>
              </table>
            </div>

            <div className="agents-pagination"><span>{directory?.pagination.total ?? 0} agents</span><div><span>Page {page} of {Math.max(pageCount, 1)}</span><button type="button" aria-label="Previous page" disabled={page <= 1 || isLoading} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}><ChevronLeft size={16} /></button><button type="button" aria-label="Next page" disabled={pageCount === 0 || page >= pageCount || isLoading} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}><ChevronRight size={16} /></button></div></div>
          </section>

          <footer className="page-footer"><span>SWERV</span><span>Fleet agent directory</span></footer>
        </div>
      </main>

      {editor && <div className="agent-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null) }}><section className="agent-dialog agent-form-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-form-title"><header className="agent-dialog-heading"><div><div className="eyebrow">FLEET OPERATIONS</div><h2 id="agent-form-title">{editor.agent ? 'Edit agent' : 'Register agent'}</h2></div><button type="button" aria-label="Close" className="agent-close-button" onClick={() => setEditor(null)}><X size={18} /></button></header><form className="agent-form" onSubmit={(event) => void handleSave(event)}>
        <div className="agent-form-section"><h3>Personal information</h3><div className="agent-form-grid"><label>Full name<input required minLength={2} maxLength={100} value={editor.input.name} onChange={(event) => setEditor({ ...editor, input: { ...editor.input, name: event.target.value } })} /></label><label>Email address<input required type="email" maxLength={254} value={editor.input.email} onChange={(event) => setEditor({ ...editor, input: { ...editor.input, email: event.target.value } })} /></label><label>Phone number<input required minLength={7} maxLength={24} value={editor.input.phone} onChange={(event) => setEditor({ ...editor, input: { ...editor.input, phone: event.target.value } })} /></label></div></div>
        <div className="agent-form-section"><h3>Vehicle information</h3><div className="agent-form-grid"><label>Vehicle type<select value={editor.input.vehicle.vehicleType} onChange={(event) => setEditor({ ...editor, input: { ...editor.input, vehicle: { ...editor.input.vehicle, vehicleType: event.target.value as VehicleType } } })}>{vehicleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>Registration number<input required minLength={2} maxLength={20} value={editor.input.vehicle.registrationNumber} onChange={(event) => setEditor({ ...editor, input: { ...editor.input, vehicle: { ...editor.input.vehicle, registrationNumber: event.target.value } } })} /></label><label>Manufacturer<input required maxLength={60} value={editor.input.vehicle.manufacturer} onChange={(event) => setEditor({ ...editor, input: { ...editor.input, vehicle: { ...editor.input.vehicle, manufacturer: event.target.value } } })} /></label><label>Model<input required maxLength={60} value={editor.input.vehicle.model} onChange={(event) => setEditor({ ...editor, input: { ...editor.input, vehicle: { ...editor.input.vehicle, model: event.target.value } } })} /></label><label>Maximum orders<input required type="number" min={1} max={10000} value={editor.input.capacity.maxOrders} onChange={(event) => setEditor({ ...editor, input: { ...editor.input, capacity: { maxOrders: Number(event.target.value) } } })} /></label></div></div>
        <fieldset className="agent-capabilities"><legend>Delivery capabilities</legend><div>{capabilityOptions.map((option) => <label key={option.value}><input type="checkbox" checked={editor.input.capabilities.includes(option.value)} onChange={(event) => setEditor({ ...editor, input: { ...editor.input, capabilities: event.target.checked ? [...editor.input.capabilities, option.value] : editor.input.capabilities.filter((value) => value !== option.value) } })} />{option.label}</label>)}</div></fieldset>
        {formError && <div className="agent-alert" role="alert">{formError}</div>}<div className="agent-form-actions"><button className="agent-secondary-button" type="button" onClick={() => setEditor(null)}>Cancel</button><button className="agent-primary-button" disabled={isSaving} type="submit">{isSaving ? 'Saving…' : editor.agent ? 'Save changes' : 'Register agent'}</button></div>
      </form></section></div>}

      {selectedAgent && !editor && <div className="agent-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedAgent(null) }}><section className="agent-dialog agent-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-detail-title"><header className="agent-dialog-heading"><button type="button" className="agent-back-button" onClick={() => setSelectedAgent(null)}><ArrowLeft size={16} /> Back to agents</button><button type="button" aria-label="Close details" className="agent-close-button" onClick={() => setSelectedAgent(null)}><X size={18} /></button></header>
        {detailError && <div className="agent-alert" role="alert">{detailError}<button type="button" onClick={() => void openDetails(selectedAgent)}>Try again</button></div>}
        {isLoadingDetail ? <div className="agent-loading detail-loading"><span className="spinner spinner-small" /> Loading agent details…</div> : <>
          <div className="agent-detail-hero"><div className="agent-avatar agent-avatar-large">{selectedAgent.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</div><div><span className="agent-code">{selectedAgent.agentCode}</span><h2 id="agent-detail-title">{selectedAgent.name}</h2><p>{selectedAgent.email} <span>·</span> {selectedAgent.phone}</p></div><span className={`agent-status status-${selectedAgent.status}`}><i />{statusLabels[selectedAgent.status]}</span></div>
          <div className="agent-detail-grid"><article className="agent-info-card"><h3>Vehicle</h3><div className="detail-value"><Truck size={17} /><span><strong>{selectedAgent.vehicle.manufacturer} {selectedAgent.vehicle.model}</strong><small>{selectedAgent.vehicle.registrationNumber}</small></span></div><div className="detail-pair"><span>Type</span><strong>{selectedAgent.vehicle.vehicleType}</strong></div><div className="detail-pair"><span>Capacity</span><strong>{selectedAgent.capacity.maxOrders} orders</strong></div><div className="detail-pair"><span>Joined</span><strong>{new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(selectedAgent.createdAt))}</strong></div></article><article className="agent-info-card"><h3>Capabilities</h3><div className="capability-chips">{selectedAgent.capabilities.length ? selectedAgent.capabilities.map((capability) => <span key={capability}>{capabilityOptions.find((option) => option.value === capability)?.label ?? capability}</span>) : <p>No capabilities listed.</p>}</div></article></div>
          {selectedAgent.isActive && <section className="agent-status-controls"><div><h3>Operational status</h3><p>Choose a permitted next status for this agent.</p></div><div className="status-control-actions"><select aria-label="New status" value={nextStatus} onChange={(event) => setNextStatus(event.target.value as AgentStatus | '')}><option value="">Select status</option>{getStatusOptions(selectedAgent.status, Boolean(isAdmin)).map((status) => <option value={status} key={status}>{statusLabels[status]}</option>)}</select><button className="agent-secondary-button" type="button" disabled={!nextStatus || isChangingStatus} onClick={() => void handleStatusChange()}>{isChangingStatus ? 'Updating…' : 'Update status'}</button></div>{statusError && <div className="agent-alert" role="alert">{statusError}</div>}</section>}
          <section className="agent-activity"><div className="agent-section-heading"><div><h3>Activity history</h3><p>Recent updates for this agent</p></div><Clock3 size={17} /></div>{activity.length ? <ol>{activity.map((event) => <li key={event._id}><span className="activity-dot" /><div><strong>{event.description}</strong><span>{typeof event.performedBy === 'string' ? 'SWERV user' : event.performedBy.name} · {formatDate(event.createdAt)}</span></div></li>)}</ol> : <p className="agent-activity-empty">No activity has been recorded yet.</p>}</section>
          {isAdmin && <div className="agent-detail-actions">{selectedAgent.isActive ? <><button type="button" className="agent-secondary-button" onClick={() => startEdit(selectedAgent)}><Edit3 size={15} /> Edit details</button><button type="button" className="agent-danger-button" disabled={isArchiving} onClick={() => void handleArchive()}><Archive size={15} /> {isArchiving ? 'Archiving…' : 'Archive agent'}</button></> : <button type="button" className="agent-primary-button" disabled={isRestoring} onClick={() => void handleRestore()}><RotateCcw size={15} /> {isRestoring ? 'Restoring…' : 'Restore agent'}</button>}</div>}{archiveError && <div className="agent-alert" role="alert">{archiveError}</div>}{restoreError && <div className="agent-alert" role="alert">{restoreError}</div>}
        </>}
      </section></div>}
    </div>
  )
}

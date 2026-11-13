import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Mail,
  Menu,
  Package,
  MapPin,
  Plus,
  Search,
  Sparkles,
  Truck,
  Phone,
  X,
} from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { LocationMapPicker, type MapPoint } from '../components/LocationMapPicker'
import {
  assignDispatchAgent,
  createDispatchRequest,
  getDispatchRequests,
  getDispatchRequest,
  getAgentRecommendations,
  requestDemoDeliveryTimePrediction,
  updateDispatchRequestStatus,
  updateDispatchRequestCoordinates,
  type DispatchRequestFilters,
  type DispatchRequestPage,
} from '../lib/dispatchRequests'
import { ApiError } from '../lib/api'
import { getAgents } from '../lib/agents'
import { useAuth } from '../hooks/useAuth'
import type {
  DispatchPriority,
  DispatchContact,
  DispatchLocation,
  DispatchRequest,
  DispatchRequestDetails,
  DispatchRequestStatus,
  AgentRecommendation,
  AgentRecommendationResult,
  CreateDispatchRequestInput,
  PackageCategory,
  DemoDeliveryTimePrediction,
} from '../types/dispatchRequest'
import type { Agent } from '../types/agent'
import { getCustomers } from '../lib/customers'
import { updateDispatchLocationPoint } from '../lib/dispatchCoordinateSelection'
import type { Customer } from '../types/customer'
import '../App.css'
import './dispatch-requests.css'
import { connectRealtime, dispatchUpdateEvent } from '../lib/realtime'

const statusOptions: { value: DispatchRequestStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'picked_up', label: 'Picked up' },
  { value: 'in_transit', label: 'In transit' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed', label: 'Failed' },
]

const priorityOptions: { value: DispatchPriority; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'express', label: 'Express' },
  { value: 'urgent', label: 'Urgent' },
]

const packageCategories: { value: PackageCategory; label: string }[] = [
  { value: 'documents', label: 'Documents' },
  { value: 'parcel', label: 'Parcel' },
  { value: 'food', label: 'Food' },
  { value: 'fragile', label: 'Fragile' },
  { value: 'heavy_goods', label: 'Heavy goods' },
  { value: 'other', label: 'Other' },
]

const statusLabels: Record<DispatchRequestStatus, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  picked_up: 'Picked up',
  in_transit: 'In transit',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  failed: 'Failed',
}

const statusTransitions: Record<DispatchRequestStatus, DispatchRequestStatus[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['picked_up', 'cancelled'],
  picked_up: ['in_transit', 'failed'],
  in_transit: ['failed'],
  delivered: [],
  cancelled: [],
  failed: [],
}

const initialFilters: DispatchRequestFilters = {
  page: 1,
  limit: 10,
  status: '',
  priority: '',
}

type PredictionState =
  | { status: 'idle' | 'loading' }
  | { status: 'success'; prediction: DemoDeliveryTimePrediction }
  | { status: 'unavailable' | 'ineligible' | 'error'; message: string }

type StoredPredictionState = {
  requestKey: string
  state: PredictionState
}

type RecommendationState =
  | { status: 'idle' | 'loading' }
  | { status: 'success'; result: AgentRecommendationResult }
  | { status: 'error'; message: string }

type StoredRecommendationState = {
  requestId: string
  state: RecommendationState
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatCategory(value: string) {
  return value.replaceAll('_', ' ')
}

function assignedAgentName(request: DispatchRequest) {
  return request.assignedAgent?.name ?? null
}

function locationSummary(location: DispatchRequest['pickup']) {
  return [location.address, location.addressLine2, location.city, location.region]
    .filter(Boolean)
    .join(', ')
}

export function DispatchRequestsPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [menuOpen, setMenuOpen] = useState(false)
  const [filters, setFilters] = useState(initialFilters)
  const [search, setSearch] = useState('')
  const [pageData, setPageData] = useState<DispatchRequestPage | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const latestRequest = useRef(0)
  const selectedRequestId = searchParams.get('dispatchId') ?? ''
  const [requestDetails, setRequestDetails] = useState<DispatchRequestDetails | null>(null)
  const [isLoadingDetails, setIsLoadingDetails] = useState(Boolean(searchParams.get('dispatchId')))
  const [detailsError, setDetailsError] = useState('')
  const [detailsErrorId, setDetailsErrorId] = useState('')
  const [detailsRetry, setDetailsRetry] = useState(0)
  const latestDetailsRequest = useRef(0)

  function setDispatchIdInUrl(id: string) {
    setSearchParams({ dispatchId: id })
  }

  const closeRequestDetails = useCallback(() => {
    if (searchParams.has('dispatchId')) {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.delete('dispatchId')
      setSearchParams(nextParams, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const loadRequests = useCallback(async () => {
    const requestNumber = ++latestRequest.current
    setIsLoading(true)
    setLoadError('')

    try {
      const result = await getDispatchRequests(filters)
      if (requestNumber === latestRequest.current) setPageData(result)
    } catch (error) {
      if (requestNumber === latestRequest.current) {
        setPageData(null)
        setLoadError(
          error instanceof Error
            ? error.message
            : 'Dispatch requests could not be loaded.',
        )
      }
    } finally {
      if (requestNumber === latestRequest.current) setIsLoading(false)
    }
  }, [filters])

  useEffect(() => {
    const request = window.setTimeout(() => void loadRequests(), 0)
    return () => window.clearTimeout(request)
  }, [loadRequests, reloadKey])

  useEffect(() => {
    const socket = connectRealtime()
    const onDispatchUpdate = () => setReloadKey((current) => current + 1)
    socket.on(dispatchUpdateEvent, onDispatchUpdate)
    return () => {
      socket.off(dispatchUpdateEvent, onDispatchUpdate)
      socket.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!selectedRequestId) return
    const requestNumber = ++latestDetailsRequest.current

    void getDispatchRequest(selectedRequestId)
      .then((details) => {
        if (requestNumber === latestDetailsRequest.current) setRequestDetails(details)
      })
      .catch((error: unknown) => {
        if (requestNumber === latestDetailsRequest.current) {
          setDetailsError(error instanceof Error ? error.message : 'Request details could not be loaded.')
          setDetailsErrorId(selectedRequestId)
        }
      })
      .finally(() => {
        if (requestNumber === latestDetailsRequest.current) setIsLoadingDetails(false)
      })

    return () => {
      latestDetailsRequest.current += 1
    }
  }, [selectedRequestId, detailsRetry])

  function openRequestDetails(id: string) {
    setRequestDetails(null)
    setDetailsError('')
    setDetailsErrorId('')
    setIsLoadingDetails(true)
    setDispatchIdInUrl(id)
  }

  function retryRequestDetails() {
    setRequestDetails(null)
    setDetailsError('')
    setIsLoadingDetails(true)
    setDetailsRetry((retry) => retry + 1)
  }

  function handleRequestUpdated(message: string) {
    setSuccessMessage(message)
    setRequestDetails(null)
    setDetailsError('')
    setIsLoadingDetails(true)
    setDetailsRetry((retry) => retry + 1)
    setReloadKey((key) => key + 1)
  }

  useEffect(() => {
    if (!selectedRequestId) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRequestDetails()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [selectedRequestId, closeRequestDetails])

  async function handleLogout() {
    try {
      await logout()
    } catch {
      // The local session is cleared even if the API cannot be reached.
    } finally {
      navigate('/login', { replace: true })
    }
  }

  function updateFilter(name: 'status' | 'priority', value: string) {
    setSuccessMessage('')
    setFilters((current) => ({
      ...current,
      [name]: value,
      page: 1,
    }))
  }

  async function handleCreateRequest(input: CreateDispatchRequestInput) {
    setCreateError('')
    setIsCreating(true)
    try {
      await createDispatchRequest(input)
      setCreateOpen(false)
      setCreateError('')
      setSuccessMessage('Dispatch request created successfully.')
      setFilters({ ...initialFilters })
      setSearch('')
      setReloadKey((key) => key + 1)
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : 'The dispatch request could not be created.',
      )
    } finally {
      setIsCreating(false)
    }
  }

  const visibleRequests = useMemo(() => {
    const requests = pageData?.dispatchRequests ?? []
    const term = search.trim().toLowerCase()
    if (!term) return requests

    return requests.filter((request) =>
      [request.customer.name, request.customer.email, request._id]
        .some((value) => value.toLowerCase().includes(term)),
    )
  }, [pageData, search])

  const currentPage = pageData?.pagination.page ?? filters.page
  const totalPages = pageData?.pagination.pages ?? 0

  return (
    <div className="app-shell">
      {user && (
        <DashboardSidebar
          user={user}
          activePage="dispatch"
          menuOpen={menuOpen}
          onMenuClose={() => setMenuOpen(false)}
          onLogout={() => void handleLogout()}
        />
      )}

      <main className="main-area">
        <header className="topbar">
          <button
            className="icon-button menu-toggle"
            type="button"
            aria-label="Open navigation"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            <span>Workspace</span>
            <span className="crumb-slash">/</span>
            <strong>Dispatch management</strong>
          </div>
          <div className="topbar-actions">
            <div className="environment-pill"><i /> Operations</div>
            <div className="top-avatar">
              {user?.name
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join('')
                .toUpperCase()}
            </div>
          </div>
        </header>

        <div className="content-wrap dispatch-content">
          <section className="dispatch-heading">
            <div>
              <div className="eyebrow">
                FLEET OPERATIONS <span className="eyebrow-dot" /> DISPATCH
              </div>
              <h1>Dispatch Management</h1>
              <p className="page-subtitle">
                Review incoming requests and their current delivery status.
              </p>
            </div>
            <button
              className="dispatch-create-button"
              type="button"
              onClick={() => {
                setCreateError('')
                setCreateOpen(true)
              }}
            >
              <Plus size={16} /> Create Request
            </button>
          </section>

          <section className="dispatch-panel">
            {successMessage && (
              <div className="dispatch-success" role="status">
                <span>{successMessage}</span>
                <button type="button" aria-label="Dismiss success message" onClick={() => setSuccessMessage('')}><X size={15} /></button>
              </div>
            )}
            <div className="dispatch-toolbar">
              <label className="dispatch-search">
                <Search size={16} />
                <span className="visually-hidden">Search this page of requests</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search customer or request ID"
                />
              </label>
              <div className="dispatch-filters">
                <label>
                  <span className="visually-hidden">Filter by status</span>
                  <select
                    value={filters.status}
                    onChange={(event) => updateFilter('status', event.target.value)}
                  >
                    <option value="">All statuses</option>
                    {statusOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="visually-hidden">Filter by priority</span>
                  <select
                    value={filters.priority}
                    onChange={(event) => updateFilter('priority', event.target.value)}
                  >
                    <option value="">All priorities</option>
                    {priorityOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {loadError && (
              <div className="dispatch-alert" role="alert">
                <span>{loadError}</span>
                <button type="button" onClick={() => setReloadKey((key) => key + 1)}>
                  Try again
                </button>
              </div>
            )}

            {isLoading ? (
              <div className="dispatch-state" role="status">
                <span className="spinner spinner-small" /> Loading dispatch requests…
              </div>
            ) : loadError ? null : visibleRequests.length > 0 ? (
              <div className="dispatch-request-list">
                {visibleRequests.map((request) => (
                  <DispatchRequestCard
                    key={request._id}
                    request={request}
                    onOpen={() => openRequestDetails(request._id)}
                  />
                ))}
              </div>
            ) : (
              <div className="dispatch-state dispatch-empty">
                <span className="dispatch-empty-icon"><Package size={21} /></span>
                <strong>
                  {search ? 'No requests match your search' : 'No dispatch requests found'}
                </strong>
                <p>
                  {search
                    ? 'Try a different customer name, email, or request ID.'
                    : 'Requests will appear here when they are submitted.'}
                </p>
              </div>
            )}

            <div className="dispatch-pagination">
              <span>{pageData?.pagination.total ?? 0} requests</span>
              <div>
                <span>
                  Page {currentPage} of {Math.max(totalPages, 1)}
                </span>
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={currentPage <= 1 || isLoading}
                  onClick={() =>
                    setFilters((current) => ({ ...current, page: current.page - 1 }))
                  }
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={totalPages === 0 || currentPage >= totalPages || isLoading}
                  onClick={() =>
                    setFilters((current) => ({ ...current, page: current.page + 1 }))
                  }
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </section>

          <footer className="page-footer">
            <span>SWERV</span>
            <span>Dispatch request directory</span>
          </footer>
        </div>
      </main>
      {createOpen && (
        <CreateRequestDialog
          isCreating={isCreating}
          error={createError}
          onClose={() => {
            if (!isCreating) setCreateOpen(false)
          }}
          onSubmit={(input) => void handleCreateRequest(input)}
        />
      )}
      {selectedRequestId && (
        <DispatchRequestDrawer
          details={requestDetails?.dispatchRequest._id === selectedRequestId ? requestDetails : null}
          isLoading={isLoadingDetails || (!requestDetails?.dispatchRequest || requestDetails.dispatchRequest._id !== selectedRequestId && detailsErrorId !== selectedRequestId)}
          error={detailsErrorId === selectedRequestId ? detailsError : ''}
          canPredict={user?.role === 'admin' || user?.role === 'operator'}
          onClose={closeRequestDetails}
          onRetry={retryRequestDetails}
          onAssigned={() => handleRequestUpdated('Agent assignment updated successfully.')}
          onStatusUpdated={() => handleRequestUpdated('Dispatch request status updated successfully.')}
          onLocationsUpdated={(updatedRequest) => {
            setDetailsError('')
            setRequestDetails((current) => current
              ? {
                ...current,
                dispatchRequest: {
                  ...current.dispatchRequest,
                  pickup: updatedRequest.pickup,
                  delivery: updatedRequest.delivery,
                },
              }
              : current)
          }}
        />
      )}
    </div>
  )
}

type CreateRequestFormState = {
  customer: DispatchContact
  pickup: CreateDispatchRequestInput['pickup']
  delivery: CreateDispatchRequestInput['delivery']
  package: CreateDispatchRequestInput['package']
  priority: CreateDispatchRequestInput['priority']
}

function emptyCreateRequest(): CreateRequestFormState {
  return {
    customer: { name: '', email: '', phone: '' },
    pickup: { address: '', city: '', region: '', postalCode: '', country: '', instructions: '' },
    delivery: { address: '', city: '', region: '', postalCode: '', country: '' },
    package: { description: '', category: 'parcel', weightKg: 0.01, quantity: 1 },
    priority: 'standard',
  }
}

function CreateRequestDialog({
  isCreating,
  error,
  onClose,
  onSubmit,
}: {
  isCreating: boolean
  error: string
  onClose: () => void
  onSubmit: (input: CreateDispatchRequestInput) => void
}) {
  const [input, setInput] = useState(emptyCreateRequest)
  const [customerMode, setCustomerMode] = useState<'existing' | 'manual'>('existing')
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerOptions, setCustomerOptions] = useState<Customer[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [isLoadingCustomers, setIsLoadingCustomers] = useState(true)
  const [customerLoadError, setCustomerLoadError] = useState('')
  const [customerRetry, setCustomerRetry] = useState(0)
  const [selectionError, setSelectionError] = useState('')
  const latestCustomerSearch = useRef(0)

  useEffect(() => {
    if (customerMode !== 'existing') return
    const requestNumber = ++latestCustomerSearch.current
    const timeout = window.setTimeout(() => {
      setIsLoadingCustomers(true)
      setCustomerLoadError('')
      void getCustomers({ page: 1, limit: 100, search: customerSearch, status: 'active' })
        .then((result) => {
          if (requestNumber === latestCustomerSearch.current) setCustomerOptions(result.customers)
        })
        .catch((error: unknown) => {
          if (requestNumber === latestCustomerSearch.current) {
            setCustomerLoadError(error instanceof Error ? error.message : 'Active customers could not be loaded.')
          }
        })
        .finally(() => {
          if (requestNumber === latestCustomerSearch.current) setIsLoadingCustomers(false)
        })
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [customerMode, customerSearch, customerRetry])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSelectionError('')
    if (customerMode === 'existing') {
      if (!selectedCustomer) {
        setSelectionError('Select an active customer, or choose to enter customer details.')
        return
      }
      onSubmit({ customerId: selectedCustomer.id, pickup: input.pickup, delivery: input.delivery, package: input.package, priority: input.priority })
      return
    }
    onSubmit({ customer: input.customer, pickup: input.pickup, delivery: input.delivery, package: input.package, priority: input.priority })
  }

  function updateCustomer(field: keyof DispatchContact, value: string) {
    setInput((current) => ({ ...current, customer: { ...current.customer, [field]: value } }))
  }

  function updateLocation(
    place: 'pickup' | 'delivery',
    field: keyof Pick<DispatchLocation, 'address' | 'addressLine2' | 'city' | 'region' | 'postalCode' | 'country' | 'instructions'>,
    value: string,
  ) {
    setInput((current) => ({ ...current, [place]: { ...current[place], [field]: value } }))
  }

  function updateLocationPoint(place: 'pickup' | 'delivery', point: MapPoint | null) {
    setInput((current) => ({ ...current, ...updateDispatchLocationPoint(current, place, point) }))
  }

  return (
    <div className="dispatch-modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="dispatch-modal" role="dialog" aria-modal="true" aria-labelledby="create-request-title">
        <header className="dispatch-modal-heading">
          <div><span className="eyebrow">FLEET OPERATIONS</span><h2 id="create-request-title">Create dispatch request</h2></div>
          <button className="dispatch-modal-close" type="button" aria-label="Close dialog" onClick={onClose} disabled={isCreating}><X size={18} /></button>
        </header>
        <form className="dispatch-form" onSubmit={handleSubmit}>
          <section className="dispatch-form-section">
            <h3>Customer</h3>
            <div className="customer-mode-toggle" role="group" aria-label="Customer source">
              <button type="button" className={customerMode === 'existing' ? 'selected' : ''} onClick={() => { setCustomerMode('existing'); setSelectionError('') }}>Select existing customer</button>
              <button type="button" className={customerMode === 'manual' ? 'selected' : ''} onClick={() => { setCustomerMode('manual'); setSelectedCustomer(null); setSelectionError('') }}>Enter contact details</button>
            </div>
            {customerMode === 'existing' ? <div className="dispatch-form-grid customer-selection-fields">
              <label className="form-wide">Search active customers<input value={customerSearch} onChange={(event) => { setCustomerSearch(event.target.value); setSelectedCustomer(null); setIsLoadingCustomers(true) }} placeholder="Name, email, or phone" /></label>
              <label className="form-wide">Customer<select value={selectedCustomer?.id ?? ''} onChange={(event) => { setSelectedCustomer(customerOptions.find((customer) => customer.id === event.target.value) ?? null); setSelectionError('') }} disabled={isLoadingCustomers || !!customerLoadError}><option value="">Select a customer</option>{customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · {customer.email} · {customer.phone}</option>)}</select></label>
              {isLoadingCustomers && <p className="customer-select-message">Loading active customers…</p>}
              {customerLoadError && <div className="dispatch-alert form-error" role="alert"><span>{customerLoadError}</span><button type="button" onClick={() => setCustomerRetry((retry) => retry + 1)}>Retry</button></div>}
              {!isLoadingCustomers && !customerLoadError && !customerOptions.length && <p className="customer-select-message">No active customers found. You can enter customer details instead.</p>}
              {selectedCustomer && <p className="customer-selected-summary">Using {selectedCustomer.name} ({selectedCustomer.email}).</p>}
              {selectionError && <p className="customer-select-error" role="alert">{selectionError}</p>}
            </div> : <div className="dispatch-form-grid">
              <label>Name<input required minLength={2} maxLength={100} value={input.customer.name} onChange={(event) => updateCustomer('name', event.target.value)} /></label>
              <label>Email<input required type="email" maxLength={254} value={input.customer.email} onChange={(event) => updateCustomer('email', event.target.value)} /></label>
              <label>Phone<input required minLength={7} maxLength={24} value={input.customer.phone} onChange={(event) => updateCustomer('phone', event.target.value)} /></label>
            </div>}
          </section>
          <section className="dispatch-form-section">
            <h3>Pickup</h3>
            <div className="dispatch-form-grid">
              <label className="form-wide">Address<input required maxLength={240} value={input.pickup.address} onChange={(event) => updateLocation('pickup', 'address', event.target.value)} /></label>
              <label>City<input required maxLength={80} value={input.pickup.city} onChange={(event) => updateLocation('pickup', 'city', event.target.value)} /></label>
              <label>Region / state<input required maxLength={80} value={input.pickup.region} onChange={(event) => updateLocation('pickup', 'region', event.target.value)} /></label>
              <label>Postal code<input required maxLength={20} value={input.pickup.postalCode} onChange={(event) => updateLocation('pickup', 'postalCode', event.target.value)} /></label>
              <label>Country<input required maxLength={80} value={input.pickup.country} onChange={(event) => updateLocation('pickup', 'country', event.target.value)} /></label>
              <label className="form-wide">Instructions (optional)<textarea maxLength={300} value={input.pickup.instructions} onChange={(event) => updateLocation('pickup', 'instructions', event.target.value)} /></label>
            </div>
            <p className="dispatch-coordinate-help">
              Map points are optional. Before assigning an agent, select accurate pickup and destination points when known. Do not guess coordinates from an address; missing points are safer than inaccurate ones.
            </p>
            <LocationMapPicker
              label="Pickup"
              point={input.pickup.latitude != null && input.pickup.longitude != null ? { latitude: input.pickup.latitude, longitude: input.pickup.longitude } : null}
              onChange={(point) => updateLocationPoint('pickup', point)}
            />
          </section>
          <section className="dispatch-form-section">
            <h3>Delivery</h3>
            <div className="dispatch-form-grid">
              <label className="form-wide">Address<input required maxLength={240} value={input.delivery.address} onChange={(event) => updateLocation('delivery', 'address', event.target.value)} /></label>
              <label>City<input required maxLength={80} value={input.delivery.city} onChange={(event) => updateLocation('delivery', 'city', event.target.value)} /></label>
              <label>Region / state<input required maxLength={80} value={input.delivery.region} onChange={(event) => updateLocation('delivery', 'region', event.target.value)} /></label>
              <label>Postal code<input required maxLength={20} value={input.delivery.postalCode} onChange={(event) => updateLocation('delivery', 'postalCode', event.target.value)} /></label>
              <label>Country<input required maxLength={80} value={input.delivery.country} onChange={(event) => updateLocation('delivery', 'country', event.target.value)} /></label>
            </div>
            <LocationMapPicker
              label="Destination"
              point={input.delivery.latitude != null && input.delivery.longitude != null ? { latitude: input.delivery.latitude, longitude: input.delivery.longitude } : null}
              onChange={(point) => updateLocationPoint('delivery', point)}
            />
          </section>
          <section className="dispatch-form-section">
            <h3>Package &amp; priority</h3>
            <div className="dispatch-form-grid">
              <label className="form-wide">Description<input required minLength={2} maxLength={240} value={input.package.description} onChange={(event) => setInput((current) => ({ ...current, package: { ...current.package, description: event.target.value } }))} /></label>
              <label>Category<select value={input.package.category} onChange={(event) => setInput((current) => ({ ...current, package: { ...current.package, category: event.target.value as PackageCategory } }))}>{packageCategories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}</select></label>
              <label>Weight (kg)<input required type="number" min="0.01" max="10000" step="0.01" value={input.package.weightKg} onChange={(event) => setInput((current) => ({ ...current, package: { ...current.package, weightKg: Number(event.target.value) } }))} /></label>
              <label>Quantity<input required type="number" min="1" max="1000" step="1" value={input.package.quantity} onChange={(event) => setInput((current) => ({ ...current, package: { ...current.package, quantity: Number(event.target.value) } }))} /></label>
              <label>Priority<select value={input.priority} onChange={(event) => setInput((current) => ({ ...current, priority: event.target.value as DispatchPriority }))}>{priorityOptions.map((priority) => <option key={priority.value} value={priority.value}>{priority.label}</option>)}</select></label>
            </div>
          </section>
          {error && <div className="dispatch-alert form-error" role="alert">{error}</div>}
          <footer className="dispatch-form-actions">
            <button className="dispatch-cancel-button" type="button" onClick={onClose} disabled={isCreating}>Cancel</button>
            <button className="dispatch-create-button" type="submit" disabled={isCreating}>{isCreating ? 'Creating…' : 'Create Request'}</button>
          </footer>
        </form>
      </section>
    </div>
  )
}

function DispatchRequestDrawer({
  details,
  isLoading,
  error,
  canPredict,
  onClose,
  onRetry,
  onAssigned,
  onStatusUpdated,
  onLocationsUpdated,
}: {
  details: DispatchRequestDetails | null
  isLoading: boolean
  error: string
  canPredict: boolean
  onClose: () => void
  onRetry: () => void
  onAssigned: () => void
  onStatusUpdated: () => void
  onLocationsUpdated: (updatedRequest: DispatchRequest) => void
}) {
  const [storedPredictionState, setStoredPredictionState] = useState<StoredPredictionState>({
    requestKey: '',
    state: { status: 'idle' },
  })
  const [storedRecommendationState, setStoredRecommendationState] = useState<StoredRecommendationState>({
    requestId: '',
    state: { status: 'idle' },
  })
  const [selectedRecommendedAgentId, setSelectedRecommendedAgentId] = useState('')
  const request = details?.dispatchRequest
  const recommendationState = storedRecommendationState.requestId === request?._id
    ? storedRecommendationState.state
    : { status: 'idle' as const }
  const requestKey = JSON.stringify([
    request?._id ?? '',
    request?.updatedAt ?? '',
    request?.status ?? '',
    request?.assignedAgent?._id ?? '',
    request?.priority ?? '',
    request?.package.category ?? '',
    request?.package.weightKg ?? '',
    request?.package.quantity ?? '',
    request?.pickup.latitude ?? '',
    request?.pickup.longitude ?? '',
    request?.delivery.latitude ?? '',
    request?.delivery.longitude ?? '',
  ])
  const predictionState = storedPredictionState.requestKey === requestKey
    ? storedPredictionState.state
    : { status: 'idle' as const }
  const activity = [...(details?.activity ?? [])].sort(
    (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
  )

  async function handlePrediction() {
    if (!request) return
    setStoredPredictionState({ requestKey, state: { status: 'loading' } })
    try {
      const prediction = await requestDemoDeliveryTimePrediction(request._id)
      setStoredPredictionState({ requestKey, state: { status: 'success', prediction } })
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        setStoredPredictionState({
          requestKey,
          state: {
            status: 'unavailable',
            message: error.message,
          },
        })
      } else if (error instanceof ApiError && error.status === 409) {
        setStoredPredictionState({
          requestKey,
          state: {
            status: 'ineligible',
            message: 'This request is not ready for a prediction. Check that it is assigned and has the required details.',
          },
        })
      } else {
        setStoredPredictionState({
          requestKey,
          state: {
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not get a delivery time prediction.',
          },
        })
      }
    }
  }

  async function loadRecommendations() {
    if (!request) return
    setStoredRecommendationState({ requestId: request._id, state: { status: 'loading' } })
    try {
      const result = await getAgentRecommendations(request._id)
      setStoredRecommendationState({ requestId: request._id, state: { status: 'success', result } })
    } catch (error) {
      setStoredRecommendationState({
        requestId: request._id,
        state: {
          status: 'error',
          message: error instanceof Error ? error.message : 'Agent recommendations could not be loaded.',
        },
      })
    }
  }

  function handleAssignmentUpdated() {
    if (!request) return
    setSelectedRecommendedAgentId('')
    onAssigned()
    void loadRecommendations()
  }

  return (
    <div className="dispatch-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="dispatch-drawer" role="dialog" aria-modal="true" aria-labelledby="dispatch-detail-title">
        <header className="dispatch-drawer-header">
          <div><span className="eyebrow">DISPATCH REQUEST</span><h2 id="dispatch-detail-title">{request ? request.customer.name : 'Request details'}</h2><span className="dispatch-drawer-id">{request?._id ?? 'Loading selected request'}</span></div>
          <button className="dispatch-modal-close" type="button" aria-label="Close request details" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="dispatch-drawer-body">
          {isLoading ? (
            <div className="dispatch-detail-state" role="status"><span className="spinner spinner-small" /> Loading request details…</div>
          ) : error ? (
            <div className="dispatch-detail-state dispatch-detail-error" role="alert"><strong>Could not load this request</strong><span>{error}</span><button type="button" onClick={onRetry}>Try again</button></div>
          ) : request ? (
            <>
              <section className="dispatch-detail-section">
                <h3>Request overview</h3>
                <div className="dispatch-overview-badges"><span className={`dispatch-status status-${request.status}`}>{statusLabels[request.status]}</span><span className={`dispatch-priority priority-${request.priority}`}>{request.priority}</span></div>
                <div className="dispatch-detail-grid"><DetailField label="Request ID" value={request._id} /><DetailField label="Created" value={formatDate(request.createdAt)} /><DetailField label="Last updated" value={formatDate(request.updatedAt)} /></div>
              </section>
              <StatusManagement
                requestId={request._id}
                currentStatus={request.status}
                onUpdated={onStatusUpdated}
              />
              <section className="dispatch-detail-section">
                <h3>Customer</h3>
                <div className="dispatch-detail-grid"><DetailField label="Name" value={request.customer.name} /><DetailField label="Email" value={request.customer.email} icon={<Mail size={13} />} /><DetailField label="Phone" value={request.customer.phone} icon={<Phone size={13} />} /></div>
              </section>
              <LocationDetails title="Pickup" location={request.pickup} />
              <LocationDetails title="Delivery" location={request.delivery} />
              {(request.status === 'pending' || request.status === 'assigned') && (
                <DispatchCoordinateEditor request={request} onSaved={onLocationsUpdated} />
              )}
              <section className="dispatch-detail-section">
                <h3>Package</h3>
                <div className="dispatch-detail-grid"><DetailField label="Description" value={request.package.description} /><DetailField label="Category" value={formatCategory(request.package.category)} /><DetailField label="Weight" value={`${request.package.weightKg} kg`} /><DetailField label="Quantity" value={`${request.package.quantity} ${request.package.quantity === 1 ? 'item' : 'items'}`} /></div>
              </section>
              {canPredict && (
                <section className="dispatch-detail-section dispatch-prediction-section">
                  <div className="dispatch-prediction-heading">
                    <div>
                      <h3><Clock3 size={14} /> AI Delivery Time Prediction</h3>
                      <p>Request an estimate from the available assignment details.</p>
                    </div>
                    <button
                      className="dispatch-create-button dispatch-prediction-button"
                      type="button"
                      onClick={() => void handlePrediction()}
                      disabled={predictionState.status === 'loading'}
                    >
                      {predictionState.status === 'loading' ? (
                        <><span className="dispatch-prediction-spinner" aria-hidden="true" /> Predicting…</>
                      ) : 'Predict Delivery Time'}
                    </button>
                  </div>
                  {predictionState.status === 'success' && (
                    <div className="dispatch-prediction-card" role="status" aria-live="polite">
                      <span className="dispatch-prediction-label">PREDICTED DELIVERY TIME</span>
                      <div className="dispatch-prediction-value">
                        <span className="dispatch-prediction-number">
                          {predictionState.prediction.predictedDurationMinutes}
                        </span>
                        <span className="dispatch-prediction-unit">minutes</span>
                      </div>
                    </div>
                  )}
                  {(predictionState.status === 'unavailable'
                    || predictionState.status === 'ineligible'
                    || predictionState.status === 'error') && (
                    <div className={`dispatch-prediction-message prediction-${predictionState.status}`} role="alert">
                      <p>{predictionState.message}</p>
                    </div>
                  )}
                </section>
              )}
              {canPredict && (
                <section className="dispatch-detail-section dispatch-recommendations-section">
                  <div className="dispatch-recommendations-heading">
                    <div>
                      <h3><Sparkles size={14} /> Smart Agent Recommendations</h3>
                      <p>Compare eligible agents. Recommendations never assign automatically.</p>
                    </div>
                    <button
                      className="dispatch-create-button dispatch-recommendations-button"
                      type="button"
                      onClick={() => void loadRecommendations()}
                      disabled={recommendationState.status === 'loading'
                        || (request.status !== 'pending' && request.status !== 'assigned')}
                    >
                      {recommendationState.status === 'loading' ? (
                        <><span className="dispatch-prediction-spinner" aria-hidden="true" /> Finding…</>
                      ) : 'Find Best Agent'}
                    </button>
                  </div>
                  {request.status !== 'pending' && request.status !== 'assigned' ? (
                    <p className="dispatch-recommendations-state">Recommendations are available for pending or assigned requests.</p>
                  ) : recommendationState.status === 'loading' ? (
                    <p className="dispatch-recommendations-state" role="status">Finding eligible agents…</p>
                  ) : recommendationState.status === 'error' ? (
                    <div className="dispatch-recommendations-error" role="alert">
                      <span>{recommendationState.message}</span>
                      <button type="button" onClick={() => void loadRecommendations()}>Retry</button>
                    </div>
                  ) : recommendationState.status === 'success' ? (
                    recommendationState.result.recommendations.length ? (
                      <div className="dispatch-recommendation-list" aria-live="polite">
                        <p className="dispatch-recommendations-note">
                          Ranked by predicted delivery duration · Synthetic prototype · Model {recommendationState.result.modelVersion}
                        </p>
                        {recommendationState.result.recommendations.map((recommendation) => (
                          <RecommendationCard
                            key={recommendation.agent.id}
                            recommendation={recommendation}
                            minimumHistoricalDeliveries={recommendationState.result.rankingData.minimumHistoricalDeliveries}
                            pickupCoordinatesAvailable={recommendationState.result.rankingData.pickupCoordinatesAvailable}
                            isSelected={selectedRecommendedAgentId === recommendation.agent.id}
                            onSelect={() => setSelectedRecommendedAgentId(recommendation.agent.id)}
                          />
                        ))}
                        {recommendationState.result.notes.map((note) => (
                          <p className="dispatch-recommendations-note" key={note}>{note}</p>
                        ))}
                      </div>
                    ) : (
                      <p className="dispatch-recommendations-state" role="status">
                        No eligible agents are available for this request right now.
                      </p>
                    )
                  ) : (
                    <p className="dispatch-recommendations-state">Find eligible agents ranked by predicted delivery duration.</p>
                  )}
                </section>
              )}
              <section className="dispatch-detail-section">
                <h3>Assigned agent</h3>
                {request.assignedAgent ? <div className="dispatch-detail-grid"><DetailField label="Name" value={request.assignedAgent.name} /><DetailField label="Agent code" value={request.assignedAgent.agentCode} /><DetailField label="Vehicle type" value={request.assignedAgent.vehicle.vehicleType} /><DetailField label="Vehicle registration" value={request.assignedAgent.vehicle.registrationNumber} /><DetailField label="Agent status" value={formatCategory(request.assignedAgent.status)} /></div> : <p className="dispatch-unassigned"><Truck size={15} /> Unassigned</p>}
                {(request.status === 'pending' || request.status === 'assigned') && (
                  <AssignmentPanel
                    requestId={request._id}
                    buttonLabel={request.assignedAgent ? 'Reassign agent' : 'Assign agent'}
                    recommendedAgent={recommendationState.status === 'success'
                      ? recommendationState.result.recommendations.find(
                        (item) => item.agent.id === selectedRecommendedAgentId,
                      ) ?? null
                      : null}
                    onRecommendationCleared={() => setSelectedRecommendedAgentId('')}
                    onAssigned={handleAssignmentUpdated}
                  />
                )}
              </section>
              <section className="dispatch-detail-section dispatch-timeline-section">
                <h3>Activity timeline</h3>
                {activity.length ? <ol className="dispatch-timeline">{activity.map((entry) => {
                  const actor = typeof entry.performedBy === 'string' ? null : entry.performedBy
                  return <li className={`timeline-${activityKind(entry.eventType)}`} key={entry._id}><span className="dispatch-timeline-marker" /><div><div className="dispatch-timeline-title"><strong>{entry.description}</strong><span>{formatCategory(entry.eventType)}</span></div><small>{actor ? `${actor.name} · ${actor.email}` : 'SWERV user'} · {formatDate(entry.createdAt)}</small></div></li>
                })}</ol> : <p className="dispatch-timeline-empty">No activity has been recorded yet.</p>}
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  )
}

function RecommendationCard({
  recommendation,
  minimumHistoricalDeliveries,
  pickupCoordinatesAvailable,
  isSelected,
  onSelect,
}: {
  recommendation: AgentRecommendation
  minimumHistoricalDeliveries: number
  pickupCoordinatesAvailable: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  const hasHistory = recommendation.historicalMedianDurationMinutes !== null

  return (
    <article className={`dispatch-recommendation-card${recommendation.rank === 1 ? ' recommendation-top' : ''}`}>
      <div className="dispatch-recommendation-card-heading">
        <div>
          <span className="dispatch-recommendation-rank">
            {recommendation.rank === 1 ? 'Top recommendation' : `Rank ${recommendation.rank}`}
          </span>
          <strong>{recommendation.agent.name}</strong>
          <span>{recommendation.agent.agentCode}</span>
        </div>
        <span className="dispatch-recommendation-score">{recommendation.predictedDurationMinutes.toFixed(1)} min</span>
      </div>
      <div className="dispatch-recommendation-facts">
        <span>Workload: {recommendation.workload.activeDispatchCount}/{recommendation.workload.maxOrders} active</span>
        {recommendation.distanceKm !== null ? (
          <span>Distance to pickup: {recommendation.distanceKm.toFixed(1)} km</span>
        ) : (
          <span>{pickupCoordinatesAvailable
            ? 'Distance unavailable: this agent has no fresh GPS location'
            : 'Distance unavailable: pickup coordinates are missing'}</span>
        )}
        {hasHistory ? (
          <span>
            Median delivery: {recommendation.historicalMedianDurationMinutes?.toFixed(1)} min
            {' '}({recommendation.historicalCompletedDeliveries} completed)
          </span>
        ) : (
          <span>
            Insufficient history: {recommendation.historicalCompletedDeliveries} of {minimumHistoricalDeliveries} valid deliveries
          </span>
        )}
      </div>
      <ul className="dispatch-recommendation-reasons">
        {recommendation.explanation.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}
      </ul>
      <button
        className="dispatch-recommendation-select"
        type="button"
        aria-pressed={isSelected}
        onClick={onSelect}
      >
        {isSelected ? 'Selected for assignment' : 'Select this agent'}
      </button>
    </article>
  )
}

function LocationDetails({ title, location }: { title: string; location: DispatchRequest['pickup'] }) {
  return (
    <section className="dispatch-detail-section">
      <h3><MapPin size={14} /> {title}</h3>
      <div className="dispatch-detail-grid"><DetailField label="Address" value={[location.address, location.addressLine2].filter(Boolean).join(', ')} /><DetailField label="City" value={location.city} /><DetailField label="Region / state" value={location.region} /><DetailField label="Postal code" value={location.postalCode} /><DetailField label="Country" value={location.country} />{location.instructions && <DetailField label="Instructions" value={location.instructions} />}</div>
    </section>
  )
}

function mapPointFromLocation(location: DispatchRequest['pickup']): MapPoint | null {
  if (typeof location.latitude !== 'number' || typeof location.longitude !== 'number') return null
  return { latitude: location.latitude, longitude: location.longitude }
}

function sameMapPoint(first: MapPoint | null, second: MapPoint | null): boolean {
  return first?.latitude === second?.latitude && first?.longitude === second?.longitude
}

function DispatchCoordinateEditor({
  request,
  onSaved,
}: {
  request: DispatchRequest
  onSaved: (updatedRequest: DispatchRequest) => void
}) {
  const initialPickup = mapPointFromLocation(request.pickup)
  const initialDelivery = mapPointFromLocation(request.delivery)
  const [pickup, setPickup] = useState<MapPoint | null>(initialPickup)
  const [delivery, setDelivery] = useState<MapPoint | null>(initialDelivery)
  const [savedPickup, setSavedPickup] = useState<MapPoint | null>(initialPickup)
  const [savedDelivery, setSavedDelivery] = useState<MapPoint | null>(initialDelivery)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const savingRequest = useRef(false)
  const hasChanges = !sameMapPoint(pickup, savedPickup) || !sameMapPoint(delivery, savedDelivery)

  async function saveCoordinates() {
    if (!hasChanges || savingRequest.current) return
    const coordinates: {
      pickup?: { latitude: number | null; longitude: number | null }
      delivery?: { latitude: number | null; longitude: number | null }
    } = {}

    if (!sameMapPoint(pickup, savedPickup)) {
      coordinates.pickup = pickup ?? { latitude: null, longitude: null }
    }
    if (!sameMapPoint(delivery, savedDelivery)) {
      coordinates.delivery = delivery ?? { latitude: null, longitude: null }
    }

    savingRequest.current = true
    setIsSaving(true)
    setError('')
    setSuccessMessage('')
    try {
      const updatedRequest = await updateDispatchRequestCoordinates(request._id, coordinates)
      const updatedPickup = mapPointFromLocation(updatedRequest.pickup)
      const updatedDelivery = mapPointFromLocation(updatedRequest.delivery)
      setPickup(updatedPickup)
      setDelivery(updatedDelivery)
      setSavedPickup(updatedPickup)
      setSavedDelivery(updatedDelivery)
      setSuccessMessage('Map points saved successfully.')
      onSaved(updatedRequest)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Map coordinates could not be saved.')
    } finally {
      savingRequest.current = false
      setIsSaving(false)
    }
  }

  return (
    <section className="dispatch-detail-section">
      <h3>Map points</h3>
      <p className="dispatch-coordinate-help">Optional delivery map points can be set or changed before pickup. Addresses stay as entered.</p>
      <LocationMapPicker label="Pickup" point={pickup} onChange={(point) => { setPickup(point); setError(''); setSuccessMessage('') }} />
      <LocationMapPicker label="Destination" point={delivery} onChange={(point) => { setDelivery(point); setError(''); setSuccessMessage('') }} />
      {error && <div className="dispatch-assignment-error" role="alert">{error}</div>}
      {successMessage && <p className="dispatch-coordinate-success" role="status">{successMessage}</p>}
      <button className="dispatch-create-button dispatch-coordinate-save" type="button" disabled={!hasChanges || isSaving} onClick={() => void saveCoordinates()}>
        {isSaving ? 'Saving map points…' : 'Save map points'}
      </button>
    </section>
  )
}

function AssignmentPanel({
  requestId,
  buttonLabel,
  recommendedAgent,
  onRecommendationCleared,
  onAssigned,
}: {
  requestId: string
  buttonLabel: string
  recommendedAgent: AgentRecommendation | null
  onRecommendationCleared: () => void
  onAssigned: () => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [isLoadingAgents, setIsLoadingAgents] = useState(false)
  const [isAssigning, setIsAssigning] = useState(false)
  const [agentError, setAgentError] = useState('')
  const [assignmentError, setAssignmentError] = useState('')
  const [isReviewingAssignment, setIsReviewingAssignment] = useState(false)
  const currentAgentId = recommendedAgent?.agent.id ?? selectedAgentId

  async function loadAgents() {
    setIsLoadingAgents(true)
    setAgentError('')
    try {
      const result = await getAgents({
        page: 1,
        limit: 100,
        search: '',
        status: '',
        vehicleType: '',
        capability: '',
        isActive: true,
      })
      setAgents(result.agents)
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : 'Agents could not be loaded.')
    } finally {
      setIsLoadingAgents(false)
    }
  }

  async function handleAssign() {
    if (!currentAgentId || isAssigning) return
    setAssignmentError('')
    setIsAssigning(true)
    try {
      await assignDispatchAgent(requestId, currentAgentId)
      setIsOpen(false)
      setIsReviewingAssignment(false)
      setSelectedAgentId('')
      onAssigned()
    } catch (error) {
      setAssignmentError(error instanceof Error ? error.message : 'The agent could not be assigned.')
    } finally {
      setIsAssigning(false)
    }
  }

  return (
    <div className="dispatch-assignment">
      {!isOpen ? (
        <button className="dispatch-assignment-trigger" type="button" onClick={() => { setAssignmentError(''); if (recommendedAgent) setSelectedAgentId(recommendedAgent.agent.id); setIsOpen(true); void loadAgents() }}>
          <Truck size={14} /> {recommendedAgent ? 'Continue with selected agent' : buttonLabel}
        </button>
      ) : (
        <div className="dispatch-assignment-panel">
          <div className="dispatch-assignment-heading"><strong>{recommendedAgent ? 'Assign recommended agent' : buttonLabel}</strong><button type="button" onClick={() => { setIsOpen(false); setIsReviewingAssignment(false) }} disabled={isAssigning}>Cancel</button></div>
          {isLoadingAgents ? (
            <p className="dispatch-assignment-state"><span className="spinner spinner-small" /> Loading active agents…</p>
          ) : agentError ? (
            <div className="dispatch-assignment-error" role="alert">{agentError}<button type="button" onClick={() => void loadAgents()}>Retry</button></div>
          ) : agents.length ? (
            <>
              <label className="dispatch-agent-select-label">Select agent
                <select value={currentAgentId} onChange={(event) => { onRecommendationCleared(); setSelectedAgentId(event.target.value); setIsReviewingAssignment(false); setAssignmentError('') }}>
                  <option value="">Choose an active agent</option>
                  {agents.map((agent) => <option key={agent._id} value={agent._id}>{agent.name} · {agent.agentCode} · {formatCategory(agent.vehicle.vehicleType)} · {agent.vehicle.registrationNumber} · {formatCategory(agent.status)} · {agent.activeDispatchCount ?? 0}/{agent.capacity.maxOrders} active orders</option>)}
                </select>
              </label>
              <p className="dispatch-assignment-hint">The server checks agent availability, capacity, and delivery capabilities when you confirm.</p>
              {assignmentError && <div className="dispatch-assignment-error" role="alert">{assignmentError}</div>}
              {isReviewingAssignment ? (
                <div className="dispatch-assignment-confirm" role="group" aria-label="Confirm agent assignment">
                  <p>
                    Confirm assignment to <strong>{agents.find((agent) => agent._id === currentAgentId)?.name ?? recommendedAgent?.agent.name ?? 'the selected agent'}</strong>
                    {agents.find((agent) => agent._id === currentAgentId)?.agentCode
                      ? ` (${agents.find((agent) => agent._id === currentAgentId)?.agentCode})`
                      : recommendedAgent?.agent.agentCode
                        ? ` (${recommendedAgent.agent.agentCode})`
                      : ''}?
                  </p>
                  <div>
                    <button className="dispatch-cancel-button" type="button" disabled={isAssigning} onClick={() => setIsReviewingAssignment(false)}>Choose another</button>
                    <button className="dispatch-create-button" type="button" disabled={isAssigning} onClick={() => void handleAssign()}>{isAssigning ? 'Assigning...' : 'Confirm assignment'}</button>
                  </div>
                </div>
              ) : (
                <button className="dispatch-create-button" type="button" disabled={!currentAgentId || isAssigning} onClick={() => { setAssignmentError(''); setIsReviewingAssignment(true) }}>Review assignment</button>
              )}
            </>
          ) : (
            <p className="dispatch-assignment-state">No active agents are available in the directory.</p>
          )}
        </div>
      )}
    </div>
  )
}

function StatusManagement({
  requestId,
  currentStatus,
  onUpdated,
}: {
  requestId: string
  currentStatus: DispatchRequestStatus
  onUpdated: () => void
}) {
  const [nextStatus, setNextStatus] = useState<DispatchRequestStatus | ''>('')
  const [isUpdating, setIsUpdating] = useState(false)
  const [error, setError] = useState('')
  const availableStatuses = statusTransitions[currentStatus]

  async function handleUpdate() {
    if (!nextStatus || isUpdating) return
    if (['cancelled', 'failed', 'delivered'].includes(nextStatus)) {
      const confirmed = window.confirm(
        `This will mark the request as ${statusLabels[nextStatus].toLowerCase()}. This is a terminal status and cannot be changed afterward. Continue?`,
      )
      if (!confirmed) return
    }

    setError('')
    setIsUpdating(true)
    try {
      await updateDispatchRequestStatus(requestId, nextStatus)
      setNextStatus('')
      onUpdated()
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'The request status could not be updated.')
    } finally {
      setIsUpdating(false)
    }
  }

  return (
    <section className="dispatch-detail-section dispatch-status-management">
      <h3>Update status</h3>
      <div className="dispatch-status-current"><span>Current status</span><strong className={`dispatch-status status-${currentStatus}`}>{statusLabels[currentStatus]}</strong></div>
      {availableStatuses.length ? (
        <div className="dispatch-status-controls">
          <label>Next status
            <select value={nextStatus} onChange={(event) => setNextStatus(event.target.value as DispatchRequestStatus | '')} disabled={isUpdating}>
              <option value="">Select a status</option>
              {availableStatuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
            </select>
          </label>
          <button className="dispatch-create-button" type="button" disabled={!nextStatus || isUpdating} onClick={() => void handleUpdate()}>{isUpdating ? 'Updating…' : 'Update Status'}</button>
        </div>
      ) : currentStatus === 'in_transit' ? (
        <p className="dispatch-status-terminal">An agent must submit verified proof of delivery to complete this request.</p>
      ) : (
        <p className="dispatch-status-terminal">This request is in a terminal status and cannot be changed.</p>
      )}
      {error && <div className="dispatch-assignment-error" role="alert">{error}</div>}
    </section>
  )
}

function DetailField({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return <div className="dispatch-detail-field"><small>{icon}{label}</small><strong>{value || '—'}</strong></div>
}

function activityKind(eventType: string) {
  if (eventType.includes('request_created')) return 'created'
  if (eventType.includes('assignment') || eventType.includes('assigned') || eventType.includes('reassign')) return 'assignment'
  if (eventType.includes('status')) return 'status'
  return 'other'
}

function DispatchRequestCard({ request, onOpen }: { request: DispatchRequest; onOpen: () => void }) {
  const agent = assignedAgentName(request)

  function handleCardClick(event: MouseEvent<HTMLElement>) {
    const interactiveElement = (event.target as HTMLElement).closest(
      'button, a, input, select, textarea, [role="button"]',
    )
    if (interactiveElement && interactiveElement !== event.currentTarget) return
    onOpen()
  }

  function handleCardKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen()
    }
  }

  return (
    <article className="dispatch-request-card" role="button" tabIndex={0} onClick={handleCardClick} onKeyDown={handleCardKeyDown} aria-label={`View request ${request._id}`}>
      <header className="dispatch-card-heading">
        <div>
          <span className="dispatch-request-id">Request {request._id}</span>
          <h2>{request.customer.name}</h2>
          <p>{request.customer.email} <span>·</span> {request.customer.phone}</p>
        </div>
        <div className="dispatch-badges">
          <span className={`dispatch-priority priority-${request.priority}`}>
            {request.priority}
          </span>
          <span className={`dispatch-status status-${request.status}`}>
            {statusLabels[request.status]}
          </span>
        </div>
      </header>

      <div className="dispatch-card-content">
        <div className="dispatch-route">
          <div className="dispatch-route-point">
            <span className="route-marker pickup-marker" />
            <div>
              <small>Pickup</small>
              <strong>{locationSummary(request.pickup)}</strong>
            </div>
          </div>
          <ArrowRight className="dispatch-route-arrow" size={16} />
          <div className="dispatch-route-point">
            <span className="route-marker delivery-marker" />
            <div>
              <small>Delivery</small>
              <strong>{locationSummary(request.delivery)}</strong>
            </div>
          </div>
        </div>

        <div className="dispatch-package">
          <span className="dispatch-info-icon"><Package size={16} /></span>
          <div>
            <small>Package</small>
            <strong>{request.package.description}</strong>
            <span>
              {formatCategory(request.package.category)} · {request.package.weightKg} kg · {request.package.quantity} {request.package.quantity === 1 ? 'item' : 'items'}
            </span>
          </div>
        </div>
      </div>

      <footer className="dispatch-card-footer">
        <span className="dispatch-assigned-agent">
          <Truck size={14} /> {agent ?? 'Unassigned'}
        </span>
        <span className="dispatch-created-at">
          <Clock3 size={13} /> Created {formatDate(request.createdAt)}
        </span>
      </footer>
    </article>
  )
}

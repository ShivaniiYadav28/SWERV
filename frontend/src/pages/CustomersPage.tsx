import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, Menu, Pencil, Plus, RefreshCw, Search, UserRound, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import { createCustomer, getCustomer, getCustomers, setCustomerStatus, updateCustomer } from '../lib/customers'
import type { Customer, CustomerDetails, CustomerFilters, CustomerInput, CustomerPage } from '../types/customer'
import '../App.css'
import './customers.css'

const initialFilters: CustomerFilters = { page: 1, limit: 10, search: '', status: '' }
const blankCustomer: CustomerInput = { name: '', email: '', phone: '' }

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function CustomersPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [filters, setFilters] = useState(initialFilters)
  const [directory, setDirectory] = useState<CustomerPage | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [editor, setEditor] = useState<{ customer?: Customer; input: CustomerInput } | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [details, setDetails] = useState<CustomerDetails | null>(null)
  const [detailsError, setDetailsError] = useState('')
  const [isLoadingDetails, setIsLoadingDetails] = useState(false)
  const [actionError, setActionError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [busyCustomerId, setBusyCustomerId] = useState('')
  const latestListRequest = useRef(0)
  const latestDetailsRequest = useRef(0)

  const loadDirectory = useCallback(async () => {
    const requestNumber = ++latestListRequest.current
    setIsLoading(true)
    setLoadError('')
    try {
      const page = await getCustomers(filters)
      if (requestNumber === latestListRequest.current) setDirectory(page)
    } catch (error) {
      if (requestNumber === latestListRequest.current) {
        setDirectory(null)
        setLoadError(error instanceof Error ? error.message : 'Customers could not be loaded.')
      }
    } finally {
      if (requestNumber === latestListRequest.current) setIsLoading(false)
    }
  }, [filters])

  useEffect(() => {
    const request = window.setTimeout(() => void loadDirectory(), 0)
    return () => window.clearTimeout(request)
  }, [loadDirectory, reloadKey])

  useEffect(() => {
    if (!editor && !selectedCustomerId) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!isSaving) setEditor(null)
      closeDetails()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [editor, isSaving, selectedCustomerId])

  async function handleLogout() {
    try { await logout() } catch { /* Local auth state still clears when the API is unavailable. */ }
    navigate('/login', { replace: true })
  }

  function updateFilter<K extends 'search' | 'status'>(key: K, value: CustomerFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value, page: 1 }))
  }

  function closeDetails() {
    latestDetailsRequest.current += 1
    setSelectedCustomerId('')
    setDetails(null)
    setDetailsError('')
    setIsLoadingDetails(false)
  }

  async function openDetails(id: string) {
    const requestNumber = ++latestDetailsRequest.current
    setSelectedCustomerId(id)
    setDetails(null)
    setDetailsError('')
    setIsLoadingDetails(true)
    try {
      const result = await getCustomer(id)
      if (requestNumber === latestDetailsRequest.current) setDetails(result)
    } catch (error) {
      if (requestNumber === latestDetailsRequest.current) {
        setDetailsError(error instanceof Error ? error.message : 'Customer details could not be loaded.')
      }
    } finally {
      if (requestNumber === latestDetailsRequest.current) setIsLoadingDetails(false)
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    setIsSaving(true)
    setSaveError('')
    try {
      if (editor.customer) {
        await updateCustomer(editor.customer.id, editor.input)
        setSuccessMessage('Customer updated successfully.')
      } else {
        await createCustomer(editor.input)
        setSuccessMessage('Customer created successfully.')
        setFilters((current) => ({ ...current, page: 1 }))
      }
      setEditor(null)
      setReloadKey((key) => key + 1)
      if (selectedCustomerId && editor.customer?.id === selectedCustomerId) {
        void openDetails(selectedCustomerId)
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Customer could not be saved.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleStatusChange(customer: Customer) {
    const nextActive = !customer.isActive
    const verb = nextActive ? 'Activate' : 'Deactivate'
    if (!window.confirm(`${verb} ${customer.name}'s account?`)) return
    setActionError('')
    setSuccessMessage('')
    setBusyCustomerId(customer.id)
    try {
      await setCustomerStatus(customer.id, nextActive)
      setSuccessMessage(`${customer.name} was ${nextActive ? 'activated' : 'deactivated'}.`)
      setReloadKey((key) => key + 1)
      if (selectedCustomerId === customer.id) void openDetails(customer.id)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Customer status could not be changed.')
    } finally {
      setBusyCustomerId('')
    }
  }

  const page = directory?.pagination.page ?? filters.page
  const pageCount = directory?.pagination.pages ?? 0

  return <div className="app-shell">
    {user && <DashboardSidebar user={user} activePage="customers" menuOpen={menuOpen} onMenuClose={() => setMenuOpen(false)} onLogout={() => void handleLogout()} />}
    <main className="main-area">
      <header className="topbar"><button className="icon-button menu-toggle" type="button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>Customers</strong></div><div className="topbar-actions"><div className="environment-pill"><i /> Operations</div><div className="top-avatar">{user?.name.slice(0, 1).toUpperCase()}</div></div></header>
      <div className="content-wrap customers-content">
        <section className="dispatch-heading"><div><div className="eyebrow">FLEET OPERATIONS <span className="eyebrow-dot" /> CUSTOMERS</div><h1>Customer Management</h1><p className="page-subtitle">Manage customer contacts and review their dispatch history.</p></div><div className="customers-heading-actions"><button className="customers-secondary" type="button" disabled={isLoading} onClick={() => setReloadKey((key) => key + 1)}><RefreshCw size={15} /> Refresh</button><button className="dispatch-create-button" type="button" onClick={() => { setSaveError(''); setEditor({ input: blankCustomer }) }}><Plus size={16} /> Create customer</button></div></section>
        {successMessage && <div className="customers-notice success" role="status"><span>{successMessage}</span><button type="button" aria-label="Dismiss" onClick={() => setSuccessMessage('')}><X size={15} /></button></div>}
        {actionError && <div className="customers-notice error" role="alert"><span>{actionError}</span><button type="button" aria-label="Dismiss" onClick={() => setActionError('')}><X size={15} /></button></div>}
        <section className="customers-panel">
          <div className="customers-toolbar"><label className="dispatch-search"><Search size={16} /><span className="visually-hidden">Search customers</span><input value={filters.search} onChange={(event) => updateFilter('search', event.target.value)} placeholder="Search name, email, or phone" /></label><label className="customers-status-filter"><span className="visually-hidden">Filter by customer status</span><select value={filters.status} onChange={(event) => updateFilter('status', event.target.value as CustomerFilters['status'])}><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label></div>
          {loadError && <div className="dispatch-alert" role="alert"><span>{loadError}</span><button type="button" onClick={() => setReloadKey((key) => key + 1)}>Try again</button></div>}
          {isLoading ? <div className="dispatch-state" role="status"><span className="spinner spinner-small" /> Loading customers…</div> : loadError ? null : directory?.customers.length ? <div className="customers-table-wrap"><table className="customers-table"><thead><tr><th>Customer</th><th>Phone</th><th>Status</th><th>Created</th><th><span className="visually-hidden">Actions</span></th></tr></thead><tbody>{directory.customers.map((customer) => <tr key={customer.id}>
            <td><button type="button" className="customer-identity" onClick={() => void openDetails(customer.id)}><span className="customer-avatar">{customer.name.trim().slice(0, 1).toUpperCase()}</span><span><strong>{customer.name}</strong><small>{customer.email}</small></span></button></td>
            <td>{customer.phone}</td><td><span className={`customer-status ${customer.isActive ? 'active' : 'inactive'}`}><i />{customer.isActive ? 'Active' : 'Inactive'}</span></td><td className="customer-date">{formatDate(customer.createdAt)}</td>
            <td><div className="customer-actions"><button type="button" aria-label={`Edit ${customer.name}`} onClick={() => { setSaveError(''); setEditor({ customer, input: { name: customer.name, email: customer.email, phone: customer.phone } }) }}><Pencil size={14} /> Edit</button><button type="button" className={customer.isActive ? 'deactivate' : ''} disabled={busyCustomerId === customer.id} onClick={() => void handleStatusChange(customer)}>{busyCustomerId === customer.id ? 'Saving…' : customer.isActive ? 'Deactivate' : 'Activate'}</button></div></td>
          </tr>)}</tbody></table></div> : <div className="dispatch-state dispatch-empty"><span className="dispatch-empty-icon"><UserRound size={20} /></span><strong>{filters.search || filters.status ? 'No customers match these filters' : 'No customers found'}</strong><p>Try changing the search or filters, or create a customer.</p></div>}
          <div className="dispatch-pagination"><span>{directory?.pagination.total ?? 0} customers</span><div><span>Page {page} of {Math.max(pageCount, 1)}</span><button type="button" aria-label="Previous page" disabled={page <= 1 || isLoading} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}><ChevronLeft size={16} /></button><button type="button" aria-label="Next page" disabled={!pageCount || page >= pageCount || isLoading} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}><ChevronRight size={16} /></button></div></div>
        </section>
        <footer className="page-footer"><span>SWERV</span><span>Customer directory</span></footer>
      </div>
    </main>
    {editor && <CustomerFormDialog customer={editor.customer} input={editor.input} error={saveError} isSaving={isSaving} onChange={(input) => setEditor((current) => current ? { ...current, input } : current)} onClose={() => { if (!isSaving) setEditor(null) }} onSubmit={(event) => void handleSave(event)} />}
    {selectedCustomerId && <CustomerDetailsDrawer details={details} error={detailsError} isLoading={isLoadingDetails} onClose={closeDetails} onRetry={() => void openDetails(selectedCustomerId)} />}
  </div>
}

function CustomerFormDialog({ customer, input, error, isSaving, onChange, onClose, onSubmit }: {
  customer?: Customer; input: CustomerInput; error: string; isSaving: boolean;
  onChange: (input: CustomerInput) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <div className="dispatch-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSaving) onClose() }}><section className="dispatch-modal customer-dialog" role="dialog" aria-modal="true" aria-labelledby="customer-form-title"><header className="dispatch-modal-heading"><div><span className="eyebrow">CUSTOMER DIRECTORY</span><h2 id="customer-form-title">{customer ? 'Edit customer' : 'Create customer'}</h2></div><button className="dispatch-modal-close" type="button" aria-label="Close form" onClick={onClose} disabled={isSaving}><X size={18} /></button></header><form className="customer-form" onSubmit={onSubmit}><label>Name<input required minLength={2} maxLength={100} autoComplete="name" value={input.name} onChange={(event) => onChange({ ...input, name: event.target.value })} /></label><label>Email<input type="email" required maxLength={254} autoComplete="email" value={input.email} onChange={(event) => onChange({ ...input, email: event.target.value })} /></label><label>Phone<input required minLength={7} maxLength={24} autoComplete="tel" value={input.phone} onChange={(event) => onChange({ ...input, phone: event.target.value })} /></label>{error && <p className="customer-form-error" role="alert">{error}</p>}<footer className="customer-form-actions"><button className="dispatch-cancel-button" type="button" onClick={onClose} disabled={isSaving}>Cancel</button><button className="dispatch-create-button" type="submit" disabled={isSaving}>{isSaving ? 'Saving…' : customer ? 'Save changes' : 'Create customer'}</button></footer></form></section></div>
}

function CustomerDetailsDrawer({ details, error, isLoading, onClose, onRetry }: {
  details: CustomerDetails | null; error: string; isLoading: boolean; onClose: () => void; onRetry: () => void;
}) {
  const customer = details?.customer
  return <div className="dispatch-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><aside className="dispatch-drawer" role="dialog" aria-modal="true" aria-labelledby="customer-details-title"><header className="dispatch-drawer-header"><div><span className="eyebrow">CUSTOMER PROFILE</span><h2 id="customer-details-title">{customer?.name ?? 'Customer details'}</h2><span className="dispatch-drawer-id">{customer?.email ?? 'Loading customer details'}</span></div><button className="dispatch-modal-close" type="button" aria-label="Close customer details" onClick={onClose}><X size={18} /></button></header><div className="dispatch-drawer-body">{isLoading ? <div className="dispatch-detail-state"><span className="spinner spinner-small" /> Loading customer…</div> : error ? <div className="dispatch-detail-state dispatch-detail-error"><strong>Could not load customer</strong><span>{error}</span><button type="button" onClick={onRetry}>Try again</button></div> : details && customer ? <>
    <section className="dispatch-detail-section"><h3>Customer information</h3><div className="dispatch-detail-grid"><CustomerField label="Name" value={customer.name} /><CustomerField label="Email" value={customer.email} /><CustomerField label="Phone" value={customer.phone} /><CustomerField label="Status" value={customer.isActive ? 'Active' : 'Inactive'} /><CustomerField label="Created" value={formatDate(customer.createdAt)} /><CustomerField label="Last updated" value={formatDate(customer.updatedAt)} /></div></section>
    <section className="dispatch-detail-section"><h3>Dispatch history <span className="customer-history-count">{details.dispatchRequests.length}</span></h3>{details.dispatchRequests.length ? <div className="customer-history-list">{details.dispatchRequests.map((dispatch) => <article key={dispatch._id} className="customer-history-item"><div><strong>{dispatch.package.description}</strong><small>{dispatch._id}</small></div><span className={`dispatch-status status-${dispatch.status}`}>{dispatch.status.replaceAll('_', ' ')}</span><small>{formatDate(dispatch.createdAt)}</small></article>)}</div> : <p className="customer-no-history">No dispatch requests are linked to this customer yet.</p>}</section>
  </> : null}</div></aside></div>
}

function CustomerField({ label, value }: { label: string; value: string }) {
  return <div className="dispatch-detail-field"><small>{label}</small><strong>{value}</strong></div>
}

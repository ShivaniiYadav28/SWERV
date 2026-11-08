import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, Menu, Plus, RefreshCw, Search, ShieldCheck, UserRound, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DashboardSidebar } from '../components/DashboardSidebar'
import { useAuth } from '../hooks/useAuth'
import {
  changeManagedUserRole,
  changeManagedUserStatus,
  createManagedUser,
  getManagedUser,
  getManagedUsers,
} from '../lib/adminUsers'
import type {
  CreateManagedUserInput,
  ManagedUser,
  ManagedUserFilters,
  ManagedUserPage,
  ManagedUserRole,
} from '../types/adminUser'
import '../App.css'
import './admin-users.css'

const initialFilters: ManagedUserFilters = {
  page: 1,
  limit: 10,
  search: '',
  role: '',
  status: '',
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value))
}

export function AdminUsersPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [filters, setFilters] = useState(initialFilters)
  const [directory, setDirectory] = useState<ManagedUserPage | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [createError, setCreateError] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [selectedUser, setSelectedUser] = useState<ManagedUser | null>(null)
  const [selectedUserId, setSelectedUserId] = useState('')
  const [detailError, setDetailError] = useState('')
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [actionError, setActionError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [busyUserId, setBusyUserId] = useState('')
  const latestListRequest = useRef(0)
  const latestDetailRequest = useRef(0)

  const loadUsers = useCallback(async () => {
    const requestNumber = ++latestListRequest.current
    setIsLoading(true)
    setLoadError('')
    try {
      const result = await getManagedUsers(filters)
      if (requestNumber === latestListRequest.current) setDirectory(result)
    } catch (error) {
      if (requestNumber === latestListRequest.current) {
        setLoadError(error instanceof Error ? error.message : 'Users could not be loaded.')
        setDirectory(null)
      }
    } finally {
      if (requestNumber === latestListRequest.current) setIsLoading(false)
    }
  }, [filters])

  useEffect(() => {
    const request = window.setTimeout(() => void loadUsers(), 0)
    return () => window.clearTimeout(request)
  }, [loadUsers, reloadKey])

  useEffect(() => {
    if (!isCreateOpen && !selectedUserId) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Esc') return
      if (!isCreating) setIsCreateOpen(false)
      if (!isLoadingDetail) setSelectedUser(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [isCreateOpen, isCreating, isLoadingDetail, selectedUserId])

  async function handleLogout() {
    try {
      await logout()
    } catch {
      // The local session is cleared even if the API cannot be reached.
    }
    navigate('/login', { replace: true })
  }

  function updateFilter<K extends 'search' | 'role' | 'status'>(key: K, value: ManagedUserFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value, page: 1 }))
  }

  async function openUserDetails(id: string) {
    const requestNumber = ++latestDetailRequest.current
    setSelectedUser(null)
    setSelectedUserId(id)
    setDetailError('')
    setIsLoadingDetail(true)
    try {
      const details = await getManagedUser(id)
      if (requestNumber === latestDetailRequest.current) setSelectedUser(details)
    } catch (error) {
      if (requestNumber === latestDetailRequest.current) {
        setDetailError(error instanceof Error ? error.message : 'User details could not be loaded.')
      }
    } finally {
      if (requestNumber === latestDetailRequest.current) setIsLoadingDetail(false)
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreateError('')
    setIsCreating(true)
    const form = new FormData(event.currentTarget)
    const input: CreateManagedUserInput = {
      name: String(form.get('name') ?? '').trim(),
      email: String(form.get('email') ?? '').trim(),
      password: String(form.get('password') ?? ''),
      role: String(form.get('role') ?? 'operator') as ManagedUserRole,
    }
    try {
      await createManagedUser(input)
      setIsCreateOpen(false)
      setSuccessMessage('User created successfully.')
      setFilters((current) => ({ ...current, page: 1 }))
      setReloadKey((key) => key + 1)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'User could not be created.')
    } finally {
      setIsCreating(false)
    }
  }

  async function handleRoleChange(target: ManagedUser) {
    const nextRole: ManagedUserRole = target.role === 'admin' ? 'operator' : 'admin'
    const message = `Change ${target.name}'s role from ${target.role} to ${nextRole}?`
    if (!window.confirm(message)) return
    setActionError('')
    setSuccessMessage('')
    setBusyUserId(target.id)
    try {
      const result = await changeManagedUserRole(target.id, nextRole)
      setSuccessMessage(`${target.name}'s role was updated.`)
      setReloadKey((key) => key + 1)
      if (selectedUser?.id === target.id && result.data?.user) setSelectedUser(result.data.user)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Role could not be updated.')
    } finally {
      setBusyUserId('')
    }
  }

  async function handleStatusChange(target: ManagedUser) {
    const nextActive = !target.isActive
    const action = nextActive ? 'activate' : 'deactivate'
    if (!window.confirm(`${action[0].toUpperCase()}${action.slice(1)} ${target.name}'s account?`)) return
    setActionError('')
    setSuccessMessage('')
    setBusyUserId(target.id)
    try {
      const result = await changeManagedUserStatus(target.id, nextActive)
      setSuccessMessage(`${target.name}'s account was ${nextActive ? 'activated' : 'deactivated'}.`)
      setReloadKey((key) => key + 1)
      if (selectedUser?.id === target.id && result.data?.user) setSelectedUser(result.data.user)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Account status could not be updated.')
    } finally {
      setBusyUserId('')
    }
  }

  const currentPage = directory?.pagination.page ?? filters.page
  const totalPages = directory?.pagination.pages ?? 0
  const isSelf = (target: ManagedUser) => target.id === user?.id

  return (
    <div className="app-shell">
      {user && <DashboardSidebar user={user} activePage="admin" menuOpen={menuOpen} onMenuClose={() => setMenuOpen(false)} onLogout={() => void handleLogout()} />}
      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-toggle" type="button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>User management</strong></div>
          <div className="topbar-actions"><div className="environment-pill"><i /> Administrator</div><div className="top-avatar">{user?.name.slice(0, 1).toUpperCase()}</div></div>
        </header>

        <div className="content-wrap admin-users-content">
          <section className="dispatch-heading">
            <div><div className="eyebrow">ACCESS CONTROL <span className="eyebrow-dot" /> ADMINISTRATION</div><h1>User Management</h1><p className="page-subtitle">Manage SWERV accounts, roles, and access.</p></div>
            <div className="admin-users-heading-actions">
              <button className="admin-users-secondary" type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={isLoading}><RefreshCw size={15} /> Refresh</button>
              <button className="dispatch-create-button" type="button" onClick={() => { setCreateError(''); setIsCreateOpen(true) }}><Plus size={16} /> Create user</button>
            </div>
          </section>

          {successMessage && <div className="admin-users-success" role="status"><span>{successMessage}</span><button type="button" aria-label="Dismiss" onClick={() => setSuccessMessage('')}><X size={15} /></button></div>}
          {actionError && <div className="admin-users-alert" role="alert"><span>{actionError}</span><button type="button" aria-label="Dismiss" onClick={() => setActionError('')}><X size={15} /></button></div>}

          <section className="admin-users-panel">
            <div className="admin-users-toolbar">
              <label className="dispatch-search"><Search size={16} /><span className="visually-hidden">Search users</span><input value={filters.search} onChange={(event) => updateFilter('search', event.target.value)} placeholder="Search name or email" /></label>
              <div className="dispatch-filters">
                <label><span className="visually-hidden">Filter users by role</span><select value={filters.role} onChange={(event) => updateFilter('role', event.target.value as ManagedUserFilters['role'])}><option value="">All roles</option><option value="admin">Admin</option><option value="operator">Operator</option></select></label>
                <label><span className="visually-hidden">Filter users by status</span><select value={filters.status} onChange={(event) => updateFilter('status', event.target.value as ManagedUserFilters['status'])}><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
              </div>
            </div>

            {loadError && <div className="dispatch-alert" role="alert"><span>{loadError}</span><button type="button" onClick={() => setReloadKey((key) => key + 1)}>Try again</button></div>}
            {isLoading ? <div className="dispatch-state" role="status"><span className="spinner spinner-small" /> Loading users…</div> : loadError ? null : directory?.users.length ? (
              <div className="admin-users-table-wrap">
                <table className="admin-users-table"><thead><tr><th>User</th><th>Role</th><th>Account status</th><th>Created</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
                  <tbody>{directory.users.map((managedUser) => <tr key={managedUser.id}>
                    <td><button className="admin-users-identity" type="button" onClick={() => void openUserDetails(managedUser.id)}><span className="admin-users-avatar">{managedUser.name.trim().slice(0, 1).toUpperCase()}</span><span><strong>{managedUser.name}</strong><small>{managedUser.email}</small></span></button></td>
                    <td><span className={`admin-user-role role-${managedUser.role}`}>{managedUser.role === 'admin' ? <ShieldCheck size={13} /> : <UserRound size={13} />}{managedUser.role}</span></td>
                    <td><span className={`admin-user-status ${managedUser.isActive ? 'status-active' : 'status-inactive'}`}><i />{managedUser.isActive ? 'Active' : 'Inactive'}</span></td>
                    <td className="admin-users-date">{formatDate(managedUser.createdAt)}</td>
                    <td><div className="admin-user-actions"><button type="button" onClick={() => void handleRoleChange(managedUser)} disabled={busyUserId === managedUser.id}>{managedUser.role === 'admin' ? 'Make Operator' : 'Make Admin'}</button><button type="button" className={managedUser.isActive ? 'danger' : ''} onClick={() => void handleStatusChange(managedUser)} disabled={busyUserId === managedUser.id || (isSelf(managedUser) && managedUser.isActive)}>{busyUserId === managedUser.id ? 'Saving…' : managedUser.isActive ? 'Deactivate' : 'Activate'}</button></div></td>
                  </tr>)}</tbody>
                </table>
              </div>
            ) : <div className="dispatch-state dispatch-empty"><span className="dispatch-empty-icon"><UserRound size={20} /></span><strong>{filters.search || filters.role || filters.status ? 'No users match these filters' : 'No users found'}</strong><p>Try changing your search or filters.</p></div>}

            <div className="dispatch-pagination"><span>{directory?.pagination.total ?? 0} users</span><div><span>Page {currentPage} of {Math.max(totalPages, 1)}</span><button type="button" aria-label="Previous page" disabled={currentPage <= 1 || isLoading} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}><ChevronLeft size={16} /></button><button type="button" aria-label="Next page" disabled={!totalPages || currentPage >= totalPages || isLoading} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}><ChevronRight size={16} /></button></div></div>
          </section>
          <footer className="page-footer"><span>SWERV</span><span>Administrator user directory</span></footer>
        </div>
      </main>

      {isCreateOpen && <CreateUserDialog error={createError} isSaving={isCreating} onClose={() => setIsCreateOpen(false)} onSubmit={handleCreate} />}
      {selectedUserId && <UserDetailsDrawer user={selectedUser} error={detailError} isLoading={isLoadingDetail} onClose={() => { latestDetailRequest.current += 1; setSelectedUserId(''); setSelectedUser(null); setDetailError(''); setIsLoadingDetail(false) }} onRetry={() => void openUserDetails(selectedUserId)} />}
    </div>
  )
}

function CreateUserDialog({ error, isSaving, onClose, onSubmit }: {
  error: string; isSaving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <div className="dispatch-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSaving) onClose() }}><section className="dispatch-modal admin-user-dialog" role="dialog" aria-modal="true" aria-labelledby="create-user-title">
    <header className="dispatch-modal-heading"><div><span className="eyebrow">ACCESS CONTROL</span><h2 id="create-user-title">Create user</h2></div><button className="dispatch-modal-close" type="button" aria-label="Close dialog" onClick={onClose} disabled={isSaving}><X size={18} /></button></header>
    <form className="admin-user-form" onSubmit={onSubmit}>
      <label>Full name<input name="name" required minLength={2} maxLength={80} autoComplete="name" /></label>
      <label>Email address<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>
      <label>Temporary password<input name="password" type="password" required minLength={8} maxLength={72} autoComplete="new-password" /><small>At least 8 characters. Share it securely with the new user.</small></label>
      <label>Role<select name="role" defaultValue="operator"><option value="operator">Operator</option><option value="admin">Admin</option></select></label>
      {error && <p className="admin-user-form-error" role="alert">{error}</p>}
      <div className="admin-user-form-actions"><button className="admin-users-secondary" type="button" onClick={onClose} disabled={isSaving}>Cancel</button><button className="dispatch-create-button" type="submit" disabled={isSaving}>{isSaving ? 'Creating…' : 'Create user'}</button></div>
    </form>
  </section></div>
}

function UserDetailsDrawer({ user, error, isLoading, onClose, onRetry }: {
  user: ManagedUser | null; error: string; isLoading: boolean; onClose: () => void; onRetry: () => void;
}) {
  return <div className="dispatch-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><aside className="dispatch-drawer admin-user-drawer" role="dialog" aria-modal="true" aria-labelledby="managed-user-title">
    <header className="dispatch-drawer-header"><div><span className="eyebrow">USER ACCOUNT</span><h2 id="managed-user-title">{user?.name ?? 'User details'}</h2><span className="dispatch-drawer-id">{user?.email ?? 'Loading selected user'}</span></div><button className="dispatch-modal-close" type="button" aria-label="Close user details" onClick={onClose}><X size={18} /></button></header>
    <div className="dispatch-drawer-body">{isLoading ? <div className="dispatch-state"><span className="spinner spinner-small" /> Loading user details…</div> : error ? <div className="dispatch-alert" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></div> : user && <div className="admin-user-detail-list"><Detail label="User ID" value={user.id} /><Detail label="Name" value={user.name} /><Detail label="Email" value={user.email} /><Detail label="Role" value={user.role === 'admin' ? 'Admin' : 'Operator'} /><Detail label="Account status" value={user.isActive ? 'Active' : 'Inactive'} /><Detail label="Created" value={formatDate(user.createdAt)} /><Detail label="Last updated" value={formatDate(user.updatedAt)} /></div>}</div>
  </aside></div>
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="admin-user-detail"><span>{label}</span><strong>{value}</strong></div>
}

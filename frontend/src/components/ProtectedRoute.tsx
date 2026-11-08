import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useAgentAuth } from '../hooks/useAgentAuth'

function SessionLoading() {
  return (
    <main className="auth-loading">
      <span className="spinner" />
      <p>Checking your session…</p>
    </main>
  )
}

export function ProtectedRoute({ requiredRole }: { requiredRole?: 'admin' }) {
  const { user, isLoading, loadError } = useAuth()
  const location = useLocation()
  if (isLoading) return <SessionLoading />
  if (!user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname, error: loadError }}
      />
    )
  if (requiredRole && user.role !== requiredRole)
    return <Navigate to="/unauthorized" replace />
  return <Outlet />
}

export function GuestRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()
  if (isLoading) return <SessionLoading />
  return user ? <Navigate to="/dashboard" replace /> : children
}

export function AgentProtectedRoute() {
  const { agent, isLoading } = useAgentAuth()
  const location = useLocation()
  if (isLoading) return <SessionLoading />
  if (!agent) {
    return <Navigate to="/agent/login" replace state={{ from: location.pathname }} />
  }
  return <Outlet />
}

export function AgentGuestRoute({ children }: { children: ReactNode }) {
  const { agent, isLoading } = useAgentAuth()
  if (isLoading) return <SessionLoading />
  return agent ? <Navigate to="/agent/dashboard" replace /> : children
}

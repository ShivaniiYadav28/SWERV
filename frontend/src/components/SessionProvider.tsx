import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { AgentAuthProvider } from '../context/AgentAuthContext'
import { AuthProvider } from '../context/AuthContext'

export function SessionProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const isAgentRoute = pathname === '/agent' || pathname.startsWith('/agent/')
  const isPublicTrackingRoute = pathname === '/track' || pathname.startsWith('/track/')

  if (isPublicTrackingRoute) return <>{children}</>

  return isAgentRoute
    ? <AgentAuthProvider>{children}</AgentAuthProvider>
    : <AuthProvider>{children}</AuthProvider>
}

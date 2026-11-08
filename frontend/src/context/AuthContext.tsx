import { useEffect, useState, type ReactNode } from 'react'
import { apiRequest } from '../lib/api'
import type { AuthUser } from '../types/auth'
import {
  AuthContext,
  type AuthContextValue,
  type LoginCredentials,
  type RegistrationDetails,
} from './auth-context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadCurrentUser() {
      try {
        const response = await apiRequest<{ user: AuthUser }>('/api/auth/me')
        if (!cancelled) setUser(response.data?.user ?? null)
      } catch (error) {
        if (cancelled) return
        if (
          error instanceof Error &&
          error.message !== 'Authentication required.'
        ) {
          setLoadError(error.message)
        }
        setUser(null)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadCurrentUser()
    return () => {
      cancelled = true
    }
  }, [])

  async function login(credentials: LoginCredentials) {
    const response = await apiRequest<{ user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    })
    setUser(response.data?.user ?? null)
    setLoadError(null)
  }

  async function register(details: RegistrationDetails) {
    const response = await apiRequest<{ user: AuthUser }>(
      '/api/auth/register',
      {
        method: 'POST',
        body: JSON.stringify(details),
      },
    )
    setUser(response.data?.user ?? null)
    setLoadError(null)
  }

  async function logout() {
    try {
      await apiRequest<null>('/api/auth/logout', { method: 'POST' })
    } finally {
      setUser(null)
    }
  }

  const value: AuthContextValue = {
    user,
    isLoading,
    loadError,
    login,
    register,
    logout,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

import { createContext } from 'react'
import type { AuthUser } from '../types/auth'

export type LoginCredentials = { email: string; password: string }
export type RegistrationDetails = LoginCredentials & { name: string }
export type AuthContextValue = {
  user: AuthUser | null
  isLoading: boolean
  loadError: string | null
  login: (credentials: LoginCredentials) => Promise<void>
  register: (details: RegistrationDetails) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

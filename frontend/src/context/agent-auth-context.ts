import { createContext } from 'react'
import type { AgentProfile } from '../types/agentDelivery'

export type AgentAuthContextValue = {
  agent: AgentProfile | null
  isLoading: boolean
  loadError: string | null
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refreshAgent: () => Promise<AgentProfile>
  clearAgent: () => void
}

export const AgentAuthContext = createContext<AgentAuthContextValue | null>(null)

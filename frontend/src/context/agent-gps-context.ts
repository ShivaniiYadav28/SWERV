import { createContext } from 'react'

export type AgentGpsStatus = 'permission-required' | 'active' | 'unavailable' | 'stopped'

export type AgentGpsContextValue = {
  status: AgentGpsStatus
  message: string
  isEligible: boolean
  isEligibilityLoading: boolean
  isTracking: boolean
  lastReportedAt: string | null
  startTracking: () => void
  stopTracking: () => Promise<void>
}

export const AgentGpsContext = createContext<AgentGpsContextValue | null>(null)

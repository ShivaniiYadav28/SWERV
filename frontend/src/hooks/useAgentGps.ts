import { useContext } from 'react'
import { AgentGpsContext } from '../context/agent-gps-context'

export function useAgentGps() {
  const context = useContext(AgentGpsContext)
  if (!context) throw new Error('useAgentGps must be used inside the agent portal')
  return context
}

import { useContext } from 'react'
import { AgentAuthContext } from '../context/agent-auth-context'

export function useAgentAuth() {
  const context = useContext(AgentAuthContext)
  if (!context) throw new Error('useAgentAuth must be used inside AgentAuthProvider')
  return context
}

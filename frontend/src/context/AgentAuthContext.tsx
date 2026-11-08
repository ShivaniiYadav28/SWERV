import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApiError } from '../lib/api'
import { agentLogin, agentLogout, getCurrentAgent } from '../lib/agentPortal'
import { AgentAuthContext, type AgentAuthContextValue } from './agent-auth-context'
import type { AgentProfile } from '../types/agentDelivery'

export function AgentAuthProvider({ children }: { children: ReactNode }) {
  const [agent, setAgent] = useState<AgentProfile | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function checkAgentSession() {
      try {
        const currentAgent = await getCurrentAgent()
        if (isMounted) setAgent(currentAgent)
      } catch (error) {
        if (!isMounted) return
        if (!(error instanceof ApiError && error.status === 401)) {
          setLoadError(error instanceof Error ? error.message : 'Agent session could not be checked.')
        }
        setAgent(null)
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    void checkAgentSession()
    return () => { isMounted = false }
  }, [])

  async function login(email: string, password: string) {
    const signedInAgent = await agentLogin(email, password)
    setAgent(signedInAgent)
    setLoadError(null)
  }

  async function logout() {
    try {
      await agentLogout()
    } finally {
      setAgent(null)
    }
  }

  const refreshAgent = useCallback(async () => {
    const currentAgent = await getCurrentAgent()
    setAgent(currentAgent)
    return currentAgent
  }, [])

  const clearAgent = useCallback(() => setAgent(null), [])

  const value: AgentAuthContextValue = {
    agent,
    isLoading,
    loadError,
    login,
    logout,
    refreshAgent,
    clearAgent,
  }

  return <AgentAuthContext.Provider value={value}>{children}</AgentAuthContext.Provider>
}

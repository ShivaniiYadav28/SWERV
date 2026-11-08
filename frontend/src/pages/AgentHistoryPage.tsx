import { useEffect, useState } from 'react'
import { CheckCircle2, Clock3 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { AgentDeliveryCard } from '../components/AgentDeliveryCard'
import { useAgentAuth } from '../hooks/useAgentAuth'
import { ApiError } from '../lib/api'
import { getAgentDeliveryHistory } from '../lib/agentPortal'
import type { AgentDelivery } from '../types/agentDelivery'
import './agent-portal.css'

export function AgentHistoryPage() {
  const { clearAgent } = useAgentAuth()
  const navigate = useNavigate()
  const [deliveries, setDeliveries] = useState<AgentDelivery[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let isMounted = true
    async function loadHistory() {
      setIsLoading(true)
      setError('')
      try {
        const result = await getAgentDeliveryHistory()
        if (isMounted) setDeliveries(result)
      } catch (cause) {
        if (!isMounted) return
        if (cause instanceof ApiError && cause.status === 401) {
          clearAgent()
          navigate('/agent/login', { replace: true })
        } else {
          setError(cause instanceof Error ? cause.message : 'Delivery history could not be loaded.')
        }
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }
    void loadHistory()
    return () => { isMounted = false }
  }, [clearAgent, navigate, refreshKey])

  return (
    <>
      <section className="agent-page-heading">
        <div><div className="agent-eyebrow"><span />DELIVERY LOG</div><h1>Completed deliveries</h1><p>A record of the deliveries you’ve completed.</p></div>
        {!isLoading && <span className="agent-count-pill count-complete"><CheckCircle2 size={14} />{deliveries.length} completed</span>}
      </section>
      {error && <div className="agent-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Try again</button></div>}
      {isLoading ? (
        <div className="agent-state-card" role="status"><span className="spinner spinner-small" />Loading completed deliveries…</div>
      ) : error ? (
        <div className="agent-state-card">Your delivery history is unavailable right now.</div>
      ) : deliveries.length ? (
        <div className="agent-delivery-list grid gap-3">{deliveries.map((delivery) => <AgentDeliveryCard key={delivery._id} delivery={delivery} history />)}</div>
      ) : (
        <div className="agent-empty-card"><span><Clock3 size={20} /></span><strong>Your completed deliveries will appear here</strong><p>Once you mark a delivery complete, you can review it in your history.</p></div>
      )}
    </>
  )
}

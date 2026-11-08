import { useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, Clock3, PackageCheck, RefreshCw, Truck } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { AgentDeliveryCard } from '../components/AgentDeliveryCard'
import { AgentGpsStatusCard } from '../components/AgentGpsStatusCard'
import { useAgentAuth } from '../hooks/useAgentAuth'
import { ApiError } from '../lib/api'
import { getAgentDeliveries, getAgentDeliveryHistory } from '../lib/agentPortal'
import { formatAgentStatus } from '../lib/agentUi'
import type { AgentDelivery } from '../types/agentDelivery'
import './agent-portal.css'

export function AgentDashboardPage() {
  const { agent, clearAgent } = useAgentAuth()
  const navigate = useNavigate()
  const [deliveries, setDeliveries] = useState<AgentDelivery[]>([])
  const [completedCount, setCompletedCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let isMounted = true
    async function loadDashboard() {
      setIsLoading(true)
      setError('')
      try {
        const [activeDeliveries, history] = await Promise.all([getAgentDeliveries(), getAgentDeliveryHistory()])
        if (isMounted) {
          setDeliveries(activeDeliveries)
          setCompletedCount(history.length)
        }
      } catch (cause) {
        if (!isMounted) return
        if (cause instanceof ApiError && cause.status === 401) {
          clearAgent()
          navigate('/agent/login', { replace: true })
        } else {
          setError(cause instanceof Error ? cause.message : 'Dashboard information could not be loaded.')
        }
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }
    void loadDashboard()
    return () => { isMounted = false }
  }, [clearAgent, navigate, refreshKey])

  const firstName = agent?.name.trim().split(/\s+/)[0] ?? 'there'

  return (
    <>
      <section className="agent-welcome-row">
        <div><div className="agent-eyebrow"><span />YOUR DELIVERY SPACE</div><h1>Good to see you, {firstName}</h1><p>Here’s what’s moving with you today.</p></div>
        <button className="agent-refresh-button" type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={isLoading} aria-label="Refresh dashboard">
          <RefreshCw size={16} className={isLoading ? 'agent-refreshing' : ''} /><span>Refresh</span>
        </button>
      </section>

      <section className="agent-identity-banner">
        <div className="agent-identity-icon"><Truck size={21} /></div>
        <div className="agent-identity-copy"><span>DELIVERY AGENT</span><strong>{agent?.name}</strong><small>Agent code {agent?.agentCode}</small></div>
        <span className={`agent-identity-status status-${agent?.status}`}><i />{formatAgentStatus(agent?.status ?? '')}</span>
      </section>

      <AgentGpsStatusCard />

      {error && <div className="agent-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Try again</button></div>}

      <section className="agent-metric-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Delivery summary">
        <article className="agent-metric-card"><span className="agent-metric-icon metric-coral"><PackageCheck size={18} /></span><div><small>Active deliveries</small><strong>{isLoading ? '—' : deliveries.length}</strong><span>Assigned to you</span></div></article>
        <article className="agent-metric-card"><span className="agent-metric-icon metric-green"><CheckCircle2 size={18} /></span><div><small>Completed deliveries</small><strong>{isLoading ? '—' : completedCount}</strong><span>In your history</span></div></article>
        <article className="agent-metric-card"><span className="agent-metric-icon metric-slate"><Clock3 size={18} /></span><div><small>Current status</small><strong className="agent-metric-status">{formatAgentStatus(agent?.status ?? '')}</strong><span>Fleet availability</span></div></article>
      </section>

      <section className="agent-section-heading"><div><div className="agent-eyebrow"><span />ON YOUR ROUTE</div><h2>Active deliveries</h2><p>Stay up to date with each pickup and drop-off.</p></div><Link to="/agent/deliveries" className="agent-text-link">All deliveries <ArrowRight size={15} /></Link></section>
      {isLoading ? (
        <div className="agent-state-card" role="status"><span className="spinner spinner-small" />Loading your deliveries…</div>
      ) : error ? (
        <div className="agent-state-card">Your deliveries are unavailable right now.</div>
      ) : deliveries.length === 0 ? (
        <div className="agent-empty-card"><span><PackageCheck size={20} /></span><strong>You’re all caught up</strong><p>New assigned deliveries will appear here.</p></div>
      ) : (
        <div className="agent-delivery-list grid gap-3">
          {deliveries.slice(0, 3).map((delivery) => <AgentDeliveryCard key={delivery._id} delivery={delivery} />)}
        </div>
      )}
      {!isLoading && deliveries.length > 3 && <Link className="agent-more-deliveries" to="/agent/deliveries">View all {deliveries.length} active deliveries <ArrowRight size={15} /></Link>}
    </>
  )
}

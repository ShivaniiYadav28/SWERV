import { useEffect, useMemo, useState } from 'react'
import { PackageCheck, Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { AgentDeliveryCard } from '../components/AgentDeliveryCard'
import { useAgentAuth } from '../hooks/useAgentAuth'
import { ApiError } from '../lib/api'
import { getAgentDeliveries } from '../lib/agentPortal'
import type { AgentDelivery } from '../types/agentDelivery'
import './agent-portal.css'

export function AgentDeliveriesPage() {
  const { clearAgent } = useAgentAuth()
  const navigate = useNavigate()
  const [deliveries, setDeliveries] = useState<AgentDelivery[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let isMounted = true
    async function loadDeliveries() {
      setIsLoading(true)
      setError('')
      try {
        const result = await getAgentDeliveries()
        if (isMounted) setDeliveries(result)
      } catch (cause) {
        if (!isMounted) return
        if (cause instanceof ApiError && cause.status === 401) {
          clearAgent()
          navigate('/agent/login', { replace: true })
        } else {
          setError(cause instanceof Error ? cause.message : 'Deliveries could not be loaded.')
        }
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }
    void loadDeliveries()
    return () => { isMounted = false }
  }, [clearAgent, navigate, refreshKey])

  const visibleDeliveries = useMemo(() => {
    const query = search.trim().toLowerCase()
    return deliveries.filter((delivery) => {
      const matchesStatus = statusFilter === 'all' || delivery.status === statusFilter
      const searchableText = [
        delivery.customer.name,
        delivery.customer.phone,
        delivery.package.description,
        delivery._id,
        delivery.pickup.address,
        delivery.pickup.city,
        delivery.delivery.address,
        delivery.delivery.city,
      ].join(' ').toLowerCase()
      return matchesStatus && (!query || searchableText.includes(query))
    })
  }, [deliveries, search, statusFilter])

  return (
    <>
      <section className="agent-page-heading">
        <div><div className="agent-eyebrow"><span />YOUR ROUTE</div><h1>My deliveries</h1><p>Pickup and destination details for every active assignment.</p></div>
        {!isLoading && <span className="agent-count-pill">{deliveries.length} active</span>}
      </section>
      <section className="agent-list-toolbar" aria-label="Filter deliveries">
        <label className="agent-search-field"><Search size={16} /><span className="visually-hidden">Search deliveries</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customer, package or address" /></label>
        <label className="agent-filter-field"><span className="visually-hidden">Filter by status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="assigned">Assigned</option><option value="picked_up">Picked up</option><option value="in_transit">In transit</option></select></label>
      </section>
      {error && <div className="agent-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Try again</button></div>}
      {isLoading ? (
        <div className="agent-state-card" role="status"><span className="spinner spinner-small" />Loading active deliveries…</div>
      ) : error ? (
        <div className="agent-state-card">Your active deliveries are unavailable right now.</div>
      ) : visibleDeliveries.length ? (
        <div className="agent-delivery-list grid gap-3">{visibleDeliveries.map((delivery) => <AgentDeliveryCard key={delivery._id} delivery={delivery} />)}</div>
      ) : deliveries.length ? (
        <div className="agent-empty-card"><span><Search size={19} /></span><strong>No matching deliveries</strong><p>Try another name, address, or status.</p><button className="agent-quiet-button" type="button" onClick={() => { setSearch(''); setStatusFilter('all') }}>Clear filters</button></div>
      ) : (
        <div className="agent-empty-card"><span><PackageCheck size={20} /></span><strong>No active deliveries</strong><p>When a delivery is assigned to you, it will show up here.</p></div>
      )}
    </>
  )
}

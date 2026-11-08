import { ArrowRight, Package } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatDeliveryDate, formatDeliveryStatus, formatPriority, locationSummary } from '../lib/agentUi'
import type { AgentDelivery } from '../types/agentDelivery'

export function AgentDeliveryCard({ delivery, history = false }: { delivery: AgentDelivery; history?: boolean }) {
  return (
    <Link className="agent-delivery-card" to={`/agent/deliveries/${delivery._id}`}>
      <div className="agent-delivery-card-top">
        <div className="agent-delivery-id">DELIVERY <span>#{delivery._id.slice(-8).toUpperCase()}</span></div>
        <span className={`agent-delivery-status status-${delivery.status}`}>{formatDeliveryStatus(delivery.status)}</span>
      </div>
      <div className="agent-delivery-card-customer">
        <span className="agent-customer-initial">{delivery.customer.name.trim().charAt(0).toUpperCase()}</span>
        <div><strong>{delivery.customer.name}</strong><small>{delivery.customer.phone}</small></div>
      </div>
      <div className="agent-delivery-route">
        <div className="agent-route-point"><span className="route-pickup-dot" /><div><small>Pickup</small><strong>{locationSummary(delivery.pickup)}</strong></div></div>
        <div className="agent-route-separator"><ArrowRight size={16} /></div>
        <div className="agent-route-point"><span className="route-delivery-dot" /><div><small>Destination</small><strong>{locationSummary(delivery.delivery)}</strong></div></div>
      </div>
      <div className="agent-delivery-card-bottom">
        <span><Package size={14} />{delivery.package.description}</span>
        <span className={`agent-priority priority-${delivery.priority}`}>{formatPriority(delivery.priority)}</span>
        <time>{history ? `Completed ${formatDeliveryDate(delivery.updatedAt)}` : `Updated ${formatDeliveryDate(delivery.updatedAt)}`}</time>
      </div>
    </Link>
  )
}

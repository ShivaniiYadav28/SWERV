import { useEffect, useState } from 'react'
import { ArrowLeft, Check, CheckCircle2, Clock3, Mail, MapPin, Package, Phone, Truck } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAgentAuth } from '../hooks/useAgentAuth'
import { ApiError } from '../lib/api'
import { getAgentDelivery, updateAgentDeliveryStatus } from '../lib/agentPortal'
import { formatDeliveryDate, formatDeliveryStatus, formatPriority } from '../lib/agentUi'
import type { AgentDelivery, AgentDeliveryDetails } from '../types/agentDelivery'
import { ProofOfDeliveryWorkflow } from '../components/ProofOfDeliveryWorkflow'
import './agent-portal.css'

const deliverySteps: { status: AgentDelivery['status']; label: string }[] = [
  { status: 'assigned', label: 'Assigned' },
  { status: 'picked_up', label: 'Picked up' },
  { status: 'in_transit', label: 'In transit' },
  { status: 'delivered', label: 'Delivered' },
]

type AgentProgressAction = 'picked_up' | 'in_transit'

const nextStatuses: Partial<Record<AgentDelivery['status'], AgentProgressAction>> = {
  assigned: 'picked_up',
  picked_up: 'in_transit',
}

const actionLabels: Record<AgentProgressAction, string> = {
  picked_up: 'Mark package as picked up',
  in_transit: 'Start delivery route',
}

export function AgentDeliveryDetailsPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { clearAgent } = useAgentAuth()
  const [details, setDetails] = useState<AgentDeliveryDetails | null>(null)
  const [detailsId, setDetailsId] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isUpdating, setIsUpdating] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let isMounted = true
    async function loadDetails() {
      setIsLoading(true)
      setError('')
      try {
        const result = await getAgentDelivery(id)
        if (isMounted) {
          setDetails(result)
          setDetailsId(id)
        }
      } catch (cause) {
        if (!isMounted) return
        if (cause instanceof ApiError && cause.status === 401) {
          clearAgent()
          navigate('/agent/login', { replace: true })
        } else {
          setError(cause instanceof Error ? cause.message : 'Delivery details could not be loaded.')
        }
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }
    void loadDetails()
    return () => { isMounted = false }
  }, [clearAgent, id, navigate])

  async function updateStatus() {
    const delivery = details?.dispatchRequest
    const nextStatus = delivery ? nextStatuses[delivery.status] : undefined
    if (!delivery || !nextStatus || isUpdating) return
    setIsUpdating(true)
    setActionError('')
    try {
      const updatedDelivery = await updateAgentDeliveryStatus(delivery._id, nextStatus)
      setDetails((current) => current ? { ...current, dispatchRequest: updatedDelivery } : current)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        clearAgent()
        navigate('/agent/login', { replace: true })
      } else {
        setActionError(cause instanceof Error ? cause.message : 'Delivery status could not be updated.')
      }
    } finally {
      setIsUpdating(false)
    }
  }

  async function refreshAfterPod() {
    try { setDetails(await getAgentDelivery(id)) }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Updated delivery details could not be loaded.') }
  }

  const delivery = details?.dispatchRequest
  const currentStep = deliverySteps.findIndex((step) => step.status === delivery?.status)
  const nextStatus = delivery ? nextStatuses[delivery.status] : undefined

  if (isLoading || (detailsId !== id && !error)) return <div className="agent-state-card" role="status"><span className="spinner spinner-small" />Loading delivery details…</div>
  if (error || !delivery) {
    return <section className="agent-detail-error"><Link className="agent-back-link" to="/agent/deliveries"><ArrowLeft size={15} />Back to deliveries</Link><div className="agent-empty-card"><span><Package size={20} /></span><strong>{error || 'Delivery not found'}</strong><p>This delivery may no longer be assigned to your account.</p></div></section>
  }

  return (
    <>
      <Link className="agent-back-link" to="/agent/deliveries"><ArrowLeft size={15} />Back to deliveries</Link>
      <section className="agent-detail-heading">
        <div><div className="agent-eyebrow"><span />DELIVERY #{delivery._id.slice(-8).toUpperCase()}</div><h1>{delivery.customer.name}</h1><p>{delivery.package.description} <span>·</span> Created {formatDeliveryDate(delivery.createdAt)}</p></div>
        <span className={`agent-delivery-status status-${delivery.status}`}>{formatDeliveryStatus(delivery.status)}</span>
      </section>

      <section className="agent-progress-panel" aria-label="Delivery progress">
        <div className="agent-progress-heading"><div><span className="agent-section-icon"><Truck size={17} /></span><div><strong>Delivery progress</strong><small>Follow each step to complete this delivery.</small></div></div><span className={`agent-priority priority-${delivery.priority}`}>{formatPriority(delivery.priority)} priority</span></div>
        <ol className="agent-progress-steps">
          {deliverySteps.map((step, index) => {
            const isComplete = currentStep >= index
            const isCurrent = currentStep === index
            return <li key={step.status} className={`${isComplete ? 'complete' : ''}${isCurrent ? ' current' : ''}`}><span className="agent-progress-marker">{isComplete && !isCurrent ? <Check size={13} /> : index + 1}</span><span className="agent-progress-label">{step.label}</span></li>
          })}
        </ol>
        {nextStatus ? (
          <div className="agent-action-area">
            {actionError && <div className="agent-action-error" role="alert">{actionError}</div>}
            <button className="agent-primary-action" type="button" onClick={() => void updateStatus()} disabled={isUpdating}>
              {isUpdating ? <><span className="spinner spinner-small" />Updating delivery…</> : <><Truck size={17} />{actionLabels[nextStatus]}</>}
            </button>
          </div>
        ) : delivery.status === 'delivered' ? (
          <div className="agent-complete-message"><CheckCircle2 size={17} />Delivered on {formatDeliveryDate(delivery.updatedAt)}. This delivery is complete.</div>
        ) : (
          <div className="agent-complete-message"><Clock3 size={17} />No further delivery actions are available for this request.</div>
        )}
      </section>

      {delivery.status !== 'delivered' && <ProofOfDeliveryWorkflow dispatchId={delivery._id} dispatchStatus={delivery.status} onComplete={() => void refreshAfterPod()} />}

      <section className="agent-detail-grid grid grid-cols-1 gap-3 md:grid-cols-2">
        <article className="agent-info-panel">
          <div className="agent-info-panel-heading"><span className="agent-section-icon pickup-icon"><MapPin size={17} /></span><div><small>STOP 1</small><h2>Pickup</h2></div></div>
          <address><strong>{delivery.pickup.address}{delivery.pickup.addressLine2 ? `, ${delivery.pickup.addressLine2}` : ''}</strong><span>{delivery.pickup.city}, {delivery.pickup.region} {delivery.pickup.postalCode}</span><span>{delivery.pickup.country}</span></address>
          {delivery.pickup.instructions && <div className="agent-instructions"><small>Pickup instructions</small><p>{delivery.pickup.instructions}</p></div>}
        </article>
        <article className="agent-info-panel">
          <div className="agent-info-panel-heading"><span className="agent-section-icon destination-icon"><MapPin size={17} /></span><div><small>STOP 2</small><h2>Destination</h2></div></div>
          <address><strong>{delivery.delivery.address}{delivery.delivery.addressLine2 ? `, ${delivery.delivery.addressLine2}` : ''}</strong><span>{delivery.delivery.city}, {delivery.delivery.region} {delivery.delivery.postalCode}</span><span>{delivery.delivery.country}</span></address>
          {delivery.delivery.instructions && <div className="agent-instructions"><small>Delivery instructions</small><p>{delivery.delivery.instructions}</p></div>}
        </article>
        <article className="agent-info-panel">
          <div className="agent-info-panel-heading"><span className="agent-section-icon"><Package size={17} /></span><div><small>HANDLE WITH CARE</small><h2>Package</h2></div></div>
          <div className="agent-fact-list"><div><span>Description</span><strong>{delivery.package.description}</strong></div><div><span>Category</span><strong>{delivery.package.category.replaceAll('_', ' ')}</strong></div><div><span>Weight</span><strong>{delivery.package.weightKg} kg</strong></div><div><span>Quantity</span><strong>{delivery.package.quantity} {delivery.package.quantity === 1 ? 'item' : 'items'}</strong></div><div><span>Priority</span><strong>{formatPriority(delivery.priority)}</strong></div></div>
        </article>
        <article className="agent-info-panel agent-customer-panel">
          <div className="agent-info-panel-heading"><span className="agent-section-icon"><Phone size={17} /></span><div><small>RECEIVER</small><h2>Customer contact</h2></div></div>
          <div className="agent-contact-name"><span className="agent-customer-initial">{delivery.customer.name.trim().charAt(0).toUpperCase()}</span><strong>{delivery.customer.name}</strong></div>
          <a className="agent-contact-link" href={`tel:${delivery.customer.phone}`}><Phone size={15} />{delivery.customer.phone}</a>
          <a className="agent-contact-link" href={`mailto:${delivery.customer.email}`}><Mail size={15} />{delivery.customer.email}</a>
        </article>
      </section>
    </>
  )
}

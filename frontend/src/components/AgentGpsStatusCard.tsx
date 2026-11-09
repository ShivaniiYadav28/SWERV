import { useAgentGps } from '../hooks/useAgentGps'
import { formatDeliveryDate } from '../lib/agentUi'
import './AgentGpsStatusCard.css'

const statusLabels = {
  'permission-required': 'GPS permission required',
  active: 'GPS active',
  unavailable: 'GPS temporarily unavailable',
  stopped: 'GPS stopped',
}

export function AgentGpsStatusCard({ compact = false }: { compact?: boolean }) {
  const {
    status,
    message,
    isEligible,
    isEligibilityLoading,
    isTracking,
    lastReportedAt,
    startTracking,
    stopTracking,
  } = useAgentGps()

  if (compact) {
    return (
      <span className={`agent-gps-compact gps-${status}`} title={message} aria-label={statusLabels[status]}>
        <i />GPS <strong>{status === 'active' ? 'On' : status === 'unavailable' ? 'Waiting' : status === 'permission-required' ? 'Setup' : 'Off'}</strong>
      </span>
    )
  }

  const buttonLabel = isTracking ? 'Stop GPS' : status === 'permission-required' ? 'Enable GPS' : 'Start GPS'

  return (
    <section className={`agent-gps-card gps-${status}`} aria-label="GPS tracking status">
      <div className="agent-gps-icon"><i /></div>
      <div className="agent-gps-copy">
        <div className="agent-gps-title-row"><strong>{statusLabels[status]}</strong><span className={`agent-gps-state-tag gps-${status}`}>{status === 'active' ? 'LIVE' : status === 'unavailable' ? 'RETRYING' : status === 'permission-required' ? 'ACTION NEEDED' : 'OFF'}</span></div>
        <p>{isEligibilityLoading ? 'Checking your active deliveries…' : !isEligible ? 'GPS starts automatically when you have an active delivery.' : message}</p>
        {lastReportedAt && status === 'active' && <small>Last update sent {formatDeliveryDate(lastReportedAt)}</small>}
      </div>
      <button
        className={`agent-gps-button${isTracking ? ' is-stop' : ''}`}
        type="button"
        onClick={() => isTracking ? void stopTracking() : startTracking()}
        disabled={isEligibilityLoading || (!isEligible && !isTracking)}
      >
        {isEligibilityLoading ? 'Checking…' : buttonLabel}
      </button>
    </section>
  )
}

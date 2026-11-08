import type { DispatchLocation } from '../types/dispatchRequest'
import type { AgentDelivery } from '../types/agentDelivery'

export function formatDeliveryStatus(status: AgentDelivery['status']): string {
  const labels: Partial<Record<AgentDelivery['status'], string>> = {
    assigned: 'Assigned',
    picked_up: 'Picked up',
    in_transit: 'In transit',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    failed: 'Failed',
  }
  return labels[status] ?? status.replaceAll('_', ' ')
}

export function formatAgentStatus(status: string): string {
  const labels: Record<string, string> = {
    available: 'Available',
    unavailable: 'Unavailable',
    on_duty: 'On duty',
    suspended: 'Suspended',
  }
  return labels[status] ?? status.replaceAll('_', ' ')
}

export function formatPriority(priority: string): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1)
}

export function formatDeliveryDate(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function locationSummary(location: DispatchLocation): string {
  return [location.address, location.addressLine2, location.city, location.region]
    .filter(Boolean)
    .join(', ')
}

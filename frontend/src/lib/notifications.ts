import { apiRequest } from './api'
import type { NotificationItem, NotificationPage, NotificationRecipientType } from '../types/notification'

const supportedEventTypes = new Set([
  'new_dispatch', 'dispatch_assigned', 'dispatch_reassigned', 'dispatch_status_changed',
  'delivery_completed', 'anomaly_detected', 'agent_status_changed',
])

function notificationPath(recipientType: NotificationRecipientType) {
  return recipientType === 'agent' ? '/api/agent/notifications' : '/api/notifications'
}

export function isNotificationItem(value: unknown): value is NotificationItem {
  if (!value || typeof value !== 'object') return false
  const notification = value as NotificationItem
  return typeof notification.id === 'string'
    && (notification.recipientType === 'user' || notification.recipientType === 'agent')
    && typeof notification.recipientId === 'string'
    && supportedEventTypes.has(notification.eventType)
    && typeof notification.title === 'string'
    && typeof notification.message === 'string'
    && (notification.relatedEntityType === null || ['dispatch', 'anomaly_alert', 'agent'].includes(String(notification.relatedEntityType)))
    && (notification.relatedEntityId === null || typeof notification.relatedEntityId === 'string')
    && typeof notification.createdAt === 'string'
    && (notification.readAt === null || typeof notification.readAt === 'string')
}

export function mergeNotification(items: NotificationItem[], incoming: NotificationItem): NotificationItem[] {
  return [incoming, ...items.filter((item) => item.id !== incoming.id)]
}

export function unreadBadgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export function notificationTarget(notification: NotificationItem, isAgent: boolean, isAdmin: boolean): string | null {
  if (notification.relatedEntityType === 'dispatch') {
    if (isAgent) {
      return notification.relatedEntityId
        ? `/agent/deliveries/${encodeURIComponent(notification.relatedEntityId)}`
        : null
    }
    return notification.relatedEntityId
      ? `/dispatch-requests?dispatchId=${encodeURIComponent(notification.relatedEntityId)}`
      : null
  }
  if (notification.relatedEntityType === 'anomaly_alert' && isAdmin) return '/admin/anomaly-detection'
  if (notification.relatedEntityType === 'agent' && !isAgent) return '/agents'
  return null
}

export function navigateToNotification(
  notification: NotificationItem,
  isAgent: boolean,
  isAdmin: boolean,
  navigate: (path: string) => void,
): boolean {
  const target = notificationTarget(notification, isAgent, isAdmin)
  if (!target) return false
  navigate(target)
  return true
}

export async function getNotifications(
  recipientType: NotificationRecipientType,
  page = 1,
  limit = 10,
): Promise<NotificationPage> {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) })
  const response = await apiRequest<NotificationPage>(`${notificationPath(recipientType)}?${query}`)
  if (!response.data || !Array.isArray(response.data.notifications)
    || !response.data.notifications.every(isNotificationItem)
    || !response.data.pagination || !Number.isInteger(response.data.pagination.pages)) {
    throw new Error('The notification service returned an invalid list.')
  }
  return response.data
}

export async function getUnreadNotificationCount(recipientType: NotificationRecipientType): Promise<number> {
  const response = await apiRequest<{ count: number }>(`${notificationPath(recipientType)}/unread-count`)
  const count = response.data?.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new Error('The unread notification count was invalid.')
  }
  return count
}

export async function markNotificationRead(recipientType: NotificationRecipientType, notificationId: string): Promise<NotificationItem> {
  const response = await apiRequest<{ notification: NotificationItem }>(
    `${notificationPath(recipientType)}/${encodeURIComponent(notificationId)}/read`,
    { method: 'PATCH', body: JSON.stringify({}) },
  )
  if (!isNotificationItem(response.data?.notification)) throw new Error('The updated notification was invalid.')
  return response.data.notification
}

export async function markAllNotificationsRead(recipientType: NotificationRecipientType): Promise<number> {
  const response = await apiRequest<{ updatedCount: number }>(`${notificationPath(recipientType)}/read-all`, {
    method: 'PATCH', body: JSON.stringify({}),
  })
  const updatedCount = response.data?.updatedCount
  if (typeof updatedCount !== 'number' || !Number.isInteger(updatedCount) || updatedCount < 0) {
    throw new Error('The notification update response was invalid.')
  }
  return updatedCount
}

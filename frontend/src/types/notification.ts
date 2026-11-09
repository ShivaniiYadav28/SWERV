export type NotificationRecipientType = 'user' | 'agent'

export type NotificationEventType =
  | 'new_dispatch'
  | 'dispatch_assigned'
  | 'dispatch_reassigned'
  | 'dispatch_status_changed'
  | 'delivery_completed'
  | 'anomaly_detected'
  | 'agent_status_changed'

export type NotificationRelatedEntityType = 'dispatch' | 'anomaly_alert' | 'agent'

export type NotificationItem = {
  id: string
  recipientType: NotificationRecipientType
  recipientId: string
  eventType: NotificationEventType
  title: string
  message: string
  relatedEntityType: NotificationRelatedEntityType | null
  relatedEntityId: string | null
  createdAt: string
  readAt: string | null
}

export type NotificationPage = {
  notifications: NotificationItem[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Bell, CheckCheck, ExternalLink, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { connectRealtime, notificationNewEvent } from '../lib/realtime'
import {
  getNotifications,
  getUnreadNotificationCount,
  isNotificationItem,
  markAllNotificationsRead,
  markNotificationRead,
  mergeNotification,
  navigateToNotification,
  notificationTarget,
  unreadBadgeLabel,
} from '../lib/notifications'
import type { NotificationItem, NotificationRecipientType } from '../types/notification'

type NotificationBellProps = {
  recipientType: NotificationRecipientType
  recipientId: string
  isAdmin?: boolean
}

function notificationTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

export function NotificationBell({ recipientType, recipientId, isAdmin = false }: NotificationBellProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [markingId, setMarkingId] = useState('')
  const [isMarkingAll, setIsMarkingAll] = useState(false)
  const [error, setError] = useState('')
  const knownIds = useRef(new Set<string>())
  const navigate = useNavigate()

  const refreshNotifications = useCallback(async () => {
    try {
      const [result, count] = await Promise.all([
        getNotifications(recipientType),
        getUnreadNotificationCount(recipientType),
      ])
      setNotifications(result.notifications)
      setPage(result.pagination.page)
      setPageCount(result.pagination.pages)
      setUnreadCount(count)
      knownIds.current = new Set(result.notifications.map((notification) => notification.id))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Notifications could not be loaded.')
    } finally {
      setIsLoading(false)
    }
  }, [recipientType])

  useEffect(() => {
    let active = true
    const socket = connectRealtime()
    const initialLoad = window.setTimeout(() => void refreshNotifications(), 0)
    const refreshIfActive = () => { if (active) void refreshNotifications() }
    const onNewNotification = (value: unknown) => {
      if (!isNotificationItem(value) || value.recipientType !== recipientType || value.recipientId !== recipientId) return
      const isNew = !knownIds.current.has(value.id)
      knownIds.current.add(value.id)
      setNotifications((current) => mergeNotification(current, value))
      if (isNew && value.readAt === null) setUnreadCount((count) => count + 1)
    }
    socket.on('connect', refreshIfActive)
    socket.on(notificationNewEvent, onNewNotification)
    return () => {
      active = false
      window.clearTimeout(initialLoad)
      socket.off('connect', refreshIfActive)
      socket.off(notificationNewEvent, onNewNotification)
      socket.disconnect()
    }
  }, [recipientId, recipientType, refreshNotifications])

  async function loadMore() {
    const nextPage = page + 1
    if (nextPage > pageCount || isLoadingMore) return
    setIsLoadingMore(true)
    setError('')
    try {
      const result = await getNotifications(recipientType, nextPage)
      setNotifications((current) => {
        const merged = [...current]
        for (const item of result.notifications) {
          if (!knownIds.current.has(item.id)) merged.push(item)
          knownIds.current.add(item.id)
        }
        return merged
      })
      setPage(nextPage)
      setPageCount(result.pagination.pages)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'More notifications could not be loaded.')
    } finally {
      setIsLoadingMore(false)
    }
  }

  async function handleMarkRead(notification: NotificationItem) {
    if (notification.readAt || markingId) return
    setMarkingId(notification.id)
    setError('')
    try {
      const updated = await markNotificationRead(recipientType, notification.id)
      setNotifications((current) => current.map((item) => item.id === updated.id ? updated : item))
      setUnreadCount((count) => Math.max(0, count - 1))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The notification could not be marked as read.')
    } finally {
      setMarkingId('')
    }
  }

  async function handleMarkAllRead() {
    if (unreadCount === 0 || isMarkingAll) return
    setIsMarkingAll(true)
    setError('')
    try {
      await markAllNotificationsRead(recipientType)
      const readAt = new Date().toISOString()
      setNotifications((current) => current.map((item) => item.readAt ? item : { ...item, readAt }))
      setUnreadCount(0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Notifications could not be marked as read.')
    } finally {
      setIsMarkingAll(false)
    }
  }

  function openNotification(event: MouseEvent<HTMLButtonElement>, notification: NotificationItem) {
    event.preventDefault()
    event.stopPropagation()
    const didNavigate = navigateToNotification(notification, recipientType === 'agent', isAdmin, navigate)
    if (!didNavigate) return
    setIsOpen(false)
  }

  return (
    <div className="notification-bell-wrap">
      <button
        className="notification-bell-button"
        type="button"
        aria-label={unreadCount ? `Notifications, ${unreadBadgeLabel(unreadCount)} unread` : 'Notifications'}
        aria-expanded={isOpen}
        aria-controls="notification-panel"
        onClick={() => {
          const opening = !isOpen
          setIsOpen(opening)
          if (opening) void refreshNotifications()
        }}
      >
        <Bell size={18} />
        {unreadCount > 0 && <span className="notification-badge">{unreadBadgeLabel(unreadCount)}</span>}
      </button>

      {isOpen && <section id="notification-panel" className="notification-panel" aria-label="Notifications">
        <header className="notification-panel-header">
          <div><strong>Notifications</strong><small>{unreadCount} unread</small></div>
          <div className="notification-panel-actions">
            <button type="button" onClick={() => void handleMarkAllRead()} disabled={unreadCount === 0 || isMarkingAll} aria-label="Mark all notifications as read" title="Mark all as read"><CheckCheck size={16} /></button>
            <button type="button" onClick={() => setIsOpen(false)} aria-label="Close notifications"><X size={17} /></button>
          </div>
        </header>
        {error && <p className="notification-error" role="alert">{error}<button type="button" onClick={() => void refreshNotifications()}>Retry</button></p>}
        {isLoading ? <p className="notification-state" role="status">Loading notifications…</p>
          : notifications.length === 0 ? <p className="notification-state">You’re all caught up. No notifications yet.</p>
            : <div className="notification-list">{notifications.map((notification) => {
              const target = notificationTarget(notification, recipientType === 'agent', isAdmin)
              return <article className={`notification-item ${notification.readAt ? 'is-read' : 'is-unread'}`} key={notification.id}>
                <span className="notification-read-dot" aria-label={notification.readAt ? 'Read' : 'Unread'} />
                <div className="notification-item-content">
                  <strong>{notification.title}</strong>
                  <p>{notification.message}</p>
                  <small>{notificationTime(notification.createdAt)}{notification.relatedEntityId && <> · #{notification.relatedEntityId.slice(-8).toUpperCase()}</>}</small>
                  <div className="notification-item-actions">
                    {target
                      ? <button type="button" onClick={(event) => openNotification(event, notification)}>Open <ExternalLink size={12} /></button>
                      : <span className="notification-no-destination">No supported destination</span>}
                    {!notification.readAt && <button type="button" onClick={() => void handleMarkRead(notification)} disabled={markingId === notification.id}>{markingId === notification.id ? 'Saving…' : 'Mark read'}</button>}
                  </div>
                </div>
              </article>
            })}</div>}
        {!isLoading && page < pageCount && <button className="notification-load-more" type="button" onClick={() => void loadMore()} disabled={isLoadingMore}>{isLoadingMore ? 'Loading…' : 'Load more'}</button>}
      </section>}
    </div>
  )
}

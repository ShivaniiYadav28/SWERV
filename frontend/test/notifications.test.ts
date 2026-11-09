import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  mergeNotification,
  navigateToNotification,
  notificationTarget,
  unreadBadgeLabel,
} from '../src/lib/notifications.ts'

const item = {
  id: '507f1f77bcf86cd799439011',
  recipientType: 'user' as const,
  recipientId: '507f1f77bcf86cd799439012',
  eventType: 'new_dispatch' as const,
  title: 'New dispatch',
  message: 'Dispatch #9439011 is ready.',
  relatedEntityType: 'dispatch' as const,
  relatedEntityId: '507f1f77bcf86cd799439013',
  createdAt: new Date().toISOString(),
  readAt: null,
}

describe('notification frontend helpers', () => {
  it('caps unread badge text and avoids duplicate real-time items', () => {
    assert.equal(unreadBadgeLabel(3), '3')
    assert.equal(unreadBadgeLabel(100), '99+')
    assert.deepEqual(mergeNotification([item], item), [item])
  })

  it('uses only existing routes for related dispatches and anomaly alerts', () => {
    assert.equal(notificationTarget(item, false, false), `/dispatch-requests?dispatchId=${item.relatedEntityId}`)
    assert.equal(notificationTarget({ ...item, relatedEntityType: 'dispatch' }, true, false), `/agent/deliveries/${item.relatedEntityId}`)
    assert.equal(notificationTarget({ ...item, relatedEntityId: null }, true, false), null)
    assert.equal(notificationTarget({ ...item, relatedEntityType: 'anomaly_alert' }, false, true), '/admin/anomaly-detection')
    assert.equal(notificationTarget({ ...item, relatedEntityType: 'anomaly_alert' }, false, false), null)
    assert.equal(notificationTarget({ ...item, relatedEntityType: null, relatedEntityId: null }, false, true), null)
  })

  it('opens the specific dispatch from the notification related entity ID', () => {
    const rohanDispatchId = '507f1f77bcf86cd799439013'
    const rohanNotification = {
      ...item,
      title: 'New dispatch for Rohan Mehta',
      message: 'Dispatch reference #63A23FB6 is ready.',
      relatedEntityId: rohanDispatchId,
    }
    const navigatedPaths: string[] = []

    const didNavigate = navigateToNotification(rohanNotification, false, false, (path) => navigatedPaths.push(path))

    assert.equal(didNavigate, true)
    assert.deepEqual(navigatedPaths, [`/dispatch-requests?dispatchId=${rohanDispatchId}`])
    assert.ok(!navigatedPaths[0].includes('63A23FB6'), 'the display reference is not used as the database ID')
  })

  it('keeps agent delivery and admin anomaly destinations working', () => {
    const navigatedPaths: string[] = []
    const navigate = (path: string) => { navigatedPaths.push(path) }

    assert.equal(navigateToNotification(item, true, false, navigate), true)
    assert.equal(navigateToNotification({ ...item, relatedEntityType: 'anomaly_alert' }, false, true, navigate), true)
    assert.equal(navigateToNotification({ ...item, relatedEntityType: null, relatedEntityId: null }, false, true, navigate), false)
    assert.deepEqual(navigatedPaths, [
      `/agent/deliveries/${item.relatedEntityId}`,
      '/admin/anomaly-detection',
    ])
  })

  it('uses the authenticated agent notification API route', async () => {
    const originalFetch = globalThis.fetch
    let requestedUrl = ''
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input)
      return Response.json({ success: true, message: 'ok', data: { count: 2 } })
    }) as typeof fetch
    try {
      assert.equal(await getUnreadNotificationCount('agent'), 2)
      assert.ok(requestedUrl.endsWith('/api/agent/notifications/unread-count'))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('lists, marks one, and marks all notifications through the API helper', async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; method: string }> = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ url, method })
      if (url.includes('read-all')) {
        return Response.json({ success: true, message: 'ok', data: { updatedCount: 1 } })
      }
      if (url.endsWith('/read')) {
        return Response.json({ success: true, message: 'ok', data: { notification: { ...item, readAt: new Date().toISOString() } } })
      }
      return Response.json({ success: true, message: 'ok', data: { notifications: [item], pagination: { page: 1, limit: 10, total: 1, pages: 1 } } })
    }) as typeof fetch
    try {
      assert.equal((await getNotifications('user')).notifications.length, 1)
      assert.ok((await markNotificationRead('user', item.id)).readAt)
      assert.equal(await markAllNotificationsRead('user'), 1)
      assert.ok(requests[0].url.endsWith('/api/notifications?page=1&limit=10'))
      assert.deepEqual(requests.slice(1).map((request) => request.method), ['PATCH', 'PATCH'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('shows a clear error for invalid API responses and network failures', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ success: true, data: { count: -1 } })) as typeof fetch
    try {
      await assert.rejects(getUnreadNotificationCount('user'), /count was invalid/)
    } finally {
      globalThis.fetch = originalFetch
    }
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
    try {
      await assert.rejects(getNotifications('user'), /backend CORS settings/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

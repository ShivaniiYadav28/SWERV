import assert from 'node:assert/strict'
import { createElement } from 'react'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { MemoryRouter } from 'react-router-dom'
import { NotificationBell } from '../src/components/NotificationBell.tsx'

Reflect.set(globalThis, 'React', React)

describe('notification bell', () => {
  it('renders an accessible closed bell without marking anything as read', () => {
    const markup = renderToStaticMarkup(createElement(
      MemoryRouter,
      null,
      createElement(NotificationBell, { recipientType: 'user', recipientId: 'user-1', isAdmin: true }),
    ))

    assert.match(markup, /aria-label="Notifications"/)
    assert.match(markup, /aria-expanded="false"/)
    assert.doesNotMatch(markup, /<section id="notification-panel"/)
    assert.doesNotMatch(markup, /notification-badge/)
  })
})

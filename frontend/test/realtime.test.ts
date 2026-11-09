import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectRealtime, dispatchUpdateEvent, fleetLocationEvent } from '../src/lib/realtime.ts'

describe('realtime client helper', () => {
  it('uses authenticated cookies and reconnects when the connection drops', () => {
    const socket = connectRealtime()
    try {
      assert.equal(socket.io.opts.withCredentials, true)
      assert.equal(socket.io.opts.reconnection, true)
      assert.equal(fleetLocationEvent, 'fleet:location')
      assert.equal(dispatchUpdateEvent, 'dispatch:updated')
    } finally {
      socket.disconnect()
    }
  })
})

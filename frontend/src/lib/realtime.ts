import { io, type Socket } from 'socket.io-client'

const socketBase = (import.meta.env?.VITE_API_URL ?? 'http://localhost:5000').replace(/\/$/, '')

export const fleetLocationEvent = 'fleet:location'
export const dispatchUpdateEvent = 'dispatch:updated'
export const notificationNewEvent = 'notification:new'

export type DispatchUpdate = {
  dispatchId: string
  status: string
  assignedAgentId: string | null
}

export function connectRealtime(): Socket {
  return io(socketBase, { withCredentials: true, autoConnect: true, reconnection: true })
}

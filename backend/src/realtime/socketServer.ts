import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { getActiveAgentById, verifyAgentToken } from '../services/agentAuthService.js';
import { getActiveUserById } from '../services/authService.js';
import type { NotificationPayload } from '../services/notificationService.js';
import { AGENT_AUTH_COOKIE_NAME } from '../utils/agentJwt.js';
import { AUTH_COOKIE_NAME, getJwtSecret } from '../utils/jwt.js';

export const fleetRoom = 'fleet:monitors';
export const fleetLocationEvent = 'fleet:location';
export const dispatchUpdateEvent = 'dispatch:updated';
export const notificationNewEvent = 'notification:new';

export type FleetLocationUpdate = {
  agentId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  recordedAt: string;
  receivedAt: string;
  agent: {
    _id: string;
    agentCode: string;
    name: string;
    status: string;
    vehicle: { vehicleType: string; registrationNumber: string; manufacturer: string; model: string };
  };
  activeDispatch: { _id: string; status: string; priority: string } | null;
};

export type DispatchUpdate = {
  dispatchId: string;
  status: string;
  assignedAgentId: string | null;
};

type SocketPrincipal =
  | { type: 'agent'; agentId: string }
  | { type: 'user'; userId: string; role: 'admin' | 'operator' };

let socketServer: Server | null = null;

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!cookie) return null;
  try { return decodeURIComponent(cookie.slice(name.length + 1)); } catch { return null; }
}

async function authenticateSocket(cookieHeader: string | undefined): Promise<SocketPrincipal | null> {
  const agentToken = readCookie(cookieHeader, AGENT_AUTH_COOKIE_NAME);
  if (agentToken) {
    const agentId = verifyAgentToken(agentToken);
    if (!agentId || !(await getActiveAgentById(agentId))) return null;
    return { type: 'agent', agentId };
  }

  const userToken = readCookie(cookieHeader, AUTH_COOKIE_NAME);
  if (!userToken) return null;
  try {
    const decoded = jwt.verify(userToken, getJwtSecret());
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') return null;
    const user = await getActiveUserById(decoded.sub);
    if (!user || !['admin', 'operator'].includes(user.role)) return null;
    return { type: 'user', userId: user.id, role: user.role };
  } catch {
    return null;
  }
}

export function attachSocketServer(server: HttpServer, allowedOrigin: string): Server {
  socketServer = new Server(server, {
    cors: { origin: allowedOrigin, credentials: true, methods: ['GET', 'POST'] },
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, !origin || origin === allowedOrigin);
    },
  });

  socketServer.use(async (socket, next) => {
    try {
      const principal = await authenticateSocket(socket.handshake.headers.cookie);
      if (!principal) {
        next(new Error('Authentication required.'));
        return;
      }
      socket.data.principal = principal;
      next();
    } catch {
      next(new Error('Authentication required.'));
    }
  });

  socketServer.on('connection', (socket) => {
    const principal = socket.data.principal as SocketPrincipal;
    if (principal.type === 'agent') {
      void socket.join(`agent:${principal.agentId}`);
      return;
    }
    if (principal.role === 'admin' || principal.role === 'operator') {
      void socket.join([fleetRoom, `user:${principal.userId}`]);
      return;
    }
    socket.disconnect(true);
  });

  return socketServer;
}

export function publishFleetLocation(location: FleetLocationUpdate): void {
  socketServer?.to(fleetRoom).emit(fleetLocationEvent, location);
}

export function publishDispatchUpdate(update: DispatchUpdate, previousAgentId?: string | null): void {
  if (!socketServer) return;
  socketServer.to(fleetRoom).emit(dispatchUpdateEvent, update);
  const agentIds = new Set([update.assignedAgentId, previousAgentId].filter((id): id is string => Boolean(id)));
  for (const agentId of agentIds) socketServer.to(`agent:${agentId}`).emit(dispatchUpdateEvent, update);
}

export function publishNotification(notification: NotificationPayload): void {
  if (!socketServer) return;
  const room = notification.recipientType === 'agent'
    ? `agent:${notification.recipientId}`
    : `user:${notification.recipientId}`;
  socketServer.to(room).emit(notificationNewEvent, notification);
}

export function closeSocketServer(): Promise<void> {
  const currentServer = socketServer;
  socketServer = null;
  if (!currentServer) return Promise.resolve();
  return new Promise((resolve) => currentServer.close(() => resolve()));
}

import mongoose, { type ClientSession } from 'mongoose';
import { Agent } from '../models/Agent.js';
import { AgentLocation } from '../models/AgentLocation.js';
import { DispatchRequest, type DispatchRequestStatus } from '../models/DispatchRequest.js';
import { RoutePlan } from '../models/RoutePlan.js';
import { HttpError } from '../utils/httpError.js';
import {
  createBaselineOrder,
  optimizeStopOrder,
  validateStopSequence,
  type RouteStop,
  type StopPreference,
} from './routeOptimizer.js';

const activeStatuses: DispatchRequestStatus[] = ['assigned', 'picked_up', 'in_transit'];
const maximumSelectedDeliveries = 12;
const maximumGpsAgeMs = 2 * 60_000;
const osrmDefaultUrl = 'https://router.project-osrm.org';

type OsrmTable = { code: string; distances?: (number | null)[][]; durations?: (number | null)[][] };
type OsrmRoute = {
  code: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry: { coordinates: [number, number][] };
  }>;
};

function validateIds(agentId: string, dispatchRequestIds: string[]): void {
  if (!mongoose.isValidObjectId(agentId)) throw new HttpError(400, 'Invalid agent ID.');
  if (dispatchRequestIds.length === 0 || dispatchRequestIds.length > maximumSelectedDeliveries) {
    throw new HttpError(400, `Select between 1 and ${maximumSelectedDeliveries} deliveries.`);
  }
  if (dispatchRequestIds.some((id) => !mongoose.isValidObjectId(id))
    || new Set(dispatchRequestIds).size !== dispatchRequestIds.length) {
    throw new HttpError(400, 'Dispatch IDs must be valid and unique.');
  }
}

function validCoordinates(latitude: unknown, longitude: unknown): { latitude: number; longitude: number } | null {
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function createDispatchStops(dispatches: Array<{
  _id: mongoose.Types.ObjectId;
  status: DispatchRequestStatus;
  pickup: { latitude?: number | null; longitude?: number | null };
  delivery: { latitude?: number | null; longitude?: number | null };
}>): RouteStop[] {
  const stops: RouteStop[] = [];
  for (const dispatch of dispatches) {
    const dispatchRequestId = dispatch._id.toString();
    if (dispatch.status === 'assigned') {
      const pickup = validCoordinates(dispatch.pickup.latitude, dispatch.pickup.longitude);
      if (!pickup) {
        throw new HttpError(409, `Dispatch ${dispatchRequestId.slice(-8)} is missing valid pickup coordinates.`);
      }
      stops.push({ dispatchRequestId, stopType: 'pickup', ...pickup });
    }
    const destination = validCoordinates(dispatch.delivery.latitude, dispatch.delivery.longitude);
    if (!destination) {
      throw new HttpError(409, `Dispatch ${dispatchRequestId.slice(-8)} is missing valid destination coordinates.`);
    }
    stops.push({ dispatchRequestId, stopType: 'delivery', ...destination });
  }
  return stops;
}

async function getAssignedDispatches(
  agentId: string,
  dispatchRequestIds: string[],
  session?: ClientSession,
) {
  const query = DispatchRequest.find({
    _id: { $in: dispatchRequestIds },
    assignedAgent: agentId,
    status: { $in: activeStatuses },
  }).sort({ createdAt: 1 });
  if (session) query.session(session);
  const dispatches = await query.lean();
  if (dispatches.length !== dispatchRequestIds.length) {
    throw new HttpError(409, 'One or more selected deliveries are no longer assigned to this agent or are no longer active.');
  }
  return dispatches;
}

export async function listAgentRouteDeliveries(agentId: string) {
  if (!mongoose.isValidObjectId(agentId)) throw new HttpError(400, 'Invalid agent ID.');
  const agent = await Agent.findOne({ _id: agentId, isActive: true }).select('_id').lean();
  if (!agent) throw new HttpError(404, 'Active agent not found.');
  const dispatches = await DispatchRequest.find({ assignedAgent: agentId, status: { $in: activeStatuses } })
    .sort({ createdAt: 1 })
    .select('_id status priority createdAt pickup.latitude pickup.longitude delivery.latitude delivery.longitude')
    .lean();
  return dispatches.map((dispatch) => {
    const pickupAvailable = validCoordinates(dispatch.pickup.latitude, dispatch.pickup.longitude) !== null;
    const deliveryAvailable = validCoordinates(dispatch.delivery.latitude, dispatch.delivery.longitude) !== null;
    const missingCoordinates = dispatch.status === 'assigned'
      ? [!pickupAvailable ? 'pickup' : '', !deliveryAvailable ? 'destination' : ''].filter(Boolean)
      : !deliveryAvailable ? ['destination'] : [];
    return {
      dispatchRequestId: dispatch._id.toString(),
      status: dispatch.status,
      priority: dispatch.priority,
      createdAt: dispatch.createdAt.toISOString(),
      missingCoordinates,
    };
  });
}

export async function getAgentRoutePlan(agentId: string) {
  if (!mongoose.isValidObjectId(agentId)) throw new HttpError(400, 'Invalid agent ID.');
  const routePlan = await RoutePlan.findOne({ agentId }).lean();
  if (!routePlan) return null;
  return {
    id: routePlan._id.toString(),
    agentId: routePlan.agentId.toString(),
    dispatchRequestIds: routePlan.dispatchRequestIds.map((id) => id.toString()),
    stopSequence: routePlan.stopSequence.map((stop) => ({
      dispatchRequestId: stop.dispatchRequestId.toString(),
      stopType: stop.stopType,
    })),
    appliedAt: routePlan.appliedAt.toISOString(),
  };
}

export async function previewAgentRoute(agentId: string, dispatchRequestIds: string[]) {
  validateIds(agentId, dispatchRequestIds);
  const agent = await Agent.findOne({ _id: agentId, isActive: true }).select('_id').lean();
  if (!agent) throw new HttpError(404, 'Active agent not found.');
  const dispatches = await getAssignedDispatches(agentId, dispatchRequestIds);
  const stops = createDispatchStops(dispatches);
  if (stops.length < 2) {
    throw new HttpError(409, 'At least two route stops are needed to compare an optimized route.');
  }

  const savedPlan = await RoutePlan.findOne({ agentId }).select('stopSequence').lean();
  const savedOrder: StopPreference[] = savedPlan?.stopSequence.map((stop) => ({
    dispatchRequestId: stop.dispatchRequestId.toString(),
    stopType: stop.stopType,
  })) ?? [];
  const creationOrder: StopPreference[] = dispatches.flatMap((dispatch) => [
    ...(dispatch.status === 'assigned' ? [{ dispatchRequestId: dispatch._id.toString(), stopType: 'pickup' as const }] : []),
    { dispatchRequestId: dispatch._id.toString(), stopType: 'delivery' as const },
  ]);
  const savedKeys = new Set(savedOrder.map((stop) => `${stop.dispatchRequestId}:${stop.stopType}`));
  const baselinePreference = [
    ...savedOrder,
    ...creationOrder.filter((stop) => !savedKeys.has(`${stop.dispatchRequestId}:${stop.stopType}`)),
  ];
  const baselineOrder = createBaselineOrder(stops, baselinePreference);
  const agentLocation = await AgentLocation.findOne({
    agentId,
    recordedAt: { $gte: new Date(Date.now() - maximumGpsAgeMs) },
    receivedAt: { $gte: new Date(Date.now() - maximumGpsAgeMs) },
    $or: [{ accuracy: { $lte: 200 } }, { accuracy: { $exists: false } }],
  }).sort({ recordedAt: -1, receivedAt: -1 }).lean();
  const gpsCoordinates = agentLocation && validCoordinates(agentLocation.latitude, agentLocation.longitude);
  const origin = gpsCoordinates
    ? { ...gpsCoordinates, source: 'fresh_agent_gps' as const }
    : { latitude: baselineOrder[0].latitude, longitude: baselineOrder[0].longitude, source: 'first_route_stop' as const };

  const allCoordinates = [origin, ...stops].map((point) => `${point.longitude},${point.latitude}`).join(';');
  const table = await readOsrmTable(allCoordinates, stops.length + 1);
  let optimizedOrder: RouteStop[];
  try {
    optimizedOrder = optimizeStopOrder(stops, table.durations, table.distances);
  } catch (error) {
    throw new HttpError(503, error instanceof Error ? error.message : 'Route optimization could not be completed.');
  }

  const [baselineRoute, optimizedRoute] = await Promise.all([
    readOsrmRoute([origin, ...baselineOrder]),
    readOsrmRoute([origin, ...optimizedOrder]),
  ]);

  return {
    agentId,
    routingProvider: 'OSRM',
    origin,
    baselineLabel: savedOrder.length ? 'Current saved route order' : 'Dispatch creation order',
    baseline: formatRoute(baselineOrder, baselineRoute),
    optimized: formatRoute(optimizedOrder, optimizedRoute),
    improvement: {
      distancePercent: percentChange(baselineRoute.distance, optimizedRoute.distance),
      durationPercent: percentChange(baselineRoute.duration, optimizedRoute.duration),
    },
  };
}

export async function applyAgentRoutePlan(
  agentId: string,
  dispatchRequestIds: string[],
  stopSequence: StopPreference[],
  appliedBy: string,
) {
  validateIds(agentId, dispatchRequestIds);
  if (!mongoose.isValidObjectId(appliedBy)) throw new HttpError(401, 'Authentication required.');

  const session = await mongoose.startSession();
  let result: Awaited<ReturnType<typeof getAgentRoutePlan>> | undefined;
  try {
    await session.withTransaction(async () => {
      const agent = await Agent.findOne({ _id: agentId, isActive: true }).select('_id').session(session).lean();
      if (!agent) throw new HttpError(404, 'Active agent not found.');
      const dispatches = await getAssignedDispatches(agentId, dispatchRequestIds, session);
      const stops = createDispatchStops(dispatches);
      if (!validateStopSequence(stops, stopSequence)) {
        throw new HttpError(400, 'The route must include every selected stop once and keep each pickup before its delivery.');
      }

      await RoutePlan.findOneAndUpdate({ agentId }, {
        $set: {
          dispatchRequestIds,
          stopSequence,
          appliedBy,
          appliedAt: new Date(),
        },
      }, { upsert: true, returnDocument: 'after', session });
      result = await getPlanInSession(agentId, session);
    });
  } finally {
    await session.endSession();
  }
  if (!result) throw new Error('Route plan was not saved.');
  return result;
}

async function getPlanInSession(agentId: string, session: ClientSession) {
  const routePlan = await RoutePlan.findOne({ agentId }).session(session).lean();
  if (!routePlan) return null;
  return {
    id: routePlan._id.toString(),
    agentId: routePlan.agentId.toString(),
    dispatchRequestIds: routePlan.dispatchRequestIds.map((id) => id.toString()),
    stopSequence: routePlan.stopSequence.map((stop) => ({
      dispatchRequestId: stop.dispatchRequestId.toString(),
      stopType: stop.stopType,
    })),
    appliedAt: routePlan.appliedAt.toISOString(),
  };
}

async function readOsrmTable(coordinates: string, size: number): Promise<{ distances: (number | null)[][]; durations: (number | null)[][] }> {
  const url = `${routingBaseUrl()}/table/v1/driving/${coordinates}?annotations=distance,duration`;
  const payload = await fetchRoutingJson<OsrmTable>(url);
  if (payload.code !== 'Ok' || !validMatrix(payload.distances, size) || !validMatrix(payload.durations, size)) {
    throw new HttpError(503, 'Routing provider could not calculate a complete route matrix.');
  }
  return { distances: payload.distances, durations: payload.durations };
}

async function readOsrmRoute(points: Array<{ latitude: number; longitude: number }>) {
  const coordinates = points.map((point) => `${point.longitude},${point.latitude}`).join(';');
  const url = `${routingBaseUrl()}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
  const payload = await fetchRoutingJson<OsrmRoute>(url);
  const route = payload.routes?.[0];
  if (payload.code !== 'Ok' || !route || !Number.isFinite(route.distance) || route.distance < 0
    || !Number.isFinite(route.duration) || route.duration < 0
    || !Array.isArray(route.geometry?.coordinates) || route.geometry.coordinates.length < 2
    || route.geometry.coordinates.some((point) => !Array.isArray(point) || point.length !== 2
      || !point.every(Number.isFinite) || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90)) {
    throw new HttpError(503, 'Routing provider did not return a valid road route.');
  }
  return {
    distance: route.distance,
    duration: route.duration,
    geometry: route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]),
  };
}

async function fetchRoutingJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Routing provider returned HTTP ${response.status}.`);
    return await response.json() as T;
  } catch {
    throw new HttpError(503, 'Road routing is temporarily unavailable. Please retry later.');
  } finally {
    clearTimeout(timeout);
  }
}

function routingBaseUrl(): string {
  const value = process.env.ROUTING_SERVICE_BASE_URL?.trim() || osrmDefaultUrl;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol.');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new HttpError(503, 'Routing service configuration is invalid.');
  }
}

function validMatrix(value: unknown, size: number): value is (number | null)[][] {
  return Array.isArray(value) && value.length === size
    && value.every((row) => Array.isArray(row) && row.length === size
      && row.every((cell) => cell === null || (typeof cell === 'number' && Number.isFinite(cell) && cell >= 0)));
}

function formatRoute(stops: RouteStop[], route: Awaited<ReturnType<typeof readOsrmRoute>>) {
  return {
    stops: stops.map((stop) => ({
      dispatchRequestId: stop.dispatchRequestId,
      stopType: stop.stopType,
      latitude: stop.latitude,
      longitude: stop.longitude,
    })),
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    geometry: route.geometry,
  };
}

function percentChange(original: number, optimized: number): number | null {
  if (original <= 0) return null;
  return Math.round(((original - optimized) / original) * 1000) / 10;
}

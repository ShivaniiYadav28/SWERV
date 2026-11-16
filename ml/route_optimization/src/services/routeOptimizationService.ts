import type {
  Coordinates,
  FormattedRoute,
  RouteOptimizationRequest,
  RouteStop,
  StopPreference,
} from '../types/routeOptimization.js';
import { HttpError } from '../utils/httpError.js';
import { createBaselineOrder, optimizeStopOrder } from './routeOptimizer.js';

const maximumSelectedDeliveries = 12;
const osrmDefaultUrl = 'https://router.project-osrm.org';
const routingTimeoutMs = 8_000;

type RouteOrigin = Coordinates & { source: 'provided_agent_location' };

export async function optimizeAgentRoute(input: RouteOptimizationRequest) {
  if (input.deliveries.length > maximumSelectedDeliveries) {
    throw new HttpError(400, `Select between 1 and ${maximumSelectedDeliveries} deliveries.`);
  }

  const stops: RouteStop[] = [];
  for (const delivery of input.deliveries) {
    if (delivery.status === 'assigned') {
      if (!delivery.pickup) throw new HttpError(400, 'Pickup coordinates are required for assigned deliveries.');
      stops.push({
        dispatchRequestId: delivery.dispatchRequestId,
        stopType: 'pickup',
        ...delivery.pickup,
      });
    }
    stops.push({
      dispatchRequestId: delivery.dispatchRequestId,
      stopType: 'delivery',
      ...delivery.delivery,
    });
  }
  if (stops.length < 2) {
    throw new HttpError(409, 'At least two route stops are needed to compare an optimized route.');
  }

  const creationOrder: StopPreference[] = input.deliveries.flatMap((delivery) => [
    ...(delivery.status === 'assigned'
      ? [{ dispatchRequestId: delivery.dispatchRequestId, stopType: 'pickup' as const }]
      : []),
    { dispatchRequestId: delivery.dispatchRequestId, stopType: 'delivery' as const },
  ]);
  const baselineOrder = createBaselineOrder(stops, creationOrder);
  const origin: RouteOrigin = {
    latitude: input.agent.latitude,
    longitude: input.agent.longitude,
    source: 'provided_agent_location',
  };

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
    agentId: input.agent.agentId,
    routingProvider: 'OSRM' as const,
    origin,
    baselineLabel: 'Provided delivery order',
    baseline: formatRoute(baselineOrder, baselineRoute),
    optimized: formatRoute(optimizedOrder, optimizedRoute),
    improvement: {
      distancePercent: percentChange(baselineRoute.distance, optimizedRoute.distance),
      durationPercent: percentChange(baselineRoute.duration, optimizedRoute.duration),
    },
  };
}

async function readOsrmTable(
  coordinates: string,
  size: number,
): Promise<{ distances: (number | null)[][]; durations: (number | null)[][] }> {
  const url = `${routingBaseUrl()}/table/v1/driving/${coordinates}?annotations=distance,duration`;
  const payload = await fetchRoutingJson(url);
  if (!isRecord(payload) || payload.code !== 'Ok'
    || !validMatrix(payload.distances, size) || !validMatrix(payload.durations, size)) {
    throw new HttpError(503, 'Routing provider could not calculate a complete route matrix.');
  }
  return { distances: payload.distances, durations: payload.durations };
}

async function readOsrmRoute(points: Array<Coordinates>) {
  const coordinates = points.map((point) => `${point.longitude},${point.latitude}`).join(';');
  const url = `${routingBaseUrl()}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
  const payload = await fetchRoutingJson(url);
  if (!isRecord(payload) || payload.code !== 'Ok' || !Array.isArray(payload.routes)) {
    throw new HttpError(503, 'Routing provider did not return a valid road route.');
  }

  const route = payload.routes[0];
  if (!isRecord(route) || !isRecord(route.geometry)
    || !isCoordinateArray(route.geometry.coordinates)
    || route.geometry.coordinates.length < 2
    || !isNonnegativeNumber(route.distance)
    || !isNonnegativeNumber(route.duration)
    || route.geometry.coordinates.some(([longitude, latitude]) =>
      longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)) {
    throw new HttpError(503, 'Routing provider did not return a valid road route.');
  }

  return {
    distance: route.distance,
    duration: route.duration,
    geometry: route.geometry.coordinates.map(toLatitudeLongitude),
  };
}

async function fetchRoutingJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), routingTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Routing provider returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    return payload;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCoordinateArray(value: unknown): value is Array<[number, number]> {
  return Array.isArray(value) && value.every((coordinate) =>
    Array.isArray(coordinate) && coordinate.length === 2
      && typeof coordinate[0] === 'number' && Number.isFinite(coordinate[0])
      && typeof coordinate[1] === 'number' && Number.isFinite(coordinate[1]));
}

function toLatitudeLongitude([longitude, latitude]: [number, number]): [number, number] {
  return [latitude, longitude];
}

function formatRoute(stops: RouteStop[], route: {
  distance: number;
  duration: number;
  geometry: Array<[number, number]>;
}): FormattedRoute {
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

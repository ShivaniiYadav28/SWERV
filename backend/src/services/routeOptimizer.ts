export type RouteStopType = 'pickup' | 'delivery';

export type RouteStop = {
  dispatchRequestId: string;
  stopType: RouteStopType;
  latitude: number;
  longitude: number;
};

export type StopPreference = {
  dispatchRequestId: string;
  stopType: RouteStopType;
};

export function createBaselineOrder(stops: RouteStop[], preferredOrder: StopPreference[] = []): RouteStop[] {
  const positionByKey = new Map(preferredOrder.map((stop, index) => [stopKey(stop), index]));
  const remaining = new Set(stops.map((_stop, index) => index));
  const orderedStops: RouteStop[] = [];

  while (remaining.size) {
    const available = [...remaining].filter((index) => {
      const stop = stops[index];
      if (stop.stopType !== 'delivery') return true;
      const pickupIndex = stops.findIndex((candidate) =>
        candidate.dispatchRequestId === stop.dispatchRequestId && candidate.stopType === 'pickup');
      return pickupIndex === -1 || !remaining.has(pickupIndex);
    });
    available.sort((left, right) => {
      const leftPosition = positionByKey.get(stopKey(stops[left]));
      const rightPosition = positionByKey.get(stopKey(stops[right]));
      if (leftPosition !== undefined || rightPosition !== undefined) {
        if (leftPosition === undefined) return 1;
        if (rightPosition === undefined) return -1;
        if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      }
      const idOrder = stops[left].dispatchRequestId.localeCompare(stops[right].dispatchRequestId);
      return idOrder || (stops[left].stopType === 'pickup' ? -1 : 1);
    });
    if (!available.length) throw new Error('Selected stops do not have a valid pickup order.');
    const nextIndex = available[0];
    orderedStops.push(stops[nextIndex]);
    remaining.delete(nextIndex);
  }
  return orderedStops;
}

export function optimizeStopOrder(
  stops: RouteStop[],
  durations: (number | null)[][],
  distances: (number | null)[][],
): RouteStop[] {
  if (stops.length === 0) return [];
  if (durations.length !== stops.length + 1 || distances.length !== stops.length + 1) {
    throw new Error('Routing matrix does not match the selected stops.');
  }

  const remaining = new Set(stops.map((_stop, index) => index));
  const orderedStops: RouteStop[] = [];
  let currentMatrixIndex = 0;

  while (remaining.size > 0) {
    // A delivery stop is available only after its matching pickup is complete.
    const available = [...remaining].filter((index) => {
      const stop = stops[index];
      if (stop.stopType !== 'delivery') return true;
      const pickupIndex = stops.findIndex((candidate) =>
        candidate.dispatchRequestId === stop.dispatchRequestId && candidate.stopType === 'pickup');
      return pickupIndex === -1 || !remaining.has(pickupIndex);
    });
    if (!available.length) throw new Error('Selected stops do not have a valid pickup order.');

    // Choose the reachable stop with the shortest road-time estimate; distance breaks ties.
    available.sort((left, right) => {
      const leftDuration = durations[currentMatrixIndex]?.[left + 1] ?? Number.POSITIVE_INFINITY;
      const rightDuration = durations[currentMatrixIndex]?.[right + 1] ?? Number.POSITIVE_INFINITY;
      if (leftDuration !== rightDuration) return leftDuration - rightDuration;
      const leftDistance = distances[currentMatrixIndex]?.[left + 1] ?? Number.POSITIVE_INFINITY;
      const rightDistance = distances[currentMatrixIndex]?.[right + 1] ?? Number.POSITIVE_INFINITY;
      return leftDistance - rightDistance;
    });

    const nextIndex = available[0];
    if (!Number.isFinite(durations[currentMatrixIndex]?.[nextIndex + 1])
      || !Number.isFinite(distances[currentMatrixIndex]?.[nextIndex + 1])) {
      throw new Error('The routing provider could not connect all selected stops.');
    }
    orderedStops.push(stops[nextIndex]);
    remaining.delete(nextIndex);
    currentMatrixIndex = nextIndex + 1;
  }
  return orderedStops;
}

export function validateStopSequence(stops: RouteStop[], sequence: StopPreference[]): boolean {
  if (stops.length !== sequence.length) return false;
  const expectedKeys = new Set(stops.map(stopKey));
  const receivedKeys = sequence.map(stopKey);
  if (new Set(receivedKeys).size !== receivedKeys.length) return false;
  if (receivedKeys.some((key) => !expectedKeys.has(key))) return false;

  const positionByKey = new Map(receivedKeys.map((key, index) => [key, index]));
  for (const stop of stops) {
    if (stop.stopType !== 'pickup') continue;
    const pickupPosition = positionByKey.get(stopKey(stop));
    const deliveryPosition = positionByKey.get(stopKey({ ...stop, stopType: 'delivery' }));
    if (deliveryPosition !== undefined && (pickupPosition === undefined || pickupPosition > deliveryPosition)) return false;
  }
  return true;
}

function stopKey(stop: StopPreference): string {
  return `${stop.dispatchRequestId}:${stop.stopType}`;
}

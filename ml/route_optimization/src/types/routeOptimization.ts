export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type RouteStopType = 'pickup' | 'delivery';

export type RouteStop = Coordinates & {
  dispatchRequestId: string;
  stopType: RouteStopType;
};

export type StopPreference = {
  dispatchRequestId: string;
  stopType: RouteStopType;
};

export type DeliveryInput = {
  dispatchRequestId: string;
  status: 'assigned' | 'picked_up' | 'in_transit';
  pickup?: Coordinates;
  delivery: Coordinates;
};

export type RouteOptimizationRequest = {
  agent: Coordinates & {
    agentId: string;
  };
  deliveries: DeliveryInput[];
};

export type FormattedRoute = {
  stops: RouteStop[];
  distanceMeters: number;
  durationSeconds: number;
  geometry: Array<[number, number]>;
};

import { Agent, type AgentCapability } from '../models/Agent.js';
import { AgentLocation } from '../models/AgentLocation.js';
import { DispatchRequest } from '../models/DispatchRequest.js';
import { DispatchRequestActivity } from '../models/DispatchRequestActivity.js';
import { getRequiredAgentCapabilities } from './dispatchRequestService.js';
import { HttpError } from '../utils/httpError.js';
import { getSmartAgentMlServiceBaseUrl } from '../config/mlService.js';

const freshLocationAgeMs = 15 * 60 * 1_000;
const minimumHistoricalDeliveries = 10;
const maximumHistoricalRequests = 500;
const earthRadiusKm = 6371.0088;
const predictionTimeoutMs = 5_000;

type CoordinatePair = { latitude: number; longitude: number };
type RecommendationHistory = {
  completedDeliveries: number;
  medianDurationMinutes: number | null;
};

function validCoordinatePair(location: {
  latitude?: number | null;
  longitude?: number | null;
} | undefined): CoordinatePair | null {
  const { latitude, longitude } = location ?? {};
  if (
    typeof latitude !== 'number'
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || typeof longitude !== 'number'
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

function distanceInKilometers(first: CoordinatePair, second: CoordinatePair): number {
  const latitude1 = first.latitude * Math.PI / 180;
  const latitude2 = second.latitude * Math.PI / 180;
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = (second.longitude - first.longitude) * Math.PI / 180;
  const haversine = Math.min(1, Math.max(0, Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2));
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function median(values: number[]): number {
  const sortedValues = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 0) {
    return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
  }
  return sortedValues[middle];
}

function readActivityValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

async function getFreshAgentLocations(agentIds: unknown[], now: Date) {
  if (agentIds.length === 0) return new Map<string, CoordinatePair>();

  const cutoff = new Date(now.getTime() - freshLocationAgeMs);
  const locations = await AgentLocation.aggregate<{
    _id: unknown;
    latitude: number;
    longitude: number;
  }>([
    {
      $match: {
        agentId: { $in: agentIds },
        recordedAt: { $gte: cutoff, $lte: now },
        receivedAt: { $gte: cutoff, $lte: now },
      },
    },
    { $sort: { agentId: 1, recordedAt: -1, receivedAt: -1 } },
    {
      $group: {
        _id: '$agentId',
        latitude: { $first: '$latitude' },
        longitude: { $first: '$longitude' },
      },
    },
  ]);

  const freshLocations = new Map<string, CoordinatePair>();
  for (const location of locations) {
    const coordinates = validCoordinatePair(location);
    if (coordinates) freshLocations.set(String(location._id), coordinates);
  }
  return freshLocations;
}

async function getHistoricalPerformance(agentIds: unknown[]): Promise<Map<string, RecommendationHistory>> {
  const performance = new Map<string, RecommendationHistory>();
  if (agentIds.length === 0) return performance;

  const deliveredRequests = await DispatchRequest.collection.find({
    status: 'delivered',
    assignedAgent: { $in: agentIds },
  }, { projection: { _id: 1, assignedAgent: 1, updatedAt: 1 } })
    .sort({ updatedAt: -1 })
    .limit(maximumHistoricalRequests)
    .toArray();

  if (deliveredRequests.length === 0) return performance;
  const requestIds = deliveredRequests.map((request) => request._id);
  const activities = await DispatchRequestActivity.collection.find({
    dispatchRequestId: { $in: requestIds },
    eventType: { $in: ['assignment_changed', 'status_changed'] },
  }, { projection: { dispatchRequestId: 1, eventType: 1, createdAt: 1, newValue: 1 } }).toArray();

  const activitiesByRequest = new Map<string, typeof activities>();
  for (const activity of activities) {
    const key = String(activity.dispatchRequestId);
    const existing = activitiesByRequest.get(key) ?? [];
    existing.push(activity);
    activitiesByRequest.set(key, existing);
  }

  const durationsByAgent = new Map<string, number[]>();
  for (const request of deliveredRequests) {
    const requestActivities = activitiesByRequest.get(String(request._id)) ?? [];
    const deliveryEvents = requestActivities.filter(
      (activity) => activity.eventType === 'status_changed'
        && readActivityValue(activity.newValue, 'status') === 'delivered'
        && activity.createdAt instanceof Date
        && Number.isFinite(activity.createdAt.getTime()),
    );
    if (deliveryEvents.length === 0) continue;

    const deliveredAt = deliveryEvents.reduce(
      (latest, activity) => activity.createdAt > latest ? activity.createdAt : latest,
      deliveryEvents[0].createdAt,
    );
    const assignmentEvents = requestActivities.filter(
      (activity) => activity.eventType === 'assignment_changed'
        && activity.createdAt instanceof Date
        && activity.createdAt < deliveredAt,
    );
    if (assignmentEvents.length === 0) continue;

    const assignedAt = assignmentEvents.reduce(
      (latest, activity) => activity.createdAt > latest ? activity.createdAt : latest,
      assignmentEvents[0].createdAt,
    );
    const finalAssignment = assignmentEvents.find((activity) => activity.createdAt.getTime() === assignedAt.getTime());
    if (String(readActivityValue(finalAssignment?.newValue, 'agentId') ?? '') !== String(request.assignedAgent)) continue;
    const durationMinutes = (deliveredAt.getTime() - assignedAt.getTime()) / 60_000;
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) continue;

    const agentKey = String(request.assignedAgent);
    const durations = durationsByAgent.get(agentKey) ?? [];
    durations.push(durationMinutes);
    durationsByAgent.set(agentKey, durations);
  }

  for (const [agentId, durations] of durationsByAgent) {
    performance.set(agentId, {
      completedDeliveries: durations.length,
      medianDurationMinutes: durations.length >= minimumHistoricalDeliveries
        ? median(durations)
        : null,
    });
  }
  return performance;
}

type PythonCandidatePrediction = {
  agent_id: string;
  agent_code: string;
  rank: number;
  predicted_duration_minutes: number;
};

type PythonRecommendationResponse = {
  dispatch_request_id: string;
  prediction_status: 'available';
  model_version: string;
  training_source: 'synthetic';
  predictions: PythonCandidatePrediction[];
};

function parsePredictionResponse(value: unknown): PythonRecommendationResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (
    typeof response.dispatch_request_id !== 'string'
    || response.prediction_status !== 'available'
    || typeof response.model_version !== 'string'
    || !response.model_version.includes('synthetic')
    || response.training_source !== 'synthetic'
    || !Array.isArray(response.predictions)
  ) return null;

  const predictions = response.predictions as unknown[];
  if (predictions.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const prediction = item as Record<string, unknown>;
    return typeof prediction.agent_id !== 'string'
      || typeof prediction.agent_code !== 'string'
      || !Number.isInteger(prediction.rank)
      || typeof prediction.predicted_duration_minutes !== 'number'
      || !Number.isFinite(prediction.predicted_duration_minutes)
      || prediction.predicted_duration_minutes <= 0;
  })) return null;
  return response as PythonRecommendationResponse;
}

async function requestCandidatePredictions(
  dispatchRequestId: string,
  dispatchRequest: {
    priority: string;
    package: { category: string; weightKg: number; quantity: number };
    pickup: { latitude?: number | null; longitude?: number | null };
    delivery: { latitude?: number | null; longitude?: number | null };
  },
  agents: Array<{
    _id: unknown;
    agentCode: string;
    vehicle: { vehicleType: string };
    capabilities: string[];
    activeDispatchCount?: number;
    capacity?: { maxOrders?: number } | null;
  }>,
  locations: Map<string, CoordinatePair>,
  histories: Map<string, RecommendationHistory>,
  now: Date,
): Promise<PythonRecommendationResponse> {
  const pickup = validCoordinatePair(dispatchRequest.pickup);
  const destination = validCoordinatePair(dispatchRequest.delivery);
  const requestBody = {
    dispatch_request_id: dispatchRequestId,
    dispatch: {
      recommendation_time: now.toISOString(),
      priority: dispatchRequest.priority,
      package_category: dispatchRequest.package.category,
      weight_kg: dispatchRequest.package.weightKg,
      quantity: dispatchRequest.package.quantity,
      pickup_latitude: pickup?.latitude ?? null,
      pickup_longitude: pickup?.longitude ?? null,
      destination_latitude: destination?.latitude ?? null,
      destination_longitude: destination?.longitude ?? null,
    },
    candidates: agents.map((agent) => {
      const id = String(agent._id);
      const history = histories.get(id) ?? { completedDeliveries: 0, medianDurationMinutes: null };
      const location = locations.get(id);
      return {
        agent_id: id,
        agent_code: agent.agentCode,
        is_active: true,
        agent_status: 'available',
        vehicle_type: agent.vehicle.vehicleType,
        capabilities: agent.capabilities,
        active_workload: Math.max(0, Number(agent.activeDispatchCount ?? 0)),
        max_capacity: Number(agent.capacity?.maxOrders ?? 1),
        gps_fresh: Boolean(location),
        agent_to_pickup_km: pickup && location ? distanceInKilometers(pickup, location) : null,
        completed_delivery_count: history.completedDeliveries,
        historical_median_minutes: history.medianDurationMinutes,
      };
    }),
  };

  let response: Response;
  try {
    const baseUrl = getSmartAgentMlServiceBaseUrl();
    response = await fetch(`${baseUrl}/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(predictionTimeoutMs),
    });
  } catch {
    throw new HttpError(503, 'Smart Agent Assignment ML service is unavailable. Retry after it is running.');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HttpError(502, 'Smart Agent Assignment ML service returned an invalid response.');
  }
  const result = parsePredictionResponse(body);
  if (!response.ok) {
    if (response.status === 503) {
      throw new HttpError(503, 'Smart Agent Assignment model is unavailable; no ML ranking was produced.');
    }
    throw new HttpError(502, 'Smart Agent Assignment ML service could not process the candidates.');
  }
  if (
    !result
    || result.dispatch_request_id !== dispatchRequestId
    || result.predictions.length !== agents.length
  ) {
    throw new HttpError(502, 'Smart Agent Assignment ML service returned an invalid response.');
  }
  const expectedAgents = new Map(agents.map((agent) => [String(agent._id), agent.agentCode]));
  const seenAgents = new Set<string>();
  const seenRanks = new Set<number>();
  let previousDuration = 0;
  for (const prediction of result.predictions) {
    if (
      expectedAgents.get(prediction.agent_id) !== prediction.agent_code
      || seenAgents.has(prediction.agent_id)
      || seenRanks.has(prediction.rank)
      || prediction.rank < 1
      || prediction.rank > agents.length
      || (seenRanks.size > 0 && prediction.predicted_duration_minutes < previousDuration)
    ) {
      throw new HttpError(502, 'Smart Agent Assignment ML service returned invalid candidate rankings.');
    }
    seenAgents.add(prediction.agent_id);
    seenRanks.add(prediction.rank);
    previousDuration = prediction.predicted_duration_minutes;
  }
  if (seenRanks.size !== agents.length || [...seenRanks].some((rank) => rank < 1 || rank > agents.length)) {
    throw new HttpError(502, 'Smart Agent Assignment ML service returned invalid candidate rankings.');
  }
  return result;
}

export async function getAgentRecommendations(dispatchRequestId: string) {
  const dispatchRequest = await DispatchRequest.findById(dispatchRequestId)
    .select('status assignedAgent pickup.latitude pickup.longitude package.category package.weightKg package.quantity priority')
    .lean();
  if (!dispatchRequest) throw new HttpError(404, 'Dispatch request not found.');
  if (dispatchRequest.status !== 'pending' && dispatchRequest.status !== 'assigned') {
    throw new HttpError(409, 'Recommendations are available only for pending or assigned requests.');
  }

  const requiredCapabilities = getRequiredAgentCapabilities(
    dispatchRequest.package.category,
    dispatchRequest.priority,
  );
  const requestPickup = validCoordinatePair({
    latitude: dispatchRequest.pickup.latitude ?? undefined,
    longitude: dispatchRequest.pickup.longitude ?? undefined,
  });
  const agentFilter: Record<string, unknown> = {
    isActive: true,
    status: 'available',
    $expr: {
      $lt: [
        { $ifNull: ['$activeDispatchCount', 0] },
        '$capacity.maxOrders',
      ],
    },
  };
  if (dispatchRequest.assignedAgent) {
    agentFilter._id = { $ne: dispatchRequest.assignedAgent };
  }

  const capacityEligibleAgents = await Agent.find(agentFilter)
    .select('name agentCode vehicle.vehicleType capabilities activeDispatchCount capacity.maxOrders')
    .lean();
  const eligibleAgents = capacityEligibleAgents.filter((agent) =>
    requiredCapabilities.every((capability: AgentCapability) => agent.capabilities.includes(capability)),
  );

  if (eligibleAgents.length === 0) {
    return {
      recommendations: [],
      message: dispatchRequest.assignedAgent
        ? 'No other eligible agents are available for this dispatch request.'
        : 'No eligible agents are currently available. Check agent status, capacity, and package capabilities.',
      rankingData: {
        pickupCoordinatesAvailable: Boolean(requestPickup),
        agentsWithFreshGps: 0,
        historicalPerformanceAvailable: false,
        minimumHistoricalDeliveries: minimumHistoricalDeliveries,
      },
      predictionStatus: 'no_eligible_candidates' as const,
      modelVersion: null,
      trainingSource: null,
      notes: ['Vehicle type is not currently a restriction in SWERV assignment rules.'],
    };
  }

  const now = new Date();
  const eligibleAgentIds = eligibleAgents.map((agent) => agent._id);
  const [freshLocations, histories] = await Promise.all([
    getFreshAgentLocations(eligibleAgentIds, now),
    getHistoricalPerformance(eligibleAgentIds),
  ]);
  const prediction = await requestCandidatePredictions(
    dispatchRequestId,
    dispatchRequest,
    eligibleAgents,
    freshLocations,
    histories,
    now,
  );
  const agentsById = new Map(eligibleAgents.map((agent) => [String(agent._id), agent]));
  const recommendations = prediction.predictions.map((candidatePrediction) => {
    const agent = agentsById.get(candidatePrediction.agent_id);
    if (!agent) throw new HttpError(502, 'Smart Agent Assignment ML service ranked an unknown agent.');
    const agentId = String(agent._id);
    const activeDispatchCount = Math.max(0, Number(agent.activeDispatchCount ?? 0));
    const maxOrders = Number(agent.capacity?.maxOrders ?? 1);
    const agentLocation = freshLocations.get(agentId);
    const distanceKm = requestPickup && agentLocation
      ? distanceInKilometers(requestPickup, agentLocation)
      : null;
    const history = histories.get(agentId) ?? {
      completedDeliveries: 0,
      medianDurationMinutes: null,
    };
    const explanation = [
      `Package and priority capabilities match (${requiredCapabilities.join(', ')}).`,
      `Workload is ${activeDispatchCount} of ${maxOrders} active deliveries.`,
      `The synthetic ML model predicts ${candidatePrediction.predicted_duration_minutes.toFixed(1)} minutes for this eligible candidate.`,
    ];

    if (distanceKm === null) {
      explanation.push(requestPickup
        ? 'Distance was not scored because fresh agent GPS is unavailable.'
        : 'Distance was not scored because pickup coordinates are unavailable.');
    } else {
      explanation.push(`Fresh GPS places this agent ${distanceKm.toFixed(1)} km from pickup.`);
    }

    if (history.medianDurationMinutes === null) {
      explanation.push(
        `No performance score: fewer than ${minimumHistoricalDeliveries} valid completed deliveries.`,
      );
    } else {
      explanation.push(
        `Median assignment-to-delivery time is ${history.medianDurationMinutes.toFixed(1)} minutes across ${history.completedDeliveries} deliveries.`,
      );
    }

    return {
      rank: candidatePrediction.rank,
      agent: {
        id: agentId,
        name: agent.name,
        agentCode: agent.agentCode,
        vehicleType: agent.vehicle.vehicleType,
      },
      predictedDurationMinutes: Math.round(candidatePrediction.predicted_duration_minutes * 10) / 10,
      workload: { activeDispatchCount, maxOrders },
      distanceKm: distanceKm === null ? null : Math.round(distanceKm * 10) / 10,
      historicalCompletedDeliveries: history.completedDeliveries,
      historicalMedianDurationMinutes: history.medianDurationMinutes === null
        ? null
        : Math.round(history.medianDurationMinutes * 10) / 10,
      explanation,
    };
  });

  return {
    recommendations,
    message: 'Eligible agents ranked by predicted delivery duration using a synthetic-data ML prototype.',
    rankingData: {
      pickupCoordinatesAvailable: Boolean(requestPickup),
      agentsWithFreshGps: freshLocations.size,
      historicalPerformanceAvailable: [...histories.values()].some(
        (history) => history.medianDurationMinutes !== null,
      ),
      minimumHistoricalDeliveries,
    },
    predictionStatus: 'available' as const,
    modelVersion: prediction.model_version,
    trainingSource: prediction.training_source,
    notes: [
      'Predictions come from synthetic training data and are not validated against real-world delivery outcomes.',
      'Vehicle type is not currently a restriction in SWERV assignment rules.',
    ],
  };
}

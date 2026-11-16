type RecordValue = Record<string, unknown>;

export type OperationalAnomalyFinding = {
  anomaly_type: string;
  severity: 'medium' | 'high';
  dispatch_id: string | null;
  agent_id: string | null;
  evidence_timestamp: string | null;
  explanation: string;
  measured_value: number | string | null;
  threshold: number | string | string[] | null;
  detection_method: string;
  data_quality_notes: string[];
};

export type OperationalAnomalyReport = {
  findings: OperationalAnomalyFinding[];
  limitations: string[];
};

const staleSubmissionMinutes = 10;
const maximumMovementGapMinutes = 15;
const maximumGpsAccuracyMeters = 100;
const maximumPlausibleSpeedKmh = 160;
const repeatedReassignmentThreshold = 2;
const minimumDurationSamples = 30;
const durationIqrMultiplier = 3;
const earthRadiusKm = 6371.0088;

const allowedStatusTransitions: Record<string, readonly string[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['picked_up', 'cancelled'],
  picked_up: ['in_transit', 'failed'],
  in_transit: ['delivered', 'failed'],
  delivered: [],
  cancelled: [],
  failed: [],
};

function recordValue(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function identifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function nestedValue(record: RecordValue, parent: string, key: string): unknown {
  return recordValue(record[parent])[key];
}

function parseTimestamp(value: unknown): Date | null {
  const timestamp = value instanceof Date ? new Date(value.getTime())
    : typeof value === 'string' || typeof value === 'number' ? new Date(value)
      : null;
  return timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

function timestampText(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validCoordinatePair(latitude: unknown, longitude: unknown): boolean {
  return isFiniteNumber(latitude) && isFiniteNumber(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180;
}

function distanceKm(first: RecordValue, second: RecordValue): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeOne = radians(first.latitude as number);
  const latitudeTwo = radians(second.latitude as number);
  const latitudeDelta = latitudeTwo - latitudeOne;
  const longitudeDelta = radians((second.longitude as number) - (first.longitude as number));
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeOne) * Math.cos(latitudeTwo) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function makeFinding(
  values: Partial<OperationalAnomalyFinding> & Pick<OperationalAnomalyFinding, 'anomaly_type' | 'severity' | 'explanation' | 'detection_method'>,
): OperationalAnomalyFinding {
  return {
    dispatch_id: null,
    agent_id: null,
    evidence_timestamp: null,
    measured_value: null,
    threshold: null,
    data_quality_notes: [],
    ...values,
  };
}

function detectGpsAnomalies(locations: RecordValue[]): { findings: OperationalAnomalyFinding[]; limitations: string[] } {
  const findings: OperationalAnomalyFinding[] = [];
  const limitations: string[] = [];
  const pointsByAgent = new Map<string, Array<{ record: RecordValue; recordedAt: Date; accuracy: number }>>();

  for (const location of locations) {
    const agentId = identifier(location.agentId);
    const recordedAt = parseTimestamp(location.recordedAt);
    const receivedAt = parseTimestamp(location.receivedAt);
    const evidenceTime = receivedAt ?? recordedAt;
    const coordinateValid = validCoordinatePair(location.latitude, location.longitude);

    if (!coordinateValid) {
      const missing = location.latitude === null || location.latitude === undefined
        || location.longitude === null || location.longitude === undefined;
      findings.push(makeFinding({
        anomaly_type: missing ? 'gps_missing_coordinates' : 'gps_invalid_coordinates',
        severity: 'medium',
        agent_id: agentId,
        evidence_timestamp: timestampText(evidenceTime),
        explanation: 'GPS location is missing a coordinate or falls outside valid latitude/longitude ranges.',
        threshold: 'latitude [-90, 90], longitude [-180, 180]',
        detection_method: 'coordinate_validation',
        data_quality_notes: ['This location was excluded from movement analysis.'],
      }));
    }

    if (!recordedAt || !receivedAt) {
      findings.push(makeFinding({
        anomaly_type: 'gps_invalid_timestamp',
        severity: 'medium',
        agent_id: agentId,
        evidence_timestamp: timestampText(evidenceTime),
        explanation: 'GPS recordedAt or receivedAt is missing or cannot be parsed as a timestamp.',
        measured_value: 'invalid_or_missing_timestamp',
        threshold: 'both timestamps must be valid',
        detection_method: 'timestamp_validation',
        data_quality_notes: ['This location was excluded from movement analysis.'],
      }));
      continue;
    }

    const submissionDelayMinutes = (receivedAt.getTime() - recordedAt.getTime()) / 60_000;
    if (submissionDelayMinutes < 0) {
      findings.push(makeFinding({
        anomaly_type: 'gps_invalid_timestamp_order',
        severity: 'medium',
        agent_id: agentId,
        evidence_timestamp: timestampText(receivedAt),
        explanation: 'The server received the GPS record before its recordedAt time.',
        measured_value: Math.round(submissionDelayMinutes * 100) / 100,
        threshold: 'receivedAt must be at or after recordedAt',
        detection_method: 'timestamp_order_validation',
        data_quality_notes: ['This location was excluded from movement analysis.'],
      }));
      continue;
    }
    if (submissionDelayMinutes > staleSubmissionMinutes) {
      findings.push(makeFinding({
        anomaly_type: 'gps_stale_submission',
        severity: 'medium',
        agent_id: agentId,
        evidence_timestamp: timestampText(receivedAt),
        explanation: `The GPS point arrived ${submissionDelayMinutes.toFixed(1)} minutes after it was recorded; the configured stale limit is ${staleSubmissionMinutes.toFixed(1)} minutes.`,
        measured_value: Math.round(submissionDelayMinutes * 100) / 100,
        threshold: staleSubmissionMinutes,
        detection_method: 'recordedAt_receivedAt_delay',
        data_quality_notes: ['Stale points are excluded from movement analysis.'],
      }));
      continue;
    }
    if (!coordinateValid) continue;

    const accuracy = location.accuracy;
    if (!isFiniteNumber(accuracy) || accuracy < 0 || accuracy > maximumGpsAccuracyMeters) {
      limitations.push('Some fresh GPS points were skipped because accuracy was missing or above the configured limit.');
      continue;
    }
    if (!agentId) {
      limitations.push('Some GPS records have no agent identifier and were excluded from movement pairing.');
      continue;
    }
    const agentPoints = pointsByAgent.get(agentId) ?? [];
    agentPoints.push({ record: location, recordedAt, accuracy });
    pointsByAgent.set(agentId, agentPoints);
  }

  for (const [agentId, points] of pointsByAgent) {
    points.sort((first, second) => first.recordedAt.getTime() - second.recordedAt.getTime());
    for (let index = 1; index < points.length; index += 1) {
      const first = points[index - 1];
      const second = points[index];
      const intervalMinutes = (second.recordedAt.getTime() - first.recordedAt.getTime()) / 60_000;
      if (intervalMinutes <= 0) {
        limitations.push(`GPS movement for agent ${agentId} was skipped for duplicate or unordered timestamps.`);
        continue;
      }
      if (intervalMinutes > maximumMovementGapMinutes) {
        limitations.push('GPS movement pairs with gaps above the configured maximum were skipped.');
        continue;
      }
      const measuredDistance = distanceKm(first.record, second.record);
      const accuracyAllowanceMeters = first.accuracy + second.accuracy;
      const conservativeDistance = Math.max(0, measuredDistance - accuracyAllowanceMeters / 1000);
      const speedKmh = conservativeDistance / (intervalMinutes / 60);
      if (speedKmh > maximumPlausibleSpeedKmh) {
        findings.push(makeFinding({
          anomaly_type: 'gps_implausible_jump',
          severity: 'high',
          agent_id: agentId,
          evidence_timestamp: timestampText(second.recordedAt),
          explanation: `Two fresh GPS points ${intervalMinutes.toFixed(1)} minutes apart are ${measuredDistance.toFixed(2)} km apart. After subtracting the combined ${accuracyAllowanceMeters.toFixed(0)} m accuracy allowance, implied speed is ${speedKmh.toFixed(1)} km/h, above the configured plausible limit.`,
          measured_value: Math.round(speedKmh * 100) / 100,
          threshold: maximumPlausibleSpeedKmh,
          detection_method: 'haversine_distance_with_accuracy_adjustment',
          data_quality_notes: [
            'Both points passed coordinate, timestamp, freshness, and accuracy checks.',
            `Movement interval was ${intervalMinutes.toFixed(1)} minutes.`,
          ],
        }));
      }
    }
  }
  return { findings, limitations: [...new Set(limitations)].sort() };
}

function detectDispatchAnomalies(
  dispatches: RecordValue[],
  activities: RecordValue[],
): { findings: OperationalAnomalyFinding[]; limitations: string[] } {
  const findings: OperationalAnomalyFinding[] = [];
  const limitations: string[] = [];
  const activitiesByDispatch = new Map<string, RecordValue[]>();
  for (const activity of activities) {
    const dispatchId = identifier(activity.dispatchRequestId);
    if (!dispatchId) continue;
    const list = activitiesByDispatch.get(dispatchId) ?? [];
    list.push(activity);
    activitiesByDispatch.set(dispatchId, list);
  }

  for (const dispatch of dispatches) {
    const dispatchId = identifier(dispatch._id);
    if (!dispatchId) {
      limitations.push('A dispatch without an ID was skipped.');
      continue;
    }
    const events = activitiesByDispatch.get(dispatchId) ?? [];
    const assignments = events.filter((event) => event.eventType === 'assignment_changed');
    if (assignments.length > 1) {
      limitations.push(`Dispatch ${dispatchId} has multiple visible assignments, but its activity history is not confirmed complete; reassignment alert suppressed.`);
    }

    const statusEvents = events.filter((event) => event.eventType === 'status_changed');
    const timedEvents: Array<{ time: Date; event: RecordValue }> = [];
    for (const event of statusEvents) {
      const time = parseTimestamp(event.createdAt);
      if (!time) limitations.push(`Dispatch ${dispatchId} has a status event with an invalid timestamp; that event was skipped.`);
      else timedEvents.push({ time, event });
    }
    timedEvents.sort((first, second) => first.time.getTime() - second.time.getTime());
    let previousEventStatus: string | null = null;
    const seenEvents = new Set<string>();
    for (const { time, event } of timedEvents) {
      const previousStatus = nestedValue(event, 'previousValue', 'status');
      const nextStatus = nestedValue(event, 'newValue', 'status');
      const signature = `${time.toISOString()}|${JSON.stringify(previousStatus)}|${JSON.stringify(nextStatus)}`;
      if (seenEvents.has(signature)) {
        limitations.push(`Dispatch ${dispatchId} contains a duplicate status event; the duplicate was ignored.`);
        continue;
      }
      seenEvents.add(signature);
      if (typeof nextStatus !== 'string' || !(nextStatus in allowedStatusTransitions)) {
        limitations.push(`Dispatch ${dispatchId} has a status event with an unknown new status; it was skipped.`);
        if (typeof nextStatus === 'string') previousEventStatus = nextStatus;
        continue;
      }
      if (typeof previousStatus !== 'string') {
        limitations.push(`Dispatch ${dispatchId} lacks a known prior status for one event; its transition could not be checked.`);
      } else if (!allowedStatusTransitions[previousStatus]?.includes(nextStatus)) {
        findings.push(makeFinding({
          anomaly_type: 'invalid_status_transition',
          severity: 'high',
          dispatch_id: dispatchId,
          evidence_timestamp: timestampText(time),
          explanation: `Recorded status transition ${previousStatus} -> ${nextStatus} is not allowed by the SWERV lifecycle.`,
          measured_value: `${previousStatus} -> ${nextStatus}`,
          threshold: [...(allowedStatusTransitions[previousStatus] ?? [])].sort(),
          detection_method: 'documented_status_transition_table',
          data_quality_notes: ['A single recorded invalid transition is sufficient evidence; missing events may still hide earlier context.'],
        }));
      }
      if (previousEventStatus && typeof previousStatus === 'string' && previousStatus !== previousEventStatus) {
        limitations.push(`Dispatch ${dispatchId} has a gap or inconsistency between adjacent status events; the chain was not inferred.`);
      }
      previousEventStatus = nextStatus;
    }
  }
  return { findings, limitations: [...new Set(limitations)].sort() };
}

function validDeliveryDurations(
  dispatches: RecordValue[],
  activities: RecordValue[],
): { durations: Array<{ dispatchId: string; deliveredAt: Date; durationMinutes: number }>; limitations: string[] } {
  const activitiesByDispatch = new Map<string, RecordValue[]>();
  for (const activity of activities) {
    const dispatchId = identifier(activity.dispatchRequestId);
    if (!dispatchId) continue;
    const list = activitiesByDispatch.get(dispatchId) ?? [];
    list.push(activity);
    activitiesByDispatch.set(dispatchId, list);
  }
  const durations: Array<{ dispatchId: string; deliveredAt: Date; durationMinutes: number }> = [];
  const limitations: string[] = [];
  for (const dispatch of dispatches) {
    const dispatchId = identifier(dispatch._id);
    if (!dispatchId || dispatch.status !== 'delivered') continue;
    const events = activitiesByDispatch.get(dispatchId) ?? [];
    const deliveredEvents = events.filter((event) => event.eventType === 'status_changed' && nestedValue(event, 'newValue', 'status') === 'delivered');
    const pickupEvents = events.filter((event) => event.eventType === 'status_changed' && nestedValue(event, 'newValue', 'status') === 'picked_up');
    if (deliveredEvents.length !== 1 || pickupEvents.length !== 1) {
      limitations.push(`Delivered dispatch ${dispatchId} has missing or ambiguous delivery status events; duration skipped.`);
      continue;
    }
    const deliveredAt = parseTimestamp(deliveredEvents[0].createdAt);
    const pickedUpAt = parseTimestamp(pickupEvents[0].createdAt);
    const assignments = events.filter((event) => event.eventType === 'assignment_changed');
    const timedAssignments = assignments.map((event) => ({ time: parseTimestamp(event.createdAt), event }));
    if (!deliveredAt || !pickedUpAt || !timedAssignments.length) {
      limitations.push(`Delivered dispatch ${dispatchId} lacks a valid delivery timestamp or assignment event; duration skipped.`);
      continue;
    }
    if (timedAssignments.some((item) => !item.time)) {
      limitations.push(`Delivered dispatch ${dispatchId} has an assignment with an invalid timestamp; duration skipped.`);
      continue;
    }
    const assignment = timedAssignments
      .filter((item): item is { time: Date; event: RecordValue } => item.time !== null && item.time < pickedUpAt)
      .sort((first, second) => second.time.getTime() - first.time.getTime())[0];
    if (!assignment || !(assignment.time < pickedUpAt && pickedUpAt < deliveredAt)) {
      limitations.push(`Delivered dispatch ${dispatchId} has no assignment before delivery; duration skipped.`);
      continue;
    }
    const finalAgent = nestedValue(assignment.event, 'newValue', 'agentId');
    const dispatchAgent = identifier(dispatch.assignedAgent);
    if (finalAgent === null || finalAgent === undefined || !dispatchAgent) {
      limitations.push(`Delivered dispatch ${dispatchId} is missing the agent reference needed to verify its final assignment; duration skipped.`);
      continue;
    }
    if (String(finalAgent) !== dispatchAgent) {
      limitations.push(`Delivered dispatch ${dispatchId} final assignment does not match the request's agent; duration skipped.`);
      continue;
    }
    const durationMinutes = (deliveredAt.getTime() - assignment.time.getTime()) / 60_000;
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      limitations.push(`Delivered dispatch ${dispatchId} has a non-positive assignment-to-delivery duration; duration skipped.`);
      continue;
    }
    durations.push({ dispatchId, deliveredAt, durationMinutes });
  }
  return { durations, limitations: [...new Set(limitations)].sort() };
}

function percentile(values: number[], fraction: number): number {
  const position = (values.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;
  return values[lowerIndex] + (values[upperIndex] - values[lowerIndex]) * weight;
}

function detectDurationAnomalies(
  dispatches: RecordValue[],
  activities: RecordValue[],
): { findings: OperationalAnomalyFinding[]; limitations: string[] } {
  const { durations, limitations } = validDeliveryDurations(dispatches, activities);
  if (durations.length < minimumDurationSamples) {
    return {
      findings: [],
      limitations: [...limitations, `Delivery-duration baseline is insufficient: ${durations.length} valid completed deliveries; at least ${minimumDurationSamples} are required. No duration anomalies were reported.`],
    };
  }
  const orderedDurations = durations.map((item) => item.durationMinutes).sort((first, second) => first - second);
  const firstQuartile = percentile(orderedDurations, 0.25);
  const thirdQuartile = percentile(orderedDurations, 0.75);
  const upperThreshold = thirdQuartile + durationIqrMultiplier * (thirdQuartile - firstQuartile);
  const findings = durations.filter((item) => item.durationMinutes > upperThreshold).map((item) => makeFinding({
    anomaly_type: 'unusual_delivery_duration',
    severity: item.durationMinutes > upperThreshold * 2 ? 'high' : 'medium',
    dispatch_id: item.dispatchId,
    evidence_timestamp: timestampText(item.deliveredAt),
    explanation: `Assignment-to-delivery duration was ${item.durationMinutes.toFixed(1)} minutes, above the conservative Q3 + ${durationIqrMultiplier}*IQR baseline threshold of ${upperThreshold.toFixed(1)} minutes.`,
    measured_value: Math.round(item.durationMinutes * 100) / 100,
    threshold: Math.round(upperThreshold * 100) / 100,
    detection_method: 'upper_quartile_plus_configured_iqr_multiple',
    data_quality_notes: [
      `Baseline used ${durations.length} valid completed deliveries.`,
      'Completion time came from the delivered status activity, not DispatchRequest.updatedAt.',
    ],
  }));
  return { findings, limitations };
}

export function detectOperationalAnomalies(
  dispatches: RecordValue[],
  activities: RecordValue[],
  locations: RecordValue[],
): OperationalAnomalyReport {
  const gps = detectGpsAnomalies(locations);
  const dispatch = detectDispatchAnomalies(dispatches, activities);
  const duration = detectDurationAnomalies(dispatches, activities);
  return {
    findings: [...gps.findings, ...dispatch.findings, ...duration.findings],
    limitations: [...new Set([...gps.limitations, ...dispatch.limitations, ...duration.limitations])].sort(),
  };
}
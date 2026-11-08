import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '../models/Agent.js';
import { AgentActivity } from '../models/AgentActivity.js';
import { AgentLocation } from '../models/AgentLocation.js';
import { AnomalyAlert, AnomalyDemoAlert } from '../models/AnomalyAlert.js';
import { DispatchRequest } from '../models/DispatchRequest.js';
import { DispatchRequestActivity } from '../models/DispatchRequestActivity.js';
import { HttpError } from '../utils/httpError.js';
import { getAnomalyDetectionServiceUrl } from '../config/anomalyDetectionService.js';

const timeoutMs = 8_000;
const workspacePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ml/anomaly_detection');
const demoCsvPath = resolve(workspacePath, 'data/processed/synthetic/synthetic_demo.csv');
const featureColumns = [
  'gps_distance_km', 'gps_interval_minutes', 'implied_speed_kmh', 'gps_reported_speed_kmh',
  'gps_accuracy_meters', 'gps_freshness_minutes', 'gps_coordinates_valid', 'gps_timestamps_valid',
  'gps_pair_available', 'reassignment_count', 'assignment_event_count', 'activity_history_complete',
  'delivery_duration_minutes', 'status_event_count', 'status_transition_valid', 'agent_status_change_count',
  'agent_active_workload', 'dispatch_creation_hour', 'data_quality_issue_count', 'priority',
  'package_category', 'vehicle_type',
];
const supportedAnomalyTypes = new Set([
  'gps_missing_coordinates', 'gps_invalid_coordinates', 'gps_invalid_timestamp',
  'gps_invalid_timestamp_order', 'gps_stale_submission', 'gps_implausible_jump',
  'gps_stale_update', 'repeated_dispatch_reassignment', 'unusual_delivery_duration', 'invalid_status_transition',
]);
type DetectionMode = 'real' | 'synthetic_demo';
type FeatureRow = Record<string, string | number | null>;
const allowedStatusTransitions: Record<string, string[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['picked_up', 'cancelled'],
  picked_up: ['in_transit', 'failed'],
  in_transit: ['delivered', 'failed'],
  delivered: [], cancelled: [], failed: [],
};

function activityValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function isoTimestamp(value: unknown): string | null {
  const timestamp = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function distanceBetween(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitude2 - latitude1);
  const longitudeDelta = radians(longitude2 - longitude1);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function hasInvalidStatusTransition(events: Array<Record<string, any>>): boolean {
  return events.some((event) => {
    if (event.eventType !== 'status_changed') return false;
    const previousStatus = activityValue(event.previousValue).status;
    const nextStatus = activityValue(event.newValue).status;
    if (typeof previousStatus !== 'string' || typeof nextStatus !== 'string') return false;
    return !allowedStatusTransitions[previousStatus]?.includes(nextStatus);
  });
}

function makeRealFeatureRows(
  dispatches: Array<Record<string, any>>,
  activities: Array<Record<string, any>>,
  locations: Array<Record<string, any>>,
  agents: Array<Record<string, any>>,
  agentActivities: Array<Record<string, any>>,
): Array<{ features: FeatureRow; duration_baseline_count: number }> {
  const durations: number[] = [];
  for (const dispatch of dispatches) {
    const events = activities.filter((event) => String(event.dispatchRequestId) === String(dispatch._id))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const delivered = events.filter((event) => event.eventType === 'status_changed'
      && activityValue(event.newValue).status === 'delivered');
    const pickup = events.find((event) => event.eventType === 'status_changed'
      && activityValue(event.newValue).status === 'picked_up');
    const pickupTime = pickup ? new Date(pickup.createdAt).getTime() : Number.NaN;
    const assignments = events.filter((event) => event.eventType === 'assignment_changed'
      && new Date(event.createdAt).getTime() < pickupTime);
    const finalAssignment = assignments.at(-1);
    if (delivered.length === 1 && pickup && finalAssignment) {
      const assignmentTime = new Date(finalAssignment.createdAt).getTime();
      const deliveryTime = new Date(delivered[0].createdAt).getTime();
      const assignedAgentId = activityValue(finalAssignment.newValue).agentId;
      if (Number.isFinite(assignmentTime) && deliveryTime > assignmentTime
        && assignedAgentId != null && String(dispatch.assignedAgent) === String(assignedAgentId)) {
        durations.push((deliveryTime - assignmentTime) / 60_000);
      }
    }
  }
  const orderedDurations = [...durations].sort((left, right) => left - right);
  const agentById = new Map(agents.map((agent) => [String(agent._id), agent]));
  const result = dispatches.map((dispatch) => {
    const events = activities.filter((event) => String(event.dispatchRequestId) === String(dispatch._id))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const assignments = events.filter((event) => event.eventType === 'assignment_changed');
    const statusEvents = events.filter((event) => event.eventType === 'status_changed');
    const durationEvent = events.find((event) => event.eventType === 'status_changed' && activityValue(event.newValue).status === 'delivered');
    const pickupEvent = events.find((event) => event.eventType === 'status_changed' && activityValue(event.newValue).status === 'picked_up');
    const pickupTime = pickupEvent ? new Date(pickupEvent.createdAt).getTime() : Number.NaN;
    const eligibleAssignments = assignments.filter((event) => new Date(event.createdAt).getTime() < pickupTime);
    const finalAssignment = eligibleAssignments.at(-1);
    let duration: number | null = null;
    const deliveredEventCount = events.filter((event) => event.eventType === 'status_changed' && activityValue(event.newValue).status === 'delivered').length;
    if (deliveredEventCount === 1 && durationEvent && pickupEvent && finalAssignment) {
      const assignedTime = new Date(finalAssignment.createdAt).getTime();
      const deliveredTime = new Date(durationEvent.createdAt).getTime();
      const assignedAgentId = activityValue(finalAssignment.newValue).agentId;
      if (deliveredTime > new Date(pickupEvent.createdAt).getTime() && deliveredTime > assignedTime
        && (!dispatch.assignedAgent || String(dispatch.assignedAgent) === String(assignedAgentId))) {
        duration = (deliveredTime - assignedTime) / 60_000;
      }
    }
    const observedAssignment = dispatch.status === 'assigned' ? assignments.at(-1) : finalAssignment;
    const agentId = observedAssignment ? String(activityValue(observedAssignment.newValue).agentId ?? '') : String(dispatch.assignedAgent ?? '');
    const agent = agentById.get(agentId);
    const agentGps = locations.filter((point) => String(point.agentId) === agentId)
      .sort((left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime());
    const firstPoint = agentGps.at(-2);
    const lastPoint = agentGps.at(-1);
    const gpsInterval = firstPoint && lastPoint
      ? (new Date(lastPoint.recordedAt).getTime() - new Date(firstPoint.recordedAt).getTime()) / 60_000 : null;
    const gpsDistance = firstPoint && lastPoint
      ? distanceBetween(firstPoint.latitude, firstPoint.longitude, lastPoint.latitude, lastPoint.longitude) : null;
    const lastGps = lastPoint ? new Date(lastPoint.recordedAt).getTime() : null;
    const firstRecordedAt = firstPoint ? new Date(firstPoint.recordedAt).getTime() : Number.NaN;
    const firstReceivedAt = firstPoint ? new Date(firstPoint.receivedAt).getTime() : Number.NaN;
    const lastReceivedAt = lastPoint ? new Date(lastPoint.receivedAt).getTime() : Number.NaN;
    const assignmentTime = observedAssignment ? new Date(observedAssignment.createdAt).getTime() : Number.NaN;
    const gpsCanBeLinked = ['assigned', 'picked_up', 'in_transit'].includes(dispatch.status)
      && Boolean(dispatch.assignedAgent) && String(dispatch.assignedAgent) === agentId
      && agent?.activeDispatchCount === 1 && Number.isFinite(assignmentTime)
      && lastGps !== null && lastGps >= assignmentTime;
    const firstFreshness = Number.isFinite(firstReceivedAt - firstRecordedAt) ? (firstReceivedAt - firstRecordedAt) / 60_000 : null;
    const gpsFreshness = lastPoint && lastGps !== null && Number.isFinite(lastReceivedAt - lastGps)
      ? (lastReceivedAt - lastGps) / 60_000 : null;
    const gpsAccuracy = lastPoint?.accuracy ?? null;
    const firstAccuracy = firstPoint?.accuracy ?? null;
    const coordinatesValid = (point: typeof lastPoint) => Boolean(point
      && point.latitude >= -90 && point.latitude <= 90 && point.longitude >= -180 && point.longitude <= 180);
    const timestampsValid = Boolean(firstPoint && lastPoint && Number.isFinite(firstRecordedAt)
      && Number.isFinite(firstReceivedAt) && lastGps !== null && Number.isFinite(lastGps) && Number.isFinite(lastReceivedAt)
      && firstReceivedAt >= firstRecordedAt && lastReceivedAt >= lastGps);
    const gpsEligible = Boolean(gpsCanBeLinked && firstPoint && lastPoint && coordinatesValid(firstPoint) && coordinatesValid(lastPoint)
      && timestampsValid && gpsInterval !== null && gpsInterval > 0 && gpsInterval <= 15
      && gpsFreshness !== null && gpsFreshness <= 10 && firstFreshness !== null && firstFreshness <= 10
      && gpsAccuracy !== null && gpsAccuracy <= 100 && firstAccuracy !== null && firstAccuracy <= 100);
    const feature: FeatureRow = {
      gps_distance_km: gpsEligible ? gpsDistance : null,
      gps_interval_minutes: gpsEligible ? gpsInterval : null,
      implied_speed_kmh: gpsEligible && gpsDistance !== null && gpsInterval ? gpsDistance / (gpsInterval / 60) : null,
      gps_reported_speed_kmh: !gpsCanBeLinked || lastPoint?.speed == null ? null : lastPoint.speed * 3.6,
      gps_accuracy_meters: gpsCanBeLinked ? gpsAccuracy : null,
      gps_freshness_minutes: gpsCanBeLinked ? gpsFreshness : null,
      gps_coordinates_valid: !gpsCanBeLinked || !lastPoint ? null : (coordinatesValid(lastPoint) ? 1 : 0),
      gps_timestamps_valid: !gpsCanBeLinked || !lastPoint ? null : (timestampsValid ? 1 : 0),
      gps_pair_available: gpsEligible ? 1 : 0,
      reassignment_count: Math.max(0, assignments.length - 1),
      assignment_event_count: assignments.length,
      activity_history_complete: 0,
      delivery_duration_minutes: duration,
      status_event_count: statusEvents.length,
      status_transition_valid: statusEvents.some((event) => typeof activityValue(event.previousValue).status === 'string' && typeof activityValue(event.newValue).status === 'string')
        ? (hasInvalidStatusTransition(events) ? 0 : 1) : null,
      agent_status_change_count: agent ? agentActivities.filter((event) => String(event.agentId) === String(agent._id) && event.eventType === 'status_changed').length : 0,
      agent_active_workload: agent?.activeDispatchCount ?? 0,
      dispatch_creation_hour: Number.isFinite(new Date(dispatch.createdAt).getTime())
        ? new Date(dispatch.createdAt).getUTCHours() : null,
      data_quality_issue_count: (gpsEligible ? 0 : 1) + (events.some((event) => event.eventType === 'status_changed' && typeof activityValue(event.previousValue).status !== 'string') ? 1 : 0),
      priority: dispatch.priority,
      package_category: dispatch.package?.category,
      vehicle_type: gpsCanBeLinked ? agent?.vehicle?.vehicleType ?? null : null,
    };
    // Model imputation accepts null numeric values, but feature categories must be valid.
    return { features: feature, duration_baseline_count: orderedDurations.length };
  });
  return result;
}

export async function getSyntheticScenarios(
  datasetPath = demoCsvPath,
  metadataPath = resolve(workspacePath, 'data/processed/synthetic/synthetic_dataset_metadata.json'),
): Promise<{ scenarios: Array<Record<string, unknown>>; rows: Array<Record<string, string>> }> {
  let csv: string;
  let metadataText: string;
  try {
    [csv, metadataText] = await Promise.all([
      readFile(datasetPath, 'utf8'),
      readFile(metadataPath, 'utf8'),
    ]);
  }
  catch { throw new HttpError(503, 'Synthetic demo dataset is unavailable.'); }
  let metadata: Record<string, unknown>;
  try { metadata = JSON.parse(metadataText) as Record<string, unknown>; }
  catch { throw new HttpError(503, 'Synthetic demo dataset metadata is invalid.'); }
  if (metadata.synthetic_only !== true || metadata.data_source !== 'synthetic') throw new HttpError(503, 'Synthetic demo dataset provenance could not be verified.');
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const columns = header.split(',');
  if (![...featureColumns, 'scenario_id', 'anomaly_type', 'data_source', 'dataset_split'].every((column) => columns.includes(column))) {
    throw new HttpError(503, 'Synthetic demo dataset has an unsupported format.');
  }
  const rows = lines.map((line) => Object.fromEntries(line.split(',').map((value, index) => [columns[index], value])) as Record<string, string>);
  if (!rows.length || rows.some((row) => row.data_source !== 'synthetic' || row.dataset_split !== 'demo' || !row.scenario_id)) {
    throw new HttpError(503, 'Synthetic demo dataset contains invalid provenance.');
  }
  if (new Set(rows.map((row) => row.scenario_id)).size !== rows.length) throw new HttpError(503, 'Synthetic demo dataset contains duplicate scenarios.');
  const selected = [...rows.filter((row) => row.anomaly_type === 'normal').slice(0, 1)];
  const demoDurationBaselineCount = rows.filter((row) => row.anomaly_type === 'normal'
    && Number.isFinite(Number(row.delivery_duration_minutes))
    && Number(row.delivery_duration_minutes) > 0).length;
  const types = new Set<string>();
  for (const row of rows) {
    if (row.anomaly_type !== 'normal' && !types.has(row.anomaly_type)) {
      types.add(row.anomaly_type);
      selected.push(row);
    }
  }
  for (const row of rows) if (selected.length < 30 && !selected.includes(row)) selected.push(row);
  return {
    rows: selected,
    scenarios: selected.map((row) => ({
      duration_baseline_count: demoDurationBaselineCount,
      features: Object.fromEntries(featureColumns.map((name) => [name,
        row[name] === '' || row[name] === 'None' ? null
          : ['priority', 'package_category', 'vehicle_type'].includes(name) ? row[name]
            : Number(row[name]),
      ])),
    })),
  };
}

function validPythonResponse(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, any>;
  if (!['real', 'synthetic_demo'].includes(body.detection_mode)
    || typeof body.model_name !== 'string' || typeof body.model_version !== 'string'
    || !body.model_version.includes('synthetic') || body.training_data_source !== 'synthetic'
    || typeof body.synthetic_provenance !== 'string' || !body.synthetic_provenance.trim()
    || !Array.isArray(body.results) || !Array.isArray(body.rule_based_findings)
    || !Array.isArray(body.rule_based_limitations) || !body.rule_based_limitations.every((note: unknown) => typeof note === 'string')) return false;
  const validResult = (result: unknown) => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const row = result as Record<string, unknown>;
    return typeof row.is_anomaly_candidate === 'boolean'
      && typeof row.anomaly_score === 'number' && Number.isFinite(row.anomaly_score)
      && (row.predicted_category === null || (typeof row.predicted_category === 'string' && supportedAnomalyTypes.has(row.predicted_category)))
      && row.model_name === body.model_name && row.model_version === body.model_version
      && row.detection_method === 'machine_learning' && row.detection_mode === body.detection_mode
      && row.input_data_source === body.detection_mode && row.training_data_source === 'synthetic'
      && Array.isArray(row.data_quality_notes) && row.data_quality_notes.every((note) => typeof note === 'string');
  };
  const validFinding = (finding: unknown) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return false;
    const row = finding as Record<string, unknown>;
    return typeof row.anomaly_type === 'string' && supportedAnomalyTypes.has(row.anomaly_type)
      && ['low', 'medium', 'high', 'critical'].includes(String(row.severity))
      && typeof row.explanation === 'string' && typeof row.detection_method === 'string'
      && Array.isArray(row.data_quality_notes) && row.data_quality_notes.every((note) => typeof note === 'string')
      && (row.dispatch_id === null || typeof row.dispatch_id === 'string')
      && (row.agent_id === null || typeof row.agent_id === 'string');
  };
  return body.results.every(validResult) && body.rule_based_findings.every(validFinding);
}

function deduplicationKey(mode: DetectionMode, type: string, entity: string, timestamp: string | null): string {
  const timeWindow = timestamp && Number.isFinite(Date.parse(timestamp))
    ? Math.floor(Date.parse(timestamp) / 3_600_000) : 'unknown';
  return createHash('sha256').update(`${mode}|${type}|${entity}|${timeWindow}`).digest('hex');
}

async function saveAlert(mode: DetectionMode, alert: Record<string, any>): Promise<boolean> {
  const Model = mode === 'real' ? AnomalyAlert : AnomalyDemoAlert;
  const entity = alert.dispatch_id ?? alert.agent_id ?? alert.scenario_id ?? 'system';
  const evidenceTimestamp = alert.evidence_timestamp ?? null;
  const key = deduplicationKey(mode, alert.anomaly_type, String(entity), evidenceTimestamp);
  try {
    const result = await Model.updateOne({ deduplicationKey: key }, { $setOnInsert: {
    anomalyType: alert.anomaly_type,
    severity: ['low', 'medium', 'high', 'critical'].includes(alert.severity) ? alert.severity : 'medium',
    dispatchId: alert.dispatch_id ?? null,
    agentId: alert.agent_id ?? null,
    explanation: alert.explanation,
    evidenceTimestamp: evidenceTimestamp && Number.isFinite(Date.parse(evidenceTimestamp)) ? new Date(evidenceTimestamp) : null,
    measuredValue: alert.measured_value ?? null,
    threshold: alert.threshold ?? null,
    evidence: alert.evidence ?? null,
    detectionMethod: alert.detection_method,
    modelName: alert.model_name ?? null,
    modelVersion: alert.model_version ?? null,
    modelProvenance: alert.model_provenance ?? null,
    dataSource: mode,
    detectionMode: mode,
    dataQualityNotes: alert.data_quality_notes ?? [],
    deduplicationKey: key,
    } }, { upsert: true });
    return result.upsertedCount > 0;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return false;
    throw error;
  }
}

export async function runAnomalyDetection(mode: DetectionMode) {
  let scenarios: Array<Record<string, unknown>>;
  let realDispatchIds: string[] = [];
  let rawRecords: Record<string, unknown> = {};
  let demoRows: Array<Record<string, string>> = [];
  if (mode === 'synthetic_demo') {
    const demo = await getSyntheticScenarios();
    scenarios = demo.scenarios;
    demoRows = demo.rows;
  } else {
    const [dispatches, activities, locations, agents, agentActivities] = await Promise.all([
      DispatchRequest.find({}).select('_id status assignedAgent createdAt priority package.category').lean(),
      DispatchRequestActivity.find({}).select('dispatchRequestId eventType createdAt previousValue.status newValue.status newValue.agentId').lean(),
      AgentLocation.find({}).select('agentId latitude longitude accuracy speed recordedAt receivedAt').sort({ recordedAt: -1 }).limit(20_000).lean(),
      Agent.find({}).select('_id vehicle.vehicleType activeDispatchCount').lean(),
      AgentActivity.find({ eventType: 'status_changed' }).select('agentId eventType createdAt').lean(),
    ]);
    const rows = makeRealFeatureRows(dispatches, activities, locations, agents, agentActivities);
    scenarios = rows.map((row) => ({ duration_baseline_count: row.duration_baseline_count, features: row.features }));
    realDispatchIds = dispatches.map((item) => String(item._id));
    rawRecords = {
      dispatches: dispatches.map((item) => ({ _id: String(item._id), status: item.status, assignedAgent: item.assignedAgent ? String(item.assignedAgent) : null })),
      dispatch_activities: activities.map((item) => ({ dispatchRequestId: String(item.dispatchRequestId), eventType: item.eventType, createdAt: isoTimestamp(item.createdAt), previousValue: { status: activityValue(item.previousValue).status ?? null }, newValue: { status: activityValue(item.newValue).status ?? null, agentId: activityValue(item.newValue).agentId ? String(activityValue(item.newValue).agentId) : null } })),
      gps_locations: locations.map((item) => ({ agentId: String(item.agentId), latitude: item.latitude, longitude: item.longitude, accuracy: item.accuracy ?? null, recordedAt: isoTimestamp(item.recordedAt), receivedAt: isoTimestamp(item.receivedAt) })),
      complete_activity_history_ids: [],
    };
  }
  if (!scenarios.length) throw new HttpError(409, 'No dispatch requests are available in real mode. No synthetic demo data was used.');
  let body: Record<string, any> | null = null;
  for (let offset = 0; offset < scenarios.length; offset += 100) {
    const batch = scenarios.slice(offset, offset + 100);
    let response: Response;
    try {
      response = await fetch(`${getAnomalyDetectionServiceUrl()}/predict`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ detection_mode: mode, scenarios: batch, ...(offset === 0 ? rawRecords : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new HttpError(503, 'Anomaly detection service is unavailable or timed out.'); }
    let responseBody: unknown;
    try { responseBody = await response.json(); } catch { throw new HttpError(502, 'Anomaly detection service returned an invalid response.'); }
    if (!response.ok) throw new HttpError(response.status === 503 ? 503 : 502, response.status === 503 ? 'Anomaly detection model is unavailable.' : 'Anomaly detection service could not process the request.');
    if (!validPythonResponse(responseBody) || responseBody.detection_mode !== mode || responseBody.results.length !== batch.length) throw new HttpError(502, 'Anomaly detection service returned invalid results.');
    if (!body) body = responseBody;
    else {
      if (body.model_version !== responseBody.model_version || body.model_name !== responseBody.model_name) throw new HttpError(502, 'Anomaly detection service changed model metadata during the request.');
      body.results.push(...responseBody.results);
    }
  }
  if (!body) throw new HttpError(502, 'Anomaly detection service returned an invalid response.');

  const toSave: Array<Record<string, any>> = [...body.rule_based_findings];
  body.results.forEach((result: Record<string, any>, index: number) => {
    if (result.detection_mode !== mode || result.training_data_source !== 'synthetic' || result.model_version !== body.model_version) throw new HttpError(502, 'Anomaly detection service returned invalid model metadata.');
    if (result.is_anomaly_candidate && result.predicted_category) {
      const relevantEvents = Array.isArray(rawRecords.dispatch_activities)
        ? (rawRecords.dispatch_activities as Array<Record<string, unknown>>).filter((event) => event.dispatchRequestId === realDispatchIds[index])
        : [];
      const evidenceTimestamp = relevantEvents.map((event) => event.createdAt).filter((value): value is string => typeof value === 'string').sort().at(-1) ?? null;
      toSave.push({ anomaly_type: result.predicted_category, severity: 'medium', dispatch_id: mode === 'real' ? realDispatchIds[index] ?? null : null, agent_id: null, evidence_timestamp: mode === 'real' ? evidenceTimestamp : null, explanation: mode === 'synthetic_demo'
        ? `The synthetic-trained model marked demo scenario ${demoRows[index]?.scenario_id ?? index + 1} as an anomaly candidate. This is generated demonstration data, not an operational incident.`
        : `The synthetic-trained model marked dispatch scenario ${index + 1} as an anomaly candidate. This model is not validated on real SWERV records; review the score and data quality before drawing conclusions.`, measured_value: result.anomaly_score, threshold: null, evidence: { scenarioIndex: index, dataQualityNotes: result.data_quality_notes }, detection_method: 'machine_learning', model_name: result.model_name, model_version: result.model_version, model_provenance: result.synthetic_provenance, data_quality_notes: result.data_quality_notes, scenario_id: demoRows[index]?.scenario_id ?? realDispatchIds[index] ?? `real-${index}` });
    }
  });
  let savedAlerts = 0;
  for (const alert of toSave) if (await saveAlert(mode, alert)) savedAlerts += 1;
  return { mode, modelName: body.model_name, modelVersion: body.model_version, trainingDataSource: 'synthetic', syntheticProvenance: body.synthetic_provenance, scenarioCount: scenarios.length, candidateCount: toSave.length, savedAlerts, duplicateAlertsSkipped: toSave.length - savedAlerts, limitations: body.rule_based_limitations };
}

export async function listAnomalyAlerts(mode: DetectionMode, filters: Record<string, unknown>) {
  const Model = mode === 'real' ? AnomalyAlert : AnomalyDemoAlert;
  const page = Number(filters.page ?? 1);
  const limit = Number(filters.limit ?? 20);
  const query: Record<string, unknown> = {};
  for (const name of ['severity', 'anomalyType', 'reviewStatus'] as const) if (filters[name]) query[name === 'anomalyType' ? 'anomalyType' : name] = filters[name];
  const [alerts, total] = await Promise.all([Model.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Model.countDocuments(query)]);
  return { alerts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

export async function getAnomalyAlert(mode: DetectionMode, id: string) {
  const Model = mode === 'real' ? AnomalyAlert : AnomalyDemoAlert;
  const alert = await Model.findById(id).lean();
  if (!alert) throw new HttpError(404, 'Anomaly alert not found.');
  return alert;
}

export async function reviewAnomalyAlert(mode: DetectionMode, id: string, reviewerId: string, input: { reviewStatus?: string; reviewNotes?: string }) {
  const Model = mode === 'real' ? AnomalyAlert : AnomalyDemoAlert;
  const updates: Record<string, unknown> = { reviewerId, reviewedAt: new Date() };
  if (input.reviewStatus !== undefined) updates.reviewStatus = input.reviewStatus;
  if (input.reviewNotes !== undefined) updates.reviewNotes = input.reviewNotes;
  const alert = await Model.findByIdAndUpdate(id, { $set: updates }, { returnDocument: 'after', runValidators: true }).lean();
  if (!alert) throw new HttpError(404, 'Anomaly alert not found.');
  return alert;
}

export async function getAnomalySummary(mode: DetectionMode) {
  const Model = mode === 'real' ? AnomalyAlert : AnomalyDemoAlert;
  const [total, newCount, highSeverity, underReview, resolved] = await Promise.all([
    Model.countDocuments({}), Model.countDocuments({ reviewStatus: 'new' }),
    Model.countDocuments({ severity: { $in: ['high', 'critical'] } }),
    Model.countDocuments({ reviewStatus: 'under_review' }), Model.countDocuments({ reviewStatus: 'resolved' }),
  ]);
  return { mode, total, new: newCount, highSeverity, underReview, resolved };
}

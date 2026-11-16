import { createHash } from 'node:crypto';
import { AgentLocation } from '../models/AgentLocation.js';
import { AnomalyAlert, AnomalyDemoAlert } from '../models/AnomalyAlert.js';
import { DispatchRequest } from '../models/DispatchRequest.js';
import { DispatchRequestActivity } from '../models/DispatchRequestActivity.js';
import {
  getAnomalyDetectionServiceApiKey,
  getAnomalyDetectionServiceUrl,
} from '../config/anomalyDetectionService.js';
import { HttpError } from '../utils/httpError.js';
import type { OperationalAnomalyFinding } from './anomalyDetectionRules.js';
import { detectOperationalAnomalies } from './anomalyDetectionRules.js';
import { createUserNotifications } from './notificationService.js';
import { publishNotification } from '../realtime/socketServer.js';

const timeoutMs = 8_000;
const demoScenarioCount = 30;
const supportedDemoCategories = new Set([
  'normal', 'delivery_delay', 'gps_coordinate_jump', 'route_deviation',
  'repeated_delivery_failures', 'unusual_agent_activity',
  'suspicious_dispatch_pattern', 'abnormal_delivery_duration',
  'abnormal_delivery_distance',
]);
const alertCategoryForModelCandidate = 'unsupervised_outlier';

type DetectionMode = 'real' | 'synthetic_demo';
type Severity = 'low' | 'medium' | 'high' | 'critical';
type DemoScenarioResult = {
  scenario_index: number;
  scenario_id: string;
  anomaly_score: number;
  is_anomaly: boolean;
  decision_threshold: number;
  severity: 'none' | Severity;
  scenario_category: string | null;
  scenario_category_source: 'generated_demo_label' | null;
  scenario_category_is_model_prediction: false;
  explanation: string;
  timestamp: string;
};
type DemoAnalysisResponse = {
  detection_mode: 'synthetic_demo';
  results: DemoScenarioResult[];
  scenario_count: number;
  candidate_count: number;
  model_name: 'isolation_forest';
  model_version: string;
  training_data_source: 'synthetic';
  demonstration_provenance: string;
  generated_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expectedKeys].sort().join(',');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function expectedSeverity(score: number, threshold: number): 'none' | Severity {
  if (score < threshold) return 'none';
  const excess = score - threshold;
  if (excess < 0.01) return 'low';
  if (excess < 0.04) return 'medium';
  if (excess < 0.1) return 'high';
  return 'critical';
}

function validDemoAnalysis(value: unknown): value is DemoAnalysisResponse {
  if (!isRecord(value) || !hasExactKeys(value, [
    'detection_mode', 'results', 'scenario_count', 'candidate_count', 'model_name',
    'model_version', 'training_data_source', 'demonstration_provenance', 'generated_at',
  ])) return false;
  if (
    value.detection_mode !== 'synthetic_demo'
    || value.model_name !== 'isolation_forest'
    || typeof value.model_version !== 'string'
    || !value.model_version.startsWith('isolation_forest-synthetic-')
    || value.training_data_source !== 'synthetic'
    || typeof value.demonstration_provenance !== 'string'
    || !value.demonstration_provenance.trim()
    || !isTimestamp(value.generated_at)
    || value.scenario_count !== demoScenarioCount
    || !Array.isArray(value.results)
    || value.results.length !== demoScenarioCount
    || !Number.isInteger(value.candidate_count)
  ) return false;

  const scenarioIds = new Set<string>();
  let candidates = 0;
  for (let index = 0; index < value.results.length; index += 1) {
    const result = value.results[index];
    if (!isRecord(result) || !hasExactKeys(result, [
      'scenario_index', 'scenario_id', 'anomaly_score', 'is_anomaly', 'decision_threshold',
      'severity', 'scenario_category', 'scenario_category_source',
      'scenario_category_is_model_prediction', 'explanation', 'timestamp',
    ])) return false;
    if (
      result.scenario_index !== index
      || typeof result.scenario_id !== 'string'
      || !result.scenario_id.startsWith('demo-')
      || scenarioIds.has(result.scenario_id)
      || typeof result.anomaly_score !== 'number' || !Number.isFinite(result.anomaly_score)
      || typeof result.decision_threshold !== 'number' || !Number.isFinite(result.decision_threshold)
      || typeof result.is_anomaly !== 'boolean'
      || result.is_anomaly !== (result.anomaly_score >= result.decision_threshold)
      || result.severity !== expectedSeverity(result.anomaly_score, result.decision_threshold)
      || result.scenario_category_is_model_prediction !== false
      || typeof result.explanation !== 'string' || !result.explanation.trim()
      || !isTimestamp(result.timestamp)
    ) return false;
    if (result.scenario_category === null) {
      if (result.scenario_category_source !== null) return false;
    } else if (
      typeof result.scenario_category !== 'string'
      || !supportedDemoCategories.has(result.scenario_category)
      || result.scenario_category_source !== 'generated_demo_label'
    ) return false;
    scenarioIds.add(result.scenario_id);
    if (result.is_anomaly) candidates += 1;
  }
  return value.candidate_count === candidates;
}

function deduplicationKey(mode: DetectionMode, type: string, entity: string, timestamp: string | null): string {
  const timeWindow = timestamp && Number.isFinite(Date.parse(timestamp))
    ? Math.floor(Date.parse(timestamp) / 3_600_000) : 'unknown';
  return createHash('sha256').update(`${mode}|${type}|${entity}|${timeWindow}`).digest('hex');
}

async function saveAlert(
  mode: DetectionMode,
  alert: Record<string, any>,
): Promise<{ inserted: boolean; notifications: Awaited<ReturnType<typeof createUserNotifications>> }> {
  const Model = mode === 'real' ? AnomalyAlert : AnomalyDemoAlert;
  const entity = alert.dispatch_id ?? alert.agent_id ?? alert.scenario_id ?? 'system';
  const evidenceTimestamp = alert.evidence_timestamp ?? null;
  const key = deduplicationKey(mode, alert.anomaly_type, String(entity), evidenceTimestamp);
  const alertFields = {
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
  };

  if (mode === 'synthetic_demo') {
    try {
      const result = await Model.updateOne({ deduplicationKey: key }, { $setOnInsert: alertFields }, { upsert: true });
      return { inserted: result.upsertedCount > 0, notifications: [] };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
        return { inserted: false, notifications: [] };
      }
      throw error;
    }
  }

  const session = await DispatchRequest.startSession();
  let wasInserted = false;
  let notifications: Awaited<ReturnType<typeof createUserNotifications>> = [];
  try {
    await session.withTransaction(async () => {
      const result = await Model.updateOne({ deduplicationKey: key }, { $setOnInsert: alertFields }, { upsert: true, session });
      wasInserted = result.upsertedCount > 0;
      if (wasInserted && result.upsertedId) {
        notifications = await createUserNotifications(session, ['admin'], {
          eventType: 'anomaly_detected',
          title: `Anomaly detected: ${String(alert.anomaly_type).replaceAll('_', ' ')}`.slice(0, 120),
          message: String(alert.explanation).slice(0, 500),
          relatedEntityType: 'anomaly_alert',
          relatedEntityId: result.upsertedId,
        });
      }
    });
    notifications.forEach(publishNotification);
    return { inserted: wasInserted, notifications };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      return { inserted: false, notifications: [] };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function requestDemoAnalysis(): Promise<DemoAnalysisResponse> {
  const baseUrl = getAnomalyDetectionServiceUrl();
  const apiKey = getAnomalyDetectionServiceApiKey();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/analyze-demo`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
      ? 'timeout' : 'connection_error';
    console.warn('[anomaly-detection] Demo service request failed', { reason });
    throw new HttpError(503, 'Anomaly detection service is unavailable or timed out.');
  }

  if (response.status === 503) {
    console.warn('[anomaly-detection] Demo service reported unavailable', { upstream_status: response.status });
    throw new HttpError(503, 'Anomaly detection model is unavailable.');
  }
  if ([502, 504].includes(response.status)) {
    console.warn('[anomaly-detection] Demo service returned a transient status', { upstream_status: response.status });
    throw new HttpError(503, 'Anomaly detection service is currently unavailable.');
  }
  if (response.status === 401 || response.status === 403) {
    console.error('[anomaly-detection] Demo service authentication failed', { upstream_status: response.status });
    throw new HttpError(503, 'Anomaly detection service authentication is misconfigured.');
  }
  if (!response.ok) {
    console.warn('[anomaly-detection] Demo service rejected the request', { upstream_status: response.status });
    throw new HttpError(502, 'Anomaly detection service could not process the request.');
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new HttpError(502, 'Anomaly detection service returned an invalid response.');
  }
  if (!validDemoAnalysis(responseBody)) {
    console.warn('[anomaly-detection] Demo service returned an invalid successful response');
    throw new HttpError(502, 'Anomaly detection service returned invalid results.');
  }
  return responseBody;
}

async function runDemoDetection() {
  const result = await requestDemoAnalysis();
  let savedAlerts = 0;
  for (const candidate of result.results) {
    if (!candidate.is_anomaly) continue;
    const categoryContext = candidate.scenario_category
      ? ` Generated scenario label: ${candidate.scenario_category}; this label is not an Isolation Forest prediction.`
      : '';
    const alert = {
      anomaly_type: alertCategoryForModelCandidate,
      severity: candidate.severity,
      dispatch_id: null,
      agent_id: null,
      evidence_timestamp: null,
      explanation: `${candidate.explanation}${categoryContext}`,
      measured_value: candidate.anomaly_score,
      threshold: candidate.decision_threshold,
      evidence: {
        scenarioId: candidate.scenario_id,
        scenarioTimestamp: candidate.timestamp,
        scenarioCategory: candidate.scenario_category,
        scenarioCategorySource: candidate.scenario_category_source,
        scenarioCategoryIsModelPrediction: false,
      },
      detection_method: 'machine_learning',
      model_name: result.model_name,
      model_version: result.model_version,
      model_provenance: result.demonstration_provenance,
      data_quality_notes: [],
      scenario_id: candidate.scenario_id,
    };
    if ((await saveAlert('synthetic_demo', alert)).inserted) savedAlerts += 1;
  }
  return {
    mode: 'synthetic_demo' as const,
    detectionSource: 'machine_learning_demo' as const,
    modelName: result.model_name,
    modelVersion: result.model_version,
    trainingDataSource: result.training_data_source,
    syntheticProvenance: result.demonstration_provenance,
    scenarioCount: result.scenario_count,
    candidateCount: result.candidate_count,
    savedAlerts,
    duplicateAlertsSkipped: result.candidate_count - savedAlerts,
    limitations: [],
  };
}

async function runRealRuleDetection() {
  const [dispatchDocuments, activityDocuments, locationDocuments] = await Promise.all([
    DispatchRequest.find({}).select('_id status assignedAgent').lean(),
    DispatchRequestActivity.find({}).select('dispatchRequestId eventType createdAt previousValue newValue').lean(),
    AgentLocation.find({})
      .select('agentId latitude longitude accuracy recordedAt receivedAt')
      .sort({ recordedAt: -1 })
      .limit(20_000)
      .lean(),
  ]);
  const dispatches = dispatchDocuments as unknown as Array<Record<string, unknown>>;
  const activities = activityDocuments as unknown as Array<Record<string, unknown>>;
  const locations = locationDocuments as unknown as Array<Record<string, unknown>>;
  const report = detectOperationalAnomalies(dispatches, activities, locations);
  let savedAlerts = 0;
  for (const finding of report.findings) {
    if ((await saveAlert('real', finding as unknown as Record<string, any>)).inserted) savedAlerts += 1;
  }
  return {
    mode: 'real' as const,
    detectionSource: 'backend_rule_based' as const,
    modelName: 'Backend rule checks',
    modelVersion: null,
    trainingDataSource: 'not_applicable',
    syntheticProvenance: 'These findings were produced by backend rules. No ML model was called.',
    scenarioCount: dispatches.length,
    candidateCount: report.findings.length,
    savedAlerts,
    duplicateAlertsSkipped: report.findings.length - savedAlerts,
    limitations: report.limitations,
  };
}

export async function runAnomalyDetection(mode: DetectionMode) {
  return mode === 'synthetic_demo' ? runDemoDetection() : runRealRuleDetection();
}

export async function listAnomalyAlerts(mode: DetectionMode, filters: Record<string, unknown>) {
  const Model = mode === 'real' ? AnomalyAlert : AnomalyDemoAlert;
  const page = Number(filters.page ?? 1);
  const limit = Number(filters.limit ?? 20);
  const query: Record<string, unknown> = {};
  for (const name of ['severity', 'anomalyType', 'reviewStatus'] as const) {
    if (filters[name]) query[name] = filters[name];
  }
  const [alerts, total] = await Promise.all([
    Model.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Model.countDocuments(query),
  ]);
  return { alerts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

export async function getAnomalyAlert(mode: DetectionMode, id: string) {
  const Model = mode === 'real' ? AnomalyAlert : AnomalyDemoAlert;
  const alert = await Model.findById(id).lean();
  if (!alert) throw new HttpError(404, 'Anomaly alert not found.');
  return alert;
}

export async function reviewAnomalyAlert(
  mode: DetectionMode,
  id: string,
  reviewerId: string,
  input: { reviewStatus?: string; reviewNotes?: string },
) {
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
    Model.countDocuments({}),
    Model.countDocuments({ reviewStatus: 'new' }),
    Model.countDocuments({ severity: { $in: ['high', 'critical'] } }),
    Model.countDocuments({ reviewStatus: 'under_review' }),
    Model.countDocuments({ reviewStatus: 'resolved' }),
  ]);
  return { mode, total, new: newCount, highSeverity, underReview, resolved };
}
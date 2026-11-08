import type { RequestHandler } from 'express';
import { HttpError } from '../utils/httpError.js';
import { parseRequest } from '../utils/dispatchRequestValidation.js';
import { alertReviewSchema, detectionRequestSchema, parseAlertQuery, validateAlertId } from '../utils/anomalyValidation.js';
import { getAnomalyAlert, listAnomalyAlerts, reviewAnomalyAlert, runAnomalyDetection, getAnomalySummary } from '../services/anomalyDetectionService.js';

function handleAnomalyError(error: unknown, res: Parameters<RequestHandler>[1]) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ success: false, message: error.message });
    return;
  }
  // Do not expose database, file-system, or upstream details in API responses.
  res.status(500).json({ success: false, message: 'Anomaly detection request could not be completed.' });
}

export const runAnomalyDetectionHandler: RequestHandler = async (req, res) => {
  try {
    const input = parseRequest(detectionRequestSchema, req.body);
    const result = await runAnomalyDetection(input.mode);
    res.json({ success: true, message: 'Anomaly detection completed.', data: result });
  } catch (error) {
    handleAnomalyError(error, res);
  }
};

function requestedMode(value: unknown): 'real' | 'synthetic_demo' {
  if (value === 'real' || value === 'synthetic_demo') return value;
  throw new HttpError(400, 'Select either real or synthetic_demo mode.');
}

export const anomalyAlertsHandler: RequestHandler = async (req, res) => {
  try {
    const filters = parseAlertQuery(req.query as Record<string, unknown>);
    const data = await listAnomalyAlerts(filters.mode, filters);
    res.json({ success: true, data });
  } catch (error) { handleAnomalyError(error, res); }
};

export const anomalySummaryHandler: RequestHandler = async (req, res) => {
  try {
    const mode = requestedMode(req.query.mode);
    res.json({ success: true, data: await getAnomalySummary(mode) });
  } catch (error) { handleAnomalyError(error, res); }
};

export const anomalyAlertDetailsHandler: RequestHandler = async (req, res) => {
  try {
    const id = validateAlertId(req.params.id);
    const mode = requestedMode(req.query.mode);
    res.json({ success: true, data: { alert: await getAnomalyAlert(mode, id) } });
  } catch (error) { handleAnomalyError(error, res); }
};

export const reviewAnomalyAlertHandler: RequestHandler = async (req, res) => {
  try {
    const id = validateAlertId(req.params.id);
    if (!req.user) throw new HttpError(401, 'Authentication required.');
    const mode = requestedMode(req.query.mode);
    const input = parseRequest(alertReviewSchema, req.body);
    const alert = await reviewAnomalyAlert(mode, id, req.user.id, input);
    res.json({ success: true, message: 'Alert review was saved.', data: { alert } });
  } catch (error) { handleAnomalyError(error, res); }
};

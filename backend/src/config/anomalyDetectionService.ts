import { HttpError } from '../utils/httpError.js';

export function getAnomalyDetectionServiceUrl(): string {
  const configuredUrl = process.env.ANOMALY_DETECTION_SERVICE_URL?.trim()
    || 'http://127.0.0.1:8005';
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new HttpError(503, 'Anomaly detection service is not configured correctly.');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new HttpError(503, 'Anomaly detection service is not configured correctly.');
  }
  return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, '')}`;
}

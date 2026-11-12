import { HttpError } from '../utils/httpError.js';

const defaultMlServiceBaseUrl = 'http://127.0.0.1:8001';
const defaultDemoMlServiceBaseUrl = 'https://swerv-delivery-time-prediction.onrender.com';

export function getMlServiceBaseUrl(): string {
  const configuredUrl = process.env.ML_SERVICE_BASE_URL?.trim() || defaultMlServiceBaseUrl;
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new HttpError(503, 'Prediction service is not configured correctly.');
  }

  if (
    !['http:', 'https:'].includes(parsedUrl.protocol)
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
  ) {
    throw new HttpError(503, 'Prediction service is not configured correctly.');
  }

  return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, '')}`;
}

export function getDemoMlServiceBaseUrl(): string {
  const configuredUrl = process.env.ML_DEMO_SERVICE_BASE_URL?.trim() || defaultDemoMlServiceBaseUrl;
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new HttpError(503, 'Demo prediction service is not configured correctly.');
  }

  if (
    !['http:', 'https:'].includes(parsedUrl.protocol)
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
  ) {
    throw new HttpError(503, 'Demo prediction service is not configured correctly.');
  }

  return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, '')}`;
}

export function getSmartAgentMlServiceBaseUrl(): string {
  const configuredUrl = process.env.SMART_AGENT_ML_SERVICE_BASE_URL?.trim()
    || 'http://127.0.0.1:8002';
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new HttpError(503, 'Smart Agent Assignment service is not configured correctly.');
  }
  if (
    !['http:', 'https:'].includes(parsedUrl.protocol)
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
  ) {
    throw new HttpError(503, 'Smart Agent Assignment service is not configured correctly.');
  }
  return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, '')}`;
}

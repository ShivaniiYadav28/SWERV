import { HttpError } from '../utils/httpError.js';

const defaultServiceUrl = 'http://127.0.0.1:8004';

export function getDemandForecastingServiceUrl(): string {
  const configuredUrl = process.env.DEMAND_FORECASTING_SERVICE_URL?.trim() || defaultServiceUrl;
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new HttpError(503, 'Demand forecasting service is not configured correctly.');
  }

  if (
    !['http:', 'https:'].includes(parsedUrl.protocol)
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
  ) {
    throw new HttpError(503, 'Demand forecasting service is not configured correctly.');
  }

  return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, '')}`;
}

export function getDemandForecastingServiceApiKey(): string {
  const apiKey = process.env.DEMAND_FORECASTING_API_KEY?.trim();
  if (!apiKey || apiKey.length < 32) {
    throw new HttpError(503, 'Demand forecasting service is not configured correctly.');
  }
  return apiKey;
}

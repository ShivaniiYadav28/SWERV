import './config/loadEnv.js';
import app from './app.js';
import { connectDatabase } from './config/db.js';
import { ensureAuthCollections } from './services/authService.js';
import { ensureAgentCollections } from './services/agentService.js';
import { ensureDispatchRequestCollections } from './services/dispatchRequestService.js';
import { getJwtExpiry, getJwtSecret } from './utils/jwt.js';
import { ensureCustomerCollections } from './services/customerService.js';
import { ensureAgentLocationCollections } from './services/agentLocationService.js';
import { getAgentJwtExpiry, getAgentJwtSecret } from './utils/agentJwt.js';
import {
  ensureDeliveryTrackingCollections,
  getDeliveryTrackingExpirationDays,
} from './services/deliveryTrackingService.js';
import { ensureAnomalyAlertIndexes } from './models/AnomalyAlert.js';

const port = Number(process.env.PORT ?? 5000);
const mongoUri = process.env.MONGO_URI?.trim();

async function startServer(): Promise<void> {
  if (!mongoUri || mongoUri === 'your_mongodb_connection_string') {
    throw new Error(
      'MONGO_URI is missing. Set it in backend/.env before starting SWERV.',
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('PORT must be a valid TCP port.');

  getJwtSecret();
  getJwtExpiry();
  getAgentJwtSecret();
  getAgentJwtExpiry();
  getDeliveryTrackingExpirationDays();
  await connectDatabase(mongoUri);
  await ensureAuthCollections();
  await ensureAgentCollections();
  await ensureDispatchRequestCollections();
  await ensureCustomerCollections();
  await ensureAgentLocationCollections();
  await ensureDeliveryTrackingCollections();
  await ensureAnomalyAlertIndexes();

  app.listen(port, () => {
    console.info(`SWERV API listening on port ${port}`);
  });
}

startServer().catch((error: unknown) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const message =
    error instanceof Error ? error.message : 'Unknown startup error';
  console.error(
    isProduction
      ? 'SWERV API failed to start'
      : `SWERV API failed to start: ${message}`,
  );
  process.exitCode = 1;
});

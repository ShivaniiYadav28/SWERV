import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { AgentLocation } from '../models/AgentLocation.js';
import { DeliveryTracking } from '../models/DeliveryTracking.js';
import { DispatchRequest } from '../models/DispatchRequest.js';
import { DispatchRequestActivity } from '../models/DispatchRequestActivity.js';
import { HttpError } from '../utils/httpError.js';

const defaultExpirationDays = 7;
const maximumExpirationDays = 365;
const latestLocationAgeMs = 15 * 60 * 1_000;

export function getDeliveryTrackingExpirationDays(): number {
  const configuredDays = process.env.DELIVERY_TRACKING_TTL_DAYS;
  if (configuredDays === undefined || configuredDays.trim() === '') {
    return defaultExpirationDays;
  }

  const expirationDays = Number(configuredDays);
  if (!Number.isInteger(expirationDays) || expirationDays < 1 || expirationDays > maximumExpirationDays) {
    throw new Error('DELIVERY_TRACKING_TTL_DAYS must be a whole number between 1 and 365.');
  }
  return expirationDays;
}

export function getCustomerTrackingUrl(token: string): string {
  const frontendUrl = process.env.CLIENT_URL?.trim() || 'http://localhost:5173';
  return `${frontendUrl.replace(/\/+$/, '')}/track/${token}`;
}

async function runTransaction<T>(work: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
  } finally {
    await session.endSession();
  }
  if (result === undefined) throw new Error('Tracking link transaction did not complete.');
  return result;
}

export async function createDeliveryTrackingLink(dispatchRequestId: string, userId: string) {
  const expirationDays = getDeliveryTrackingExpirationDays();
  const now = new Date();

  return runTransaction(async (session) => {
    const dispatchRequest = await DispatchRequest.findById(dispatchRequestId).session(session);
    if (!dispatchRequest) throw new HttpError(404, 'Dispatch request not found.');

    const activeLink = await DeliveryTracking.findOne({
      dispatchRequestId,
      revokedAt: null,
      expiresAt: { $gt: now },
    }).session(session).lean();
    if (activeLink) throw new HttpError(409, 'An active tracking link already exists for this delivery.');

    // Expired links no longer occupy the one-active-link slot.
    await DeliveryTracking.updateMany(
      { dispatchRequestId, revokedAt: null, expiresAt: { $lte: now } },
      { $set: { revokedAt: now } },
      { session },
    );

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(now.getTime() + expirationDays * 24 * 60 * 60 * 1_000);
    const [trackingLink] = await DeliveryTracking.create([{
      dispatchRequestId,
      tokenHash,
      expiresAt,
      createdBy: userId,
    }], { session });

    return { token, expiresAt, createdAt: trackingLink.createdAt };
  });
}

export async function getDeliveryTrackingLinkStatus(dispatchRequestId: string) {
  const dispatchRequestExists = await DispatchRequest.exists({ _id: dispatchRequestId });
  if (!dispatchRequestExists) throw new HttpError(404, 'Dispatch request not found.');

  const trackingLink = await DeliveryTracking.findOne({ dispatchRequestId })
    .sort({ createdAt: -1 })
    .select('expiresAt revokedAt createdAt')
    .lean();
  if (!trackingLink) {
    return { exists: false, status: 'not_created' as const, createdAt: null, expiresAt: null, revokedAt: null };
  }

  const status = trackingLink.expiresAt <= new Date()
    ? 'expired'
    : trackingLink.revokedAt
      ? 'revoked'
      : 'active';

  return {
    exists: true,
    status,
    createdAt: trackingLink.createdAt,
    expiresAt: trackingLink.expiresAt,
    revokedAt: trackingLink.revokedAt,
  };
}

export async function revokeDeliveryTrackingLink(dispatchRequestId: string) {
  const dispatchRequestExists = await DispatchRequest.exists({ _id: dispatchRequestId });
  if (!dispatchRequestExists) throw new HttpError(404, 'Dispatch request not found.');

  const revokedLink = await DeliveryTracking.findOneAndUpdate(
    { dispatchRequestId, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } },
    { returnDocument: 'after' },
  ).select('revokedAt expiresAt createdAt').lean();

  if (!revokedLink) throw new HttpError(404, 'No active tracking link exists for this delivery.');
  return { status: 'revoked' as const, revokedAt: revokedLink.revokedAt };
}

function statusDescription(status: string): string {
  const descriptions: Record<string, string> = {
    pending: 'Your delivery request has been received.',
    assigned: 'A delivery agent has been assigned.',
    picked_up: 'Your package has been picked up.',
    in_transit: 'Your package is on the way.',
    delivered: 'Your package has been delivered.',
    cancelled: 'This delivery has been cancelled.',
    failed: 'The delivery could not be completed.',
  };
  return descriptions[status] ?? 'Your delivery status was updated.';
}

function readStatus(value: unknown): string | null {
  if (value && typeof value === 'object' && 'status' in value && typeof value.status === 'string') {
    return value.status;
  }
  return null;
}

function safeAddress(location: {
  address: string;
  addressLine2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  latitude?: number | null;
  longitude?: number | null;
}) {
  return {
    address: location.address,
    ...(location.addressLine2 ? { addressLine2: location.addressLine2 } : {}),
    city: location.city,
    region: location.region,
    postalCode: location.postalCode,
    country: location.country,
    ...(typeof location.latitude === 'number' && typeof location.longitude === 'number'
      ? { coordinates: { latitude: location.latitude, longitude: location.longitude } }
      : {}),
  };
}

export async function getPublicDeliveryTracking(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(404, 'Tracking link not found.');

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const trackingLink = await DeliveryTracking.findOne({ tokenHash })
    .select('dispatchRequestId expiresAt revokedAt')
    .lean();
  if (!trackingLink || trackingLink.revokedAt || trackingLink.expiresAt <= new Date()) {
    throw new HttpError(404, 'Tracking link is invalid or expired.');
  }

  const dispatchRequest = await DispatchRequest.findById(trackingLink.dispatchRequestId)
    .select('status package pickup delivery priority assignedAgent')
    .lean();
  if (!dispatchRequest) throw new HttpError(404, 'Tracking link not found.');

  const activity = await DispatchRequestActivity.find({
    dispatchRequestId: trackingLink.dispatchRequestId,
    eventType: { $in: ['request_created', 'status_changed'] },
  }).select('eventType newValue createdAt').sort({ createdAt: 1 }).lean();

  const timeline = activity.flatMap((entry) => {
    const status = readStatus(entry.newValue);
    if (!status) return [];
    return [{ status, description: statusDescription(status), timestamp: entry.createdAt }];
  });

  const response: {
    status: string;
    package: { description: string; category: string };
    pickup: ReturnType<typeof safeAddress>;
    destination: ReturnType<typeof safeAddress>;
    priority: string;
    timeline: typeof timeline;
    location: { latitude: number; longitude: number; recordedAt: Date } | null;
    lastLocationUpdate: Date | null;
    estimatedArrival: null;
  } = {
    status: dispatchRequest.status,
    package: {
      description: dispatchRequest.package.description,
      category: dispatchRequest.package.category,
    },
    pickup: safeAddress(dispatchRequest.pickup),
    destination: safeAddress(dispatchRequest.delivery),
    priority: dispatchRequest.priority,
    timeline,
    location: null,
    lastLocationUpdate: null,
    estimatedArrival: null,
  };

  const locationStatuses = ['picked_up', 'in_transit'];
  if (locationStatuses.includes(dispatchRequest.status) && dispatchRequest.assignedAgent) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - latestLocationAgeMs);
    const latestLocation = await AgentLocation.findOne({
      agentId: dispatchRequest.assignedAgent,
      recordedAt: { $gte: cutoff, $lte: now },
      receivedAt: { $gte: cutoff },
    }).select('latitude longitude recordedAt').sort({ recordedAt: -1, receivedAt: -1 }).lean();

    if (latestLocation) {
      response.location = {
        latitude: latestLocation.latitude,
        longitude: latestLocation.longitude,
        recordedAt: latestLocation.recordedAt,
      };
      response.lastLocationUpdate = latestLocation.recordedAt;
    }
  }

  return response;
}

export async function ensureDeliveryTrackingCollections(): Promise<void> {
  await DeliveryTracking.init();
}

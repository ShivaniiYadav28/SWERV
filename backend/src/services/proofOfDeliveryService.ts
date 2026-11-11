import { randomInt, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { Agent } from '../models/Agent.js';
import { DispatchRequest } from '../models/DispatchRequest.js';
import { DispatchRequestActivity } from '../models/DispatchRequestActivity.js';
import { createUserNotifications, type NotificationPayload } from './notificationService.js';
import { ProofOfDelivery, ProofOfDeliveryDraft } from '../models/ProofOfDelivery.js';
import { HttpError } from '../utils/httpError.js';
import { deletePodImage, type PodFileType, type StoredPodFile } from './podStorageService.js';

const otpLifetimeMs = 5 * 60 * 1_000;
const otpCooldownMs = 60 * 1_000;
const maxOtpAttempts = 5;

export type PodLocationInput = {
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  locationUnavailableReason?: 'permission_denied' | 'unsupported' | 'timeout' | 'not_available';
};

function publicStoredFile(file: { contentType: string; fileName: string }) {
  return { contentType: file.contentType, fileName: file.fileName };
}

function developmentOtpEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.POD_DEV_OTP_ENABLED === 'true';
}

function makeOtpHash(code: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(code, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyOtpHash(code: string, savedHash: string): boolean {
  const [salt, savedValue] = savedHash.split(':');
  if (!salt || !savedValue) return false;
  const actual = scryptSync(code, salt, 64);
  const expected = Buffer.from(savedValue, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function getEligibleDispatch(agentId: string, dispatchId: string) {
  const dispatch = await DispatchRequest.findOne({ _id: dispatchId, assignedAgent: agentId });
  if (!dispatch) throw new HttpError(404, 'Delivery not found.');
  if (!['assigned', 'picked_up', 'in_transit'].includes(dispatch.status)) {
    throw new HttpError(409, 'Proof can only be prepared for an active assigned delivery.');
  }
  if (await ProofOfDelivery.exists({ dispatchRequestId: dispatchId })) {
    throw new HttpError(409, 'Proof of delivery has already been submitted.');
  }
  return dispatch;
}

async function getOrCreateDraft(agentId: string, dispatchId: string) {
  await getEligibleDispatch(agentId, dispatchId);
  return ProofOfDeliveryDraft.findOneAndUpdate(
    { dispatchRequestId: dispatchId, agentId },
    { $setOnInsert: { dispatchRequestId: dispatchId, agentId } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
}

export async function getAgentPodStatus(agentId: string, dispatchId: string) {
  await getEligibleDispatch(agentId, dispatchId);
  const draft = await ProofOfDeliveryDraft.findOne({ dispatchRequestId: dispatchId, agentId }).lean();
  return {
    photoUploaded: Boolean(draft?.photo),
    photoFileName: draft?.photo?.fileName ?? null,
    signatureUploaded: Boolean(draft?.signature),
    signatureFileName: draft?.signature?.fileName ?? null,
    otpVerified: Boolean(draft?.otpVerifiedAt),
    otpExpiresAt: draft?.otpExpiresAt ?? null,
    locationRequired: true,
  };
}

export async function uploadPodEvidence(agentId: string, dispatchId: string, type: PodFileType, file: StoredPodFile) {
  const draft = await getOrCreateDraft(agentId, dispatchId);
  const oldFile = draft[type];
  draft[type] = file;
  await draft.save();
  if (oldFile && oldFile.storageKey !== file.storageKey) {
    try {
      await deletePodImage(oldFile);
    } catch {
      console.warn('POD object cleanup failed after replacing evidence.');
    }
  }
  return { uploaded: true, fileName: file.fileName };
}

export async function requestCustomerOtp(agentId: string, dispatchId: string) {
  const draft = await getOrCreateDraft(agentId, dispatchId);
  if (!draft.photo) throw new HttpError(409, 'Upload the delivery photo before requesting the customer code.');
  if (!developmentOtpEnabled()) {
    throw new HttpError(503, 'Customer OTP delivery is not configured. Set up a delivery provider before using POD outside development testing.');
  }
  const now = new Date();
  if (draft.otpLastSentAt && now.getTime() - draft.otpLastSentAt.getTime() < otpCooldownMs) {
    throw new HttpError(429, 'Wait one minute before requesting another customer code.');
  }
  const code = String(randomInt(100_000, 1_000_000));
  draft.otpHash = makeOtpHash(code);
  draft.otpExpiresAt = new Date(now.getTime() + otpLifetimeMs);
  draft.otpLastSentAt = now;
  draft.otpAttempts = 0;
  draft.otpVerifiedAt = null;
  await draft.save();
  return { deliveryMode: 'development_test_code' as const, developmentOtp: code, expiresAt: draft.otpExpiresAt };
}

export async function verifyCustomerOtp(agentId: string, dispatchId: string, code: string) {
  await getEligibleDispatch(agentId, dispatchId);
  const draft = await ProofOfDeliveryDraft.findOne({ dispatchRequestId: dispatchId, agentId }).select('+otpHash');
  if (!draft) throw new HttpError(409, 'Request a customer code before verifying it.');
  if (!draft.otpHash || !draft.otpExpiresAt) throw new HttpError(409, 'Request a customer code before verifying it.');
  if (draft.otpExpiresAt.getTime() <= Date.now()) throw new HttpError(410, 'The customer code expired. Request a new one.');
  if (draft.otpAttempts >= maxOtpAttempts) throw new HttpError(429, 'Too many incorrect attempts. Request a new customer code later.');
  if (!verifyOtpHash(code, draft.otpHash)) {
    draft.otpAttempts += 1;
    await draft.save();
    throw new HttpError(draft.otpAttempts >= maxOtpAttempts ? 429 : 400,
      draft.otpAttempts >= maxOtpAttempts ? 'Too many incorrect attempts. Request a new customer code later.' : 'The customer code is incorrect.');
  }
  draft.otpVerifiedAt = new Date();
  draft.otpHash = null;
  await draft.save();
  return { verified: true, verifiedAt: draft.otpVerifiedAt };
}

async function runTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => { result = await work(session); });
  } finally {
    await session.endSession();
  }
  if (result === undefined) throw new Error('Proof of delivery transaction did not complete.');
  return result;
}

export async function submitProofOfDelivery(agentId: string, dispatchId: string, location: PodLocationInput) {
  return runTransaction(async (session) => {
    const dispatch = await DispatchRequest.findOne({ _id: dispatchId, assignedAgent: agentId }).session(session);
    if (!dispatch) throw new HttpError(404, 'Delivery not found.');
    if (dispatch.status !== 'in_transit') throw new HttpError(409, 'Move this delivery to In transit before submitting proof.');
    if (await ProofOfDelivery.exists({ dispatchRequestId: dispatchId }).session(session)) {
      throw new HttpError(409, 'Proof of delivery has already been submitted.');
    }
    const draft = await ProofOfDeliveryDraft.findOne({ dispatchRequestId: dispatchId, agentId }).session(session);
    if (!draft?.photo || !draft.signature || !draft.otpVerifiedAt) {
      throw new HttpError(409, 'A delivery photo, verified customer code, and signature are required.');
    }
    const deliveredAt = new Date();
    const pod = new ProofOfDelivery({
      dispatchRequestId: dispatch._id,
      agentId,
      photo: draft.photo,
      signature: draft.signature,
      otpVerified: true,
      otpVerifiedAt: draft.otpVerifiedAt,
      locationStatus: location.latitude === undefined ? 'unavailable' : 'captured',
      latitude: location.latitude ?? null,
      longitude: location.longitude ?? null,
      accuracyMeters: location.accuracyMeters ?? null,
      locationUnavailableReason: location.locationUnavailableReason ?? null,
      deliveredAt,
    });
    await pod.save({ session });
    dispatch.status = 'delivered';
    dispatch.deliveredAt = deliveredAt;
    const assignedTime = dispatch.assignedAt ? new Date(dispatch.assignedAt).getTime() : NaN;
    if (!Number.isNaN(assignedTime) && deliveredAt.getTime() > assignedTime) {
      const duration = (deliveredAt.getTime() - assignedTime) / 60_000;
      dispatch.actualDurationMinutes = Number.isFinite(duration) && duration > 0 ? duration : null;
    } else {
      dispatch.actualDurationMinutes = null;
    }
    await dispatch.save({ session });
    await Agent.updateOne({ _id: agentId, activeDispatchCount: { $gt: 0 } }, { $inc: { activeDispatchCount: -1 } }, { session });
    await DispatchRequestActivity.create([{
      dispatchRequestId: dispatch._id,
      eventType: 'status_changed',
      description: 'Delivery completed after proof of delivery was verified.',
      actorType: 'agent',
      performedByAgent: agentId,
      previousValue: { status: 'in_transit' },
      newValue: { status: 'delivered' },
    }], { session });
    await ProofOfDeliveryDraft.deleteOne({ _id: draft._id }, { session });
    const notifications: NotificationPayload[] = await createUserNotifications(session, ['admin', 'operator'], {
      eventType: 'delivery_completed',
      title: 'Delivery completed',
      message: `Dispatch #${dispatch.id.slice(-8).toUpperCase()} was completed with verified proof of delivery.`,
      relatedEntityType: 'dispatch',
      relatedEntityId: dispatch._id,
    });
    return { pod, notifications };
  });
}

export async function getAgentPodEvidence(agentId: string, dispatchId: string, type: PodFileType) {
  const pod = await ProofOfDelivery.findOne({ dispatchRequestId: dispatchId, agentId }).lean();
  if (pod) return pod[type];
  const draft = await ProofOfDeliveryDraft.findOne({ dispatchRequestId: dispatchId, agentId }).lean();
  if (!draft?.[type]) throw new HttpError(404, 'Proof file not found.');
  return draft[type];
}

export async function listProofOfDelivery() {
  const records = await ProofOfDelivery.find().sort({ deliveredAt: -1 }).limit(200).lean();
  const agentIds = [...new Set(records.map((record) => record.agentId.toString()))];
  const agents = await Agent.find({ _id: { $in: agentIds } }).select('name agentCode').lean();
  const agentById = new Map(agents.map((agent) => [agent._id.toString(), { name: agent.name, agentCode: agent.agentCode }]));
  return records.map((record) => ({
    ...record,
    photo: publicStoredFile(record.photo),
    signature: publicStoredFile(record.signature),
    agent: agentById.get(record.agentId.toString()) ?? null,
  }));
}

export async function getAdminPod(dispatchId: string) {
  const pod = await ProofOfDelivery.findOne({ dispatchRequestId: dispatchId }).lean();
  if (!pod) throw new HttpError(404, 'Proof of delivery not found.');
  const agent = await Agent.findById(pod.agentId).select('name agentCode').lean();
  return {
    ...pod,
    photo: publicStoredFile(pod.photo),
    signature: publicStoredFile(pod.signature),
    agent: agent ? { name: agent.name, agentCode: agent.agentCode } : null,
  };
}

export async function getAdminPodEvidence(dispatchId: string, type: PodFileType) {
  const pod = await ProofOfDelivery.findOne({ dispatchRequestId: dispatchId }).lean();
  if (!pod) throw new HttpError(404, 'Proof of delivery not found.');
  return pod[type];
}

export async function ensureProofOfDeliveryCollections(): Promise<void> {
  await Promise.all([ProofOfDelivery.createIndexes(), ProofOfDeliveryDraft.createIndexes()]);
}

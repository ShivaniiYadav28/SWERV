import type { RequestHandler } from 'express';
import { getAdminPod, getAdminPodEvidence, getAgentPodEvidence, getAgentPodStatus, listProofOfDelivery, requestCustomerOtp, submitProofOfDelivery, uploadPodEvidence, verifyCustomerOtp } from '../services/proofOfDeliveryService.js';
import { deletePodImage, readPodImage, storePodImage, type PodFileType } from '../services/podStorageService.js';
import { HttpError } from '../utils/httpError.js';
import { parseDispatchRequestId } from '../utils/dispatchRequestValidation.js';
import { parsePodRequest, submitPodSchema, verifyPodOtpSchema } from '../utils/proofOfDeliveryValidation.js';
import { publishDispatchUpdate, publishNotification } from '../realtime/socketServer.js';

function agentId(req: Parameters<RequestHandler>[0]): string {
  if (!req.agentId) throw new HttpError(401, 'Agent authentication required.');
  return req.agentId;
}

function imageKind(value: string): PodFileType {
  if (value === 'photo' || value === 'signature') return value;
  throw new HttpError(400, 'Unknown proof image type.');
}

function routeValue(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function rawImage(req: Parameters<RequestHandler>[0], type: PodFileType): { bytes: Buffer; contentType: string; fileName: string } {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Select a non-empty image file.');
  const contentType = req.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const encodedFileName = req.get('x-file-name')?.trim() ?? '';
  let fileName = '';
  try { fileName = decodeURIComponent(encodedFileName); } catch { throw new HttpError(400, 'Provide a valid image file name.'); }
  if (!fileName || fileName.length > 120) throw new HttpError(400, 'Provide a valid image file name.');
  if (type === 'signature' && contentType !== 'image/png') throw new HttpError(400, 'Signature images must be PNG files.');
  if (type === 'photo' && !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    throw new HttpError(400, 'Upload a JPEG, PNG, or WebP photo.');
  }
  const maxBytes = type === 'photo' ? 5 * 1024 * 1024 : 1 * 1024 * 1024;
  if (req.body.length > maxBytes) throw new HttpError(413, 'The selected image is too large.');
  return { bytes: req.body, contentType, fileName };
}

async function sendImage(res: Parameters<RequestHandler>[1], file: { storageKey: string; contentType: string; fileName: string }) {
  const bytes = await readPodImage(file.storageKey);
  res.set({ 'Content-Type': file.contentType, 'Content-Disposition': `inline; filename="${file.fileName}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(bytes);
}

export const getAgentPodStatusHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const status = await getAgentPodStatus(agentId(req), id);
  res.json({ success: true, message: 'Proof of delivery status retrieved.', data: status });
};

export function uploadAgentPodEvidenceHandler(type: PodFileType): RequestHandler {
  return async (req, res) => {
    const id = parseDispatchRequestId(req.params.id);
    const uploaded = rawImage(req, type);
    const stored = await storePodImage(type, uploaded.fileName, uploaded.contentType, uploaded.bytes);
    try {
      const result = await uploadPodEvidence(agentId(req), id, type, stored);
      res.status(201).json({ success: true, message: 'Proof image uploaded.', data: result });
    } catch (error) {
      await deletePodImage(stored.storageKey);
      throw error;
    }
  };
}

export const requestAgentPodOtpHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const result = await requestCustomerOtp(agentId(req), id);
  res.json({ success: true, message: 'Development test code created. It was not sent to the customer.', data: result });
};

export const verifyAgentPodOtpHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const { otp } = parsePodRequest(verifyPodOtpSchema, req.body);
  const result = await verifyCustomerOtp(agentId(req), id, otp);
  res.json({ success: true, message: 'Customer code verified.', data: result });
};

export const submitAgentPodHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const location = parsePodRequest(submitPodSchema, req.body);
  const { pod, notifications } = await submitProofOfDelivery(agentId(req), id, location);
  notifications.forEach(publishNotification);
  publishDispatchUpdate({ dispatchId: id, status: 'delivered', assignedAgentId: agentId(req) });
  res.status(201).json({ success: true, message: 'Proof of delivery saved and delivery completed.', data: { pod: {
    dispatchRequestId: pod.dispatchRequestId,
    deliveredAt: pod.deliveredAt,
    otpVerified: pod.otpVerified,
    otpVerifiedAt: pod.otpVerifiedAt,
    locationStatus: pod.locationStatus,
    latitude: pod.latitude,
    longitude: pod.longitude,
    accuracyMeters: pod.accuracyMeters,
    locationUnavailableReason: pod.locationUnavailableReason,
  } } });
};

export const getAgentPodImageHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const type = imageKind(routeValue(req.params.kind));
  const file = await getAgentPodEvidence(agentId(req), id, type);
  await sendImage(res, file);
};

export const listAdminPodHandler: RequestHandler = async (_req, res) => {
  const records = await listProofOfDelivery();
  res.json({ success: true, message: 'Proof of delivery records retrieved.', data: { records } });
};

export const getAdminPodHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const pod = await getAdminPod(id);
  res.json({ success: true, message: 'Proof of delivery retrieved.', data: { pod } });
};

export const getAdminPodImageHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const type = imageKind(routeValue(req.params.kind));
  const file = await getAdminPodEvidence(id, type);
  await sendImage(res, file);
};

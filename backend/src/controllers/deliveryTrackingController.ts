import type { RequestHandler } from 'express';
import {
  createDeliveryTrackingLink,
  getCustomerTrackingUrl,
  getDeliveryTrackingLinkStatus,
  getPublicDeliveryTracking,
  revokeDeliveryTrackingLink,
} from '../services/deliveryTrackingService.js';
import { HttpError } from '../utils/httpError.js';
import { parseDispatchRequestId } from '../utils/dispatchRequestValidation.js';

function currentUserId(req: Parameters<RequestHandler>[0]): string {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return req.user.id;
}

export const createDeliveryTrackingLinkHandler: RequestHandler = async (req, res) => {
  const dispatchRequestId = parseDispatchRequestId(req.params.id);
  const result = await createDeliveryTrackingLink(dispatchRequestId, currentUserId(req));
  res.status(201).json({
    success: true,
    message: 'Customer tracking link created. Copy it now; the token will not be shown again.',
    data: {
      token: result.token,
      trackingUrl: getCustomerTrackingUrl(result.token),
      expiresAt: result.expiresAt,
      createdAt: result.createdAt,
    },
  });
};

export const getDeliveryTrackingLinkStatusHandler: RequestHandler = async (req, res) => {
  const dispatchRequestId = parseDispatchRequestId(req.params.id);
  const status = await getDeliveryTrackingLinkStatus(dispatchRequestId);
  res.json({ success: true, message: 'Tracking link status retrieved.', data: { trackingLink: status } });
};

export const revokeDeliveryTrackingLinkHandler: RequestHandler = async (req, res) => {
  const dispatchRequestId = parseDispatchRequestId(req.params.id);
  const result = await revokeDeliveryTrackingLink(dispatchRequestId);
  res.json({ success: true, message: 'Customer tracking link revoked.', data: { trackingLink: result } });
};

export const getPublicDeliveryTrackingHandler: RequestHandler = async (req, res) => {
  const token = req.params.token;
  if (typeof token !== 'string') throw new HttpError(404, 'Tracking link not found.');
  const tracking = await getPublicDeliveryTracking(token);
  res.json({ success: true, message: 'Delivery tracking retrieved.', data: { tracking } });
};

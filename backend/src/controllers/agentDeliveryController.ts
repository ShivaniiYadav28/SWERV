import type { RequestHandler } from 'express';
import { changeAgentDeliveryStatus, getAgentDelivery, listAgentDeliveries } from '../services/dispatchRequestService.js';
import { dispatchStatusSchema, parseDispatchRequestId, parseRequest } from '../utils/dispatchRequestValidation.js';
import { HttpError } from '../utils/httpError.js';
import { publishDispatchUpdate, publishNotification } from '../realtime/socketServer.js';

function authenticatedAgentId(req: Parameters<RequestHandler>[0]): string {
  if (!req.agentId) throw new HttpError(401, 'Agent authentication required.');
  return req.agentId;
}

export const listAgentDeliveriesHandler: RequestHandler = async (req, res) => {
  const deliveries = await listAgentDeliveries(authenticatedAgentId(req));
  res.json({ success: true, message: 'Assigned deliveries retrieved.', data: { deliveries } });
};

export const listAgentDeliveryHistoryHandler: RequestHandler = async (req, res) => {
  const deliveries = await listAgentDeliveries(authenticatedAgentId(req), true);
  res.json({ success: true, message: 'Delivery history retrieved.', data: { deliveries } });
};

export const getAgentDeliveryHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const result = await getAgentDelivery(authenticatedAgentId(req), id);
  res.json({ success: true, message: 'Delivery retrieved.', data: result });
};

export const updateAgentDeliveryStatusHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const { status } = parseRequest(dispatchStatusSchema, req.body);
  const { dispatchRequest, notifications } = await changeAgentDeliveryStatus(authenticatedAgentId(req), id, status);
  notifications.forEach(publishNotification);
  publishDispatchUpdate({
    dispatchId: dispatchRequest.id,
    status: dispatchRequest.status,
    assignedAgentId: dispatchRequest.assignedAgent?.toString() ?? null,
  });
  res.json({ success: true, message: 'Delivery status updated.', data: { dispatchRequest } });
};

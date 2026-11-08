import type { RequestHandler } from 'express';
import {
  assignDispatchRequest,
  changeDispatchRequestStatus,
  createDispatchRequest,
  getDispatchRequest,
  listDispatchRequests,
  updateDispatchRequestCoordinates,
} from '../services/dispatchRequestService.js';
import { HttpError } from '../utils/httpError.js';
import {
  dispatchAssignmentSchema,
  dispatchRequestListQuerySchema,
  dispatchStatusSchema,
  updateDispatchRequestCoordinatesSchema,
  createDispatchRequestSchema,
  parseDispatchRequestId,
  parseRequest,
} from '../utils/dispatchRequestValidation.js';

function actorId(req: Parameters<RequestHandler>[0]): string {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return req.user.id;
}

export const createDispatchRequestHandler: RequestHandler = async (req, res) => {
  const input = parseRequest(createDispatchRequestSchema, req.body);
  const dispatchRequest = await createDispatchRequest(input, actorId(req));
  res.status(201).json({
    success: true,
    message: 'Dispatch request created successfully.',
    data: { dispatchRequest },
  });
};

export const listDispatchRequestsHandler: RequestHandler = async (req, res) => {
  const query = parseRequest(dispatchRequestListQuerySchema, req.query);
  const result = await listDispatchRequests(
    query.page,
    query.limit,
    query.status,
    query.priority,
  );
  res.json({
    success: true,
    message: 'Dispatch requests retrieved successfully.',
    data: result,
  });
};

export const getDispatchRequestHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const { dispatchRequest, activity } = await getDispatchRequest(id);
  res.json({
    success: true,
    message: 'Dispatch request retrieved successfully.',
    data: { dispatchRequest, activity },
  });
};

export const assignDispatchRequestHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const { agentId } = parseRequest(dispatchAssignmentSchema, req.body);
  const dispatchRequest = await assignDispatchRequest(id, agentId, actorId(req));
  res.json({
    success: true,
    message: 'Agent assigned successfully.',
    data: { dispatchRequest },
  });
};

export const changeDispatchRequestStatusHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const { status } = parseRequest(dispatchStatusSchema, req.body);
  const dispatchRequest = await changeDispatchRequestStatus(id, status, actorId(req));
  res.json({
    success: true,
    message: 'Dispatch request status updated successfully.',
    data: { dispatchRequest },
  });
};

export const updateDispatchRequestCoordinatesHandler: RequestHandler = async (req, res) => {
  const id = parseDispatchRequestId(req.params.id);
  const input = parseRequest(updateDispatchRequestCoordinatesSchema, req.body);
  const dispatchRequest = await updateDispatchRequestCoordinates(id, input, actorId(req));
  res.json({
    success: true,
    message: 'Dispatch request map coordinates updated successfully.',
    data: { dispatchRequest },
  });
};

import type { RequestHandler } from 'express';
import {
  applyAgentRoutePlan,
  getAgentRoutePlan,
  listAgentRouteDeliveries,
  previewAgentRoute,
} from '../services/routeOptimizationService.js';
import { HttpError } from '../utils/httpError.js';
import { parseAgentId } from '../utils/agentValidation.js';
import { parseRouteRequest, routeApplySchema, routePreviewSchema } from '../utils/routeOptimizationValidation.js';

function authenticatedUserId(req: Parameters<RequestHandler>[0]): string {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return req.user.id;
}

export const listAgentRouteDeliveriesHandler: RequestHandler = async (req, res) => {
  const agentId = parseAgentId(req.params.agentId);
  const deliveries = await listAgentRouteDeliveries(agentId);
  res.json({ success: true, message: 'Eligible route deliveries retrieved.', data: { deliveries } });
};

export const getAgentRoutePlanHandler: RequestHandler = async (req, res) => {
  const agentId = parseAgentId(req.params.agentId);
  const routePlan = await getAgentRoutePlan(agentId);
  res.json({ success: true, message: 'Saved route plan retrieved.', data: { routePlan } });
};

export const previewAgentRouteHandler: RequestHandler = async (req, res) => {
  const input = parseRouteRequest(routePreviewSchema, req.body);
  const preview = await previewAgentRoute(input.agentId, input.dispatchRequestIds);
  res.json({ success: true, message: 'Road route optimization preview ready.', data: { preview } });
};

export const applyAgentRoutePlanHandler: RequestHandler = async (req, res) => {
  const input = parseRouteRequest(routeApplySchema, req.body);
  const routePlan = await applyAgentRoutePlan(
    input.agentId,
    input.dispatchRequestIds,
    input.stopSequence,
    authenticatedUserId(req),
  );
  res.json({ success: true, message: 'Optimized route order saved.', data: { routePlan } });
};

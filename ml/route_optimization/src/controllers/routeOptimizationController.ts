import type { RequestHandler } from 'express';
import { optimizeAgentRoute } from '../services/routeOptimizationService.js';
import { parseRouteOptimizationRequest } from '../utils/routeOptimizationValidation.js';

export const healthHandler: RequestHandler = (_req, res) => {
  res.json({ status: 'ok' });
};

export const optimizeRouteHandler: RequestHandler = async (req, res) => {
  const input = parseRouteOptimizationRequest(req.body);
  const preview = await optimizeAgentRoute(input);
  res.json({ success: true, data: { preview } });
};

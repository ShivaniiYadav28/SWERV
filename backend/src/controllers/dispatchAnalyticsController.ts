import type { RequestHandler } from 'express';
import { getDispatchAnalytics } from '../services/dispatchAnalyticsService.js';
import { dispatchAnalyticsQuerySchema, parseRequest } from '../utils/dispatchRequestValidation.js';

export const getDispatchAnalyticsHandler: RequestHandler = async (req, res) => {
  const query = parseRequest(dispatchAnalyticsQuerySchema, req.query);
  const analytics = await getDispatchAnalytics(query.startDate, query.endDate);
  res.json({
    success: true,
    message: 'Dispatch analytics retrieved successfully.',
    data: analytics,
  });
};

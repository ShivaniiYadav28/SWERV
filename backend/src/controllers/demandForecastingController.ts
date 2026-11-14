import type { RequestHandler } from 'express';
import { parseRequest } from '../utils/dispatchRequestValidation.js';
import { HttpError } from '../utils/httpError.js';
import { requestDemandForecast } from '../services/demandForecastingService.js';
import { demandForecastRequestSchema } from '../utils/demandForecastValidation.js';

export const demandForecastHandler: RequestHandler = async (req, res, next) => {
  try {
    const input = parseRequest(demandForecastRequestSchema, req.body);
    const forecast = await requestDemandForecast(input);
    res.json({
      success: true,
      message: 'Demand forecast generated from the synthetic model.',
      data: { forecast },
    });
  } catch (error) {
    if (error instanceof HttpError && [409, 502, 503].includes(error.status)) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

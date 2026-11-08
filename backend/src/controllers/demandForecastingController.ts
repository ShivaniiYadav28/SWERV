import type { RequestHandler } from 'express';
import { parseRequest } from '../utils/dispatchRequestValidation.js';
import { HttpError } from '../utils/httpError.js';
import {
  getDemandHistory,
  requestDemandForecast,
} from '../services/demandForecastingService.js';
import { demandForecastRequestSchema } from '../utils/demandForecastValidation.js';

export const demandHistoryHandler: RequestHandler = async (req, res) => {
  try {
    const mode = req.query.mode;
    if (mode !== 'real' && mode !== 'synthetic_demo') {
      res.status(400).json({ success: false, message: 'Select either real or synthetic_demo mode.' });
      return;
    }
    const history = await getDemandHistory(mode);
    res.json({
      success: true,
      message: history.message,
      data: { history },
    });
  } catch {
    res.status(503).json({
      success: false,
      message: 'Selected hourly demand history is currently unavailable.',
    });
  }
};

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

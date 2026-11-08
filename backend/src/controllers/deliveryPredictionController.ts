import type { RequestHandler } from 'express';
import { predictDispatchRequestDeliveryTime } from '../services/deliveryPredictionService.js';
import { HttpError } from '../utils/httpError.js';
import { parseDispatchRequestId } from '../utils/dispatchRequestValidation.js';

export const predictDeliveryTimeHandler: RequestHandler = async (req, res, next) => {
  try {
    const dispatchRequestId = parseDispatchRequestId(req.params.id);
    const prediction = await predictDispatchRequestDeliveryTime(dispatchRequestId);
    res.json({
      success: true,
      message: 'Delivery time prediction generated.',
      data: { prediction },
    });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 502 || error.status === 503)) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

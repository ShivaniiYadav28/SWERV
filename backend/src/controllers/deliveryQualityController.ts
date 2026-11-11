import type { RequestHandler } from 'express';
import { getDeliveryDataQualitySummary } from '../services/deliveryQualityService.js';

export const getDeliveryDataQualitySummaryHandler: RequestHandler = async (_req, res, next) => {
  try {
    const summary = await getDeliveryDataQualitySummary();
    res.json({
      success: true,
      message: 'Delivery data quality summary retrieved successfully.',
      data: summary,
    });
  } catch (error) {
    next(error);
  }
};

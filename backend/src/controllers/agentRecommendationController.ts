import type { RequestHandler } from 'express';
import { getAgentRecommendations } from '../services/agentRecommendationService.js';
import { parseDispatchRequestId } from '../utils/dispatchRequestValidation.js';

export const getAgentRecommendationsHandler: RequestHandler = async (req, res) => {
  const dispatchRequestId = parseDispatchRequestId(req.params.id);
  const result = await getAgentRecommendations(dispatchRequestId);
  res.json({
    success: true,
    message: result.message,
    data: {
      dispatchRequestId,
      recommendations: result.recommendations,
      rankingData: result.rankingData,
      predictionStatus: result.predictionStatus,
      modelVersion: result.modelVersion,
      trainingSource: result.trainingSource,
      notes: result.notes,
    },
  });
};

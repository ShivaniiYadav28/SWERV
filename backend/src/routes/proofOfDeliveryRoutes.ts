import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  getAgentPodImageHandler,
  getAgentPodStatusHandler,
  requestAgentPodOtpHandler,
  submitAgentPodHandler,
  uploadAgentPodEvidenceHandler,
  verifyAgentPodOtpHandler,
} from '../controllers/proofOfDeliveryController.js';
import { requireAgentAuth } from '../middleware/agentAuthMiddleware.js';

const router = Router();
const otpRequestLimit = rateLimit({ windowMs: 60 * 60 * 1_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const otpVerifyLimit = rateLimit({ windowMs: 15 * 60 * 1_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const photoUpload = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' });
const signatureUpload = express.raw({ type: 'image/png', limit: '1mb' });

router.use(requireAgentAuth);
router.get('/deliveries/:id/pod', getAgentPodStatusHandler);
router.post('/deliveries/:id/pod/photo', photoUpload, uploadAgentPodEvidenceHandler('photo'));
router.post('/deliveries/:id/pod/signature', signatureUpload, uploadAgentPodEvidenceHandler('signature'));
router.post('/deliveries/:id/pod/otp', otpRequestLimit, requestAgentPodOtpHandler);
router.post('/deliveries/:id/pod/otp/verify', otpVerifyLimit, verifyAgentPodOtpHandler);
router.post('/deliveries/:id/pod/submit', submitAgentPodHandler);
router.get('/deliveries/:id/pod/evidence/:kind', getAgentPodImageHandler);

export default router;

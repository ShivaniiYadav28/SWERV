import { Schema, model } from 'mongoose';

const storedFileSchema = new Schema({
  storageKey: { type: String, required: true },
  contentType: { type: String, required: true },
  fileName: { type: String, required: true, maxlength: 120 },
  storageProvider: { type: String, enum: ['local', 's3'] },
}, { _id: false });

const podDraftSchema = new Schema({
  dispatchRequestId: { type: Schema.Types.ObjectId, ref: 'DispatchRequest', required: true },
  agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },
  photo: { type: storedFileSchema, default: null },
  signature: { type: storedFileSchema, default: null },
  otpHash: { type: String, select: false, default: null },
  otpExpiresAt: { type: Date, default: null },
  otpLastSentAt: { type: Date, default: null },
  otpAttempts: { type: Number, default: 0, min: 0 },
  otpVerifiedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

podDraftSchema.index({ dispatchRequestId: 1, agentId: 1 }, { unique: true });

const proofOfDeliverySchema = new Schema({
  dispatchRequestId: { type: Schema.Types.ObjectId, ref: 'DispatchRequest', required: true, unique: true, immutable: true },
  agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true, immutable: true },
  photo: { type: storedFileSchema, required: true, immutable: true },
  signature: { type: storedFileSchema, required: true, immutable: true },
  otpVerified: { type: Boolean, required: true, immutable: true },
  otpVerifiedAt: { type: Date, required: true, immutable: true },
  locationStatus: { type: String, enum: ['captured', 'unavailable'], required: true, immutable: true },
  latitude: { type: Number, min: -90, max: 90, default: null, immutable: true },
  longitude: { type: Number, min: -180, max: 180, default: null, immutable: true },
  accuracyMeters: { type: Number, min: 0, default: null, immutable: true },
  locationUnavailableReason: { type: String, enum: ['permission_denied', 'unsupported', 'timeout', 'not_available'], default: null, immutable: true },
  deliveredAt: { type: Date, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

proofOfDeliverySchema.index({ createdAt: -1 });
proofOfDeliverySchema.index({ agentId: 1, createdAt: -1 });

export const ProofOfDeliveryDraft = model('ProofOfDeliveryDraft', podDraftSchema);
export const ProofOfDelivery = model('ProofOfDelivery', proofOfDeliverySchema);

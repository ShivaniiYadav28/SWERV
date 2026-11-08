import { Schema, model } from 'mongoose';

const deliveryTrackingSchema = new Schema(
  {
    dispatchRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'DispatchRequest',
      required: true,
    },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false },
);

deliveryTrackingSchema.index({ tokenHash: 1 }, { unique: true });
deliveryTrackingSchema.index({ dispatchRequestId: 1, createdAt: -1 });
deliveryTrackingSchema.index(
  { dispatchRequestId: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } },
);
deliveryTrackingSchema.index({ expiresAt: 1 });

export const DeliveryTracking = model('DeliveryTracking', deliveryTrackingSchema);

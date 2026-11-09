import { Schema, model } from 'mongoose';

const routeStopSchema = new Schema({
  dispatchRequestId: { type: Schema.Types.ObjectId, ref: 'DispatchRequest', required: true },
  stopType: { type: String, enum: ['pickup', 'delivery'], required: true },
}, { _id: false });

const routePlanSchema = new Schema({
  agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true, unique: true },
  dispatchRequestIds: [{ type: Schema.Types.ObjectId, ref: 'DispatchRequest', required: true }],
  stopSequence: { type: [routeStopSchema], required: true },
  appliedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  appliedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true, versionKey: false });

export const RoutePlan = model('RoutePlan', routePlanSchema);

export async function ensureRoutePlanIndexes(): Promise<void> {
  await RoutePlan.init();
}

import { Schema, model } from 'mongoose';

const agentLocationSchema = new Schema(
  {
    agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    accuracy: { type: Number, min: 0, max: 100_000 },
    speed: { type: Number, min: 0, max: 1_000 },
    heading: { type: Number, min: 0, max: 360 },
    recordedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false },
);

agentLocationSchema.index({ agentId: 1, recordedAt: -1 });
agentLocationSchema.index({ receivedAt: -1 });

export const AgentLocation = model('AgentLocation', agentLocationSchema);

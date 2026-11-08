import { Schema, model } from 'mongoose';

export const agentEventTypes = [
  'agent_created',
  'agent_updated',
  'status_changed',
  'agent_archived',
  'agent_restored',
] as const;
export type AgentEventType = (typeof agentEventTypes)[number];

const agentActivitySchema = new Schema(
  {
    agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true, index: true },
    eventType: { type: String, enum: agentEventTypes, required: true },
    description: { type: String, required: true, maxlength: 240 },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    previousValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

agentActivitySchema.index({ agentId: 1, createdAt: -1 });

export const AgentActivity = model('AgentActivity', agentActivitySchema);

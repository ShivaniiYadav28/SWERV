import { Schema, model } from 'mongoose';

export const dispatchActivityTypes = [
  'request_created',
  'assignment_changed',
  'status_changed',
  'locations_changed',
] as const;
export type DispatchActivityType = (typeof dispatchActivityTypes)[number];
export const dispatchActivityActorTypes = ['user', 'agent'] as const;
export type DispatchActivityActorType = (typeof dispatchActivityActorTypes)[number];

const dispatchRequestActivitySchema = new Schema(
  {
    dispatchRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'DispatchRequest',
      required: true,
    },
    eventType: { type: String, enum: dispatchActivityTypes, required: true },
    description: { type: String, required: true, maxlength: 240 },
    // Keep performedBy as the legacy User reference for response compatibility.
    // Agent events use performedByAgent and identify their actor with actorType.
    actorType: { type: String, enum: dispatchActivityActorTypes, default: 'user', required: true },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    performedByAgent: { type: Schema.Types.ObjectId, ref: 'Agent', required: false },
    previousValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

dispatchRequestActivitySchema.pre('validate', function validateActor() {
  if (this.actorType === 'user' && !this.performedBy) {
    this.invalidate('performedBy', 'User activity requires a user actor.');
  }
  if (this.actorType === 'agent' && !this.performedByAgent) {
    this.invalidate('performedByAgent', 'Agent activity requires an agent actor.');
  }
});

dispatchRequestActivitySchema.index({ dispatchRequestId: 1, createdAt: -1 });

export const DispatchRequestActivity = model(
  'DispatchRequestActivity',
  dispatchRequestActivitySchema,
);

import { Schema, model } from 'mongoose';

export const agentCredentialTypes = ['device', 'browser'] as const;

const agentDeviceCredentialSchema = new Schema(
  {
    agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },
    credentialType: { type: String, enum: agentCredentialTypes, default: 'device', required: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

agentDeviceCredentialSchema.index({ agentId: 1, credentialType: 1, revokedAt: 1 });
agentDeviceCredentialSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AgentDeviceCredential = model(
  'AgentDeviceCredential',
  agentDeviceCredentialSchema,
);

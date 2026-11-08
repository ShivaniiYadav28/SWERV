import { Schema, model } from 'mongoose';

const authBootstrapSchema = new Schema(
  {
    _id: { type: String, default: 'initial-admin' },
    firstAdminAssigned: { type: Boolean, required: true, default: false },
    adminChangeVersion: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const AuthBootstrap = model('AuthBootstrap', authBootstrapSchema);

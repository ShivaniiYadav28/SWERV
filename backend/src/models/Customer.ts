import { Schema, model } from 'mongoose';

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      match: /^\S+@\S+\.\S+$/,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      minlength: 7,
      maxlength: 24,
      match: /^\+?[0-9().\s-]+$/,
    },
    identityKey: { type: String, required: true, unique: true, select: false },
    isActive: { type: Boolean, default: true, required: true },
  },
  { timestamps: true },
);

customerSchema.index({ name: 1 });
customerSchema.index({ email: 1 });
customerSchema.index({ phone: 1 });
customerSchema.index({ isActive: 1, createdAt: -1 });

export const Customer = model('Customer', customerSchema);

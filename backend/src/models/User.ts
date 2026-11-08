import bcrypt from 'bcryptjs';
import { Schema, model } from 'mongoose';

export const userRoles = ['admin', 'operator'] as const;
export type UserRole = (typeof userRoles)[number];

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    password: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: userRoles,
      default: 'operator',
      required: true,
    },
    isActive: { type: Boolean, default: true, required: true },
  },
  { timestamps: true, versionKey: false },
);

userSchema.pre('save', async function hashPassword() {
  if (this.isModified('password'))
    this.password = await bcrypt.hash(this.password, 12);
});

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const { password: _password, _id: _id, ...safeFields } = ret;
    return safeFields;
  },
});

export const User = model('User', userSchema);

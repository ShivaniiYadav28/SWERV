import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { AuthBootstrap } from '../models/AuthBootstrap.js';
import { User, type UserRole } from '../models/User.js';
import type { LoginInput, RegisterInput } from '../utils/authValidation.js';
import { createAccessToken } from '../utils/jwt.js';

export type SafeUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export function toSafeUser(user: ReturnType<typeof User.hydrate>): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role as UserRole,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function registerUser(input: RegisterInput): Promise<SafeUser> {
  const session = await mongoose.startSession();
  let safeUser: SafeUser | undefined;
  try {
    await session.withTransaction(async () => {
      // The bootstrap claim and user insert commit together, so only one request can create the first admin.
      const bootstrap = await AuthBootstrap.findOneAndUpdate(
        { _id: 'initial-admin', firstAdminAssigned: false },
        { $set: { firstAdminAssigned: true } },
        { returnDocument: 'after', session },
      );
      const role: UserRole = bootstrap ? 'admin' : 'operator';
      const [user] = await User.create(
        [
          {
            name: input.name,
            email: input.email,
            password: input.password,
            role,
          },
        ],
        { session },
      );
      safeUser = toSafeUser(user);
    });
  } finally {
    await session.endSession();
  }
  if (!safeUser)
    throw new Error(
      'Registration transaction completed without creating a user.',
    );
  return safeUser;
}

export async function authenticateUser(
  input: LoginInput,
): Promise<{ user: SafeUser; token: string } | null> {
  const user = await User.findOne({ email: input.email }).select('+password');
  if (!user || !user.isActive) return null;
  const passwordMatches = await bcrypt.compare(input.password, user.password);
  if (!passwordMatches) return null;
  return { user: toSafeUser(user), token: createAccessToken(user.id) };
}

export async function getActiveUserById(id: string): Promise<SafeUser | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  const user = await User.findOne({ _id: id, isActive: true });
  return user ? toSafeUser(user) : null;
}

export async function ensureAuthCollections(): Promise<void> {
  await Promise.all([User.init(), AuthBootstrap.init()]);
  await AuthBootstrap.updateOne(
    { _id: 'initial-admin' },
    { $setOnInsert: { firstAdminAssigned: false } },
    { upsert: true },
  );
}

import mongoose from 'mongoose';
import { AuthBootstrap } from '../models/AuthBootstrap.js';
import { User, type UserRole } from '../models/User.js';
import type { SafeUser } from './authService.js';
import { toSafeUser } from './authService.js';
import { HttpError } from '../utils/httpError.js';

type NewUser = { name: string; email: string; password: string; role: UserRole };

async function runTransaction<T>(work: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
  } finally {
    await session.endSession();
  }
  if (result === undefined) throw new Error('User management transaction did not complete.');
  return result;
}

async function serializeAdminChange(session: mongoose.ClientSession): Promise<void> {
  const result = await AuthBootstrap.updateOne(
    { _id: 'initial-admin' },
    { $inc: { adminChangeVersion: 1 } },
    { session },
  );
  if (!result.matchedCount) throw new Error('Administrator bootstrap record is missing.');
}

export async function listUsers(options: {
  page: number; limit: number; search?: string; role?: UserRole; status?: 'active' | 'inactive';
}) {
  const filter: Record<string, unknown> = {};
  if (options.role) filter.role = options.role;
  if (options.status) filter.isActive = options.status === 'active';
  if (options.search) {
    const escapedSearch = options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const search = new RegExp(escapedSearch, 'i');
    filter.$or = [{ name: search }, { email: search }];
  }

  const skip = (options.page - 1) * options.limit;
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(options.limit).lean(),
    User.countDocuments(filter),
  ]);
  return {
    users: users.map((user) => ({
      id: user._id.toString(), name: user.name, email: user.email, role: user.role,
      isActive: user.isActive, createdAt: user.createdAt, updatedAt: user.updatedAt,
    })),
    pagination: { page: options.page, limit: options.limit, total, pages: Math.ceil(total / options.limit) },
  };
}

export async function getUser(id: string): Promise<SafeUser> {
  const user = await User.findById(id);
  if (!user) throw new HttpError(404, 'User not found.');
  return toSafeUser(user);
}

export async function createManagedUser(input: NewUser): Promise<SafeUser> {
  const [user] = await User.create([input]);
  return toSafeUser(user);
}

export async function changeUserRole(id: string, role: UserRole): Promise<SafeUser> {
  return runTransaction(async (session) => {
    await serializeAdminChange(session);
    const user = await User.findById(id).session(session);
    if (!user) throw new HttpError(404, 'User not found.');
    if (user.role === role) return toSafeUser(user);

    if (user.isActive && user.role === 'admin' && role !== 'admin') {
      const otherActiveAdmins = await User.countDocuments({
        _id: { $ne: user._id }, role: 'admin', isActive: true,
      }).session(session);
      if (otherActiveAdmins === 0) throw new HttpError(409, 'The last active administrator cannot be demoted.');
    }

    user.role = role;
    await user.save({ session });
    return toSafeUser(user);
  });
}

export async function changeUserStatus(
  id: string, isActive: boolean, actingUserId: string,
): Promise<SafeUser> {
  return runTransaction(async (session) => {
    await serializeAdminChange(session);
    const user = await User.findById(id).session(session);
    if (!user) throw new HttpError(404, 'User not found.');
    if (!isActive && user.id === actingUserId) throw new HttpError(400, 'You cannot deactivate your own account.');
    if (user.isActive && !isActive && user.role === 'admin') {
      const otherActiveAdmins = await User.countDocuments({
        _id: { $ne: user._id }, role: 'admin', isActive: true,
      }).session(session);
      if (otherActiveAdmins === 0) throw new HttpError(409, 'The last active administrator cannot be deactivated.');
    }

    user.isActive = isActive;
    await user.save({ session });
    return toSafeUser(user);
  });
}

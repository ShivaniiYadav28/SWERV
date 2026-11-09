import mongoose from 'mongoose';
import { Agent } from '../models/Agent.js';
import { AgentAttendance } from '../models/AgentAttendance.js';
import { HttpError } from '../utils/httpError.js';
import type { AdminAgentAttendanceQuery, AgentAttendanceHistoryQuery } from '../utils/agentAttendanceValidation.js';

const istDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function attendanceDateInIndia(date: Date): string {
  const parts = Object.fromEntries(istDateFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function attendanceDateFilter(startDate?: string, endDate?: string) {
  if (startDate && endDate) return { $gte: startDate, $lte: endDate };
  if (startDate) return { $gte: startDate };
  if (endDate) return { $lte: endDate };
  return undefined;
}

function attendanceFilter(agentId: string, startDate?: string, endDate?: string) {
  const filter: Record<string, unknown> = { agentId: new mongoose.Types.ObjectId(agentId) };
  const dateFilter = attendanceDateFilter(startDate, endDate);
  if (dateFilter) filter.attendanceDate = dateFilter;
  return filter;
}

function attendanceDurationMinutes(checkInAt: Date, checkOutAt?: Date | null): number | null {
  if (!checkOutAt) return null;
  const duration = (checkOutAt.getTime() - checkInAt.getTime()) / 60_000;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
}

export async function checkInAgent(agentId: string, now = new Date()) {
  const attendanceDate = attendanceDateInIndia(now);
  if (await AgentAttendance.exists({ agentId, checkOutAt: null })) {
    throw new HttpError(409, 'Check out your open attendance before checking in again.');
  }

  try {
    return await AgentAttendance.create({ agentId, attendanceDate, checkInAt: now, checkOutAt: null });
  } catch (error) {
    if (isDuplicateKey(error)) {
      if (await AgentAttendance.exists({ agentId, checkOutAt: null })) {
        throw new HttpError(409, 'Check out your open attendance before checking in again.');
      }
      throw new HttpError(409, 'You have already checked in today.');
    }
    throw error;
  }
}

export async function checkOutAgent(agentId: string, now = new Date()) {
  const attendanceDate = attendanceDateInIndia(now);
  const updated = await AgentAttendance.findOneAndUpdate(
    { agentId, checkOutAt: null },
    { $set: { checkOutAt: now } },
    { returnDocument: 'after', runValidators: true, sort: { checkInAt: -1 } },
  );
  if (updated) return updated;

  const existing = await AgentAttendance.exists({ agentId, attendanceDate });
  if (!existing) throw new HttpError(409, 'Check in before checking out.');
  throw new HttpError(409, 'You have already checked out today.');
}

async function attendanceSummary(filter: Record<string, unknown>) {
  const [summary] = await AgentAttendance.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        totalRecords: { $sum: 1 },
        completedCheckouts: { $sum: { $cond: [{ $ne: ['$checkOutAt', null] }, 1, 0] } },
        openRecords: { $sum: { $cond: [{ $eq: ['$checkOutAt', null] }, 1, 0] } },
        totalDurationMilliseconds: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$checkOutAt', null] }, { $gte: ['$checkOutAt', '$checkInAt'] }] },
              { $subtract: ['$checkOutAt', '$checkInAt'] },
              0,
            ],
          },
        },
      },
    },
  ]);
  return {
    totalRecords: summary?.totalRecords ?? 0,
    completedCheckouts: summary?.completedCheckouts ?? 0,
    openRecords: summary?.openRecords ?? 0,
    totalDurationMinutes: (summary?.totalDurationMilliseconds ?? 0) / 60_000,
  };
}

export async function getAgentAttendanceHistory(agentId: string, query: AgentAttendanceHistoryQuery) {
  const filter = attendanceFilter(agentId, query.startDate, query.endDate);
  const skip = (query.page - 1) * query.limit;
  const [records, totalRecords, summary] = await Promise.all([
    AgentAttendance.find(filter).sort({ attendanceDate: -1 }).skip(skip).limit(query.limit).lean(),
    AgentAttendance.countDocuments(filter),
    attendanceSummary(filter),
  ]);
  const [openAttendance, todayRecord] = await Promise.all([
    AgentAttendance.findOne({ agentId, checkOutAt: null }).sort({ checkInAt: -1 }).lean(),
    AgentAttendance.findOne({ agentId, attendanceDate: attendanceDateInIndia(new Date()) }).lean(),
  ]);
  const todayAttendance = openAttendance ?? todayRecord;
  return {
    records: records.map((record) => ({ ...record, durationMinutes: attendanceDurationMinutes(record.checkInAt, record.checkOutAt) })),
    todayAttendance: todayAttendance
      ? { ...todayAttendance, durationMinutes: attendanceDurationMinutes(todayAttendance.checkInAt, todayAttendance.checkOutAt) }
      : null,
    summary,
    pagination: { page: query.page, limit: query.limit, total: totalRecords, pages: Math.ceil(totalRecords / query.limit) },
  };
}

export async function getAdminAgentAttendance(query: AdminAgentAttendanceQuery) {
  const filter: Record<string, unknown> = {};
  const dateFilter = attendanceDateFilter(query.startDate, query.endDate);
  if (dateFilter) filter.attendanceDate = dateFilter;
  if (query.search) {
    const escapedSearch = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchingAgents = await Agent.find({
      $or: [{ name: new RegExp(escapedSearch, 'i') }, { email: new RegExp(escapedSearch, 'i') }],
    }).select('_id').lean();
    const matchingAgentIds = matchingAgents.map((agent) => agent._id);
    filter.agentId = query.agentId
      ? matchingAgentIds.some((agentId) => agentId.toString() === query.agentId)
        ? new mongoose.Types.ObjectId(query.agentId)
        : { $in: [] }
      : { $in: matchingAgentIds };
  } else if (query.agentId) {
    filter.agentId = new mongoose.Types.ObjectId(query.agentId);
  }

  const skip = (query.page - 1) * query.limit;
  const [records, totalRecords, summary] = await Promise.all([
    AgentAttendance.find(filter)
      .sort({ attendanceDate: -1, checkInAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .lean(),
    AgentAttendance.countDocuments(filter),
    attendanceSummary(filter),
  ]);
  const agents = await Agent.find({ _id: { $in: records.map((record) => record.agentId) } })
    .select('name email agentCode')
    .lean();
  const agentsById = new Map(agents.map((agent) => [agent._id.toString(), agent]));

  return {
    records: records.map((record) => ({
      ...record,
      agent: agentsById.get(record.agentId.toString()) ?? null,
      agentId: record.agentId.toString(),
      durationMinutes: attendanceDurationMinutes(record.checkInAt, record.checkOutAt),
      status: record.checkOutAt ? 'checked_out' : 'checked_in',
    })),
    summary,
    pagination: { page: query.page, limit: query.limit, total: totalRecords, pages: Math.ceil(totalRecords / query.limit) },
  };
}

export async function ensureAgentAttendanceCollections(): Promise<void> {
  await AgentAttendance.init();
}

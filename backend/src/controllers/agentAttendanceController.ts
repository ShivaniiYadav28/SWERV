import type { RequestHandler } from 'express';
import {
  checkInAgent,
  checkOutAgent,
  getAdminAgentAttendance,
  getAgentAttendanceHistory,
} from '../services/agentAttendanceService.js';
import { HttpError } from '../utils/httpError.js';
import {
  adminAgentAttendanceQuerySchema,
  agentAttendanceHistoryQuerySchema,
  parseAttendanceRequest,
} from '../utils/agentAttendanceValidation.js';

function authenticatedAgentId(req: Parameters<RequestHandler>[0]): string {
  if (!req.agentId) throw new HttpError(401, 'Agent authentication required.');
  return req.agentId;
}

export const agentCheckInHandler: RequestHandler = async (req, res) => {
  const attendance = await checkInAgent(authenticatedAgentId(req));
  res.status(201).json({ success: true, message: 'Checked in successfully.', data: { attendance } });
};

export const agentCheckOutHandler: RequestHandler = async (req, res) => {
  const attendance = await checkOutAgent(authenticatedAgentId(req));
  res.json({ success: true, message: 'Checked out successfully.', data: { attendance } });
};

export const myAgentAttendanceHandler: RequestHandler = async (req, res) => {
  const query = parseAttendanceRequest(agentAttendanceHistoryQuerySchema, req.query);
  const result = await getAgentAttendanceHistory(authenticatedAgentId(req), query);
  res.json({ success: true, message: 'Attendance history retrieved.', data: result });
};

export const adminAgentAttendanceHandler: RequestHandler = async (req, res) => {
  const query = parseAttendanceRequest(adminAgentAttendanceQuerySchema, req.query);
  const result = await getAdminAgentAttendance(query);
  res.json({ success: true, message: 'Agent attendance retrieved.', data: result });
};

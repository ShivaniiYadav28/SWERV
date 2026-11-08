import type { RequestHandler } from 'express';
import {
  changeUserRole, changeUserStatus, createManagedUser, getUser, listUsers,
} from '../services/adminUserService.js';
import { HttpError } from '../utils/httpError.js';
import {
  createUserSchema, parseUserId, parseUserRequest, userListQuerySchema,
  userRoleSchema, userStatusSchema,
} from '../utils/adminUserValidation.js';

function actingUserId(req: Parameters<RequestHandler>[0]): string {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return req.user.id;
}

export const listUsersHandler: RequestHandler = async (req, res) => {
  const query = parseUserRequest(userListQuerySchema, req.query);
  const result = await listUsers(query);
  res.json({ success: true, message: 'Users retrieved successfully.', data: result });
};

export const getUserHandler: RequestHandler = async (req, res) => {
  const user = await getUser(parseUserId(req.params.id));
  res.json({ success: true, message: 'User retrieved successfully.', data: { user } });
};

export const createUserHandler: RequestHandler = async (req, res) => {
  const input = parseUserRequest(createUserSchema, req.body);
  const user = await createManagedUser(input);
  res.status(201).json({ success: true, message: 'User created successfully.', data: { user } });
};

export const changeUserRoleHandler: RequestHandler = async (req, res) => {
  const id = parseUserId(req.params.id);
  const { role } = parseUserRequest(userRoleSchema, req.body);
  const user = await changeUserRole(id, role);
  res.json({ success: true, message: 'User role updated successfully.', data: { user } });
};

export const changeUserStatusHandler: RequestHandler = async (req, res) => {
  const id = parseUserId(req.params.id);
  const { isActive } = parseUserRequest(userStatusSchema, req.body);
  const user = await changeUserStatus(id, isActive, actingUserId(req));
  res.json({ success: true, message: 'User status updated successfully.', data: { user } });
};

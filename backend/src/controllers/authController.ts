import type { CookieOptions, RequestHandler, Response } from 'express';
import { authenticateUser, registerUser } from '../services/authService.js';
import { loginSchema, registerSchema } from '../utils/authValidation.js';
import {
  AUTH_COOKIE_NAME,
  createAccessToken,
  getTokenMaxAge,
} from '../utils/jwt.js';

function authCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

function setAuthCookie(res: Response, token: string) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...authCookieOptions(),
    maxAge: getTokenMaxAge(),
  });
}

export const register: RequestHandler = async (req, res) => {
  const result = registerSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      success: false,
      message: 'Please check the registration details.',
      errors: result.error.flatten().fieldErrors,
    });
    return;
  }

  const user = await registerUser(result.data);
  setAuthCookie(res, createAccessToken(user.id));
  res
    .status(201)
    .json({ success: true, message: 'Account created.', data: { user } });
};

export const login: RequestHandler = async (req, res) => {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      success: false,
      message: 'Email and password are required.',
      errors: result.error.flatten().fieldErrors,
    });
    return;
  }

  const session = await authenticateUser(result.data);
  if (!session) {
    res
      .status(401)
      .json({ success: false, message: 'Invalid email or password.' });
    return;
  }

  setAuthCookie(res, session.token);
  res
    .status(200)
    .json({
      success: true,
      message: 'Signed in.',
      data: { user: session.user },
    });
};

export const logout: RequestHandler = (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions());
  res.status(200).json({ success: true, message: 'Signed out.', data: null });
};

export const currentUser: RequestHandler = (req, res) => {
  res
    .status(200)
    .json({
      success: true,
      message: 'Current user.',
      data: { user: req.user },
    });
};

export const adminDashboard: RequestHandler = (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Administrator access granted.',
    data: { user: req.user },
  });
};

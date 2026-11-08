import jwt, { type SignOptions } from 'jsonwebtoken';

export const AUTH_COOKIE_NAME = 'swerv_access';
const DEFAULT_EXPIRY = '1d';

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET must be set to a random value of at least 32 characters.',
    );
  }
  return secret;
}

export function getJwtExpiry(): string {
  const expiry = process.env.JWT_EXPIRES_IN?.trim() || DEFAULT_EXPIRY;
  if (!/^[1-9]\d*[smhd]$/.test(expiry))
    throw new Error(
      'JWT_EXPIRES_IN must be a positive duration in seconds, minutes, hours, or days (for example 1d).',
    );
  return expiry;
}

export function getTokenMaxAge(): number {
  const expiry = getJwtExpiry();
  const amount = Number.parseInt(expiry.slice(0, -1), 10);
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * multipliers[expiry.slice(-1)];
}

export function createAccessToken(userId: string): string {
  return jwt.sign({}, getJwtSecret(), {
    subject: userId,
    expiresIn: getJwtExpiry() as SignOptions['expiresIn'],
  });
}

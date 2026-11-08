import jwt, { type SignOptions } from 'jsonwebtoken';

export const AGENT_AUTH_COOKIE_NAME = 'swerv_agent_access';
const DEFAULT_EXPIRY = '1d';

export function getAgentJwtSecret(): string {
  const secret = process.env.AGENT_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('AGENT_JWT_SECRET must be set to a random value of at least 32 characters.');
  }
  return secret;
}

export function getAgentJwtExpiry(): string {
  const expiry = process.env.AGENT_JWT_EXPIRES_IN?.trim() || DEFAULT_EXPIRY;
  if (!/^[1-9]\d*[smhd]$/.test(expiry)) {
    throw new Error('AGENT_JWT_EXPIRES_IN must be a positive duration (for example 1d).');
  }
  return expiry;
}

export function getAgentTokenMaxAge(): number {
  const expiry = getAgentJwtExpiry();
  const amount = Number.parseInt(expiry.slice(0, -1), 10);
  const multipliers: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[expiry.slice(-1)];
}

export function createAgentAccessToken(agentId: string): string {
  return jwt.sign({ type: 'agent' }, getAgentJwtSecret(), {
    subject: agentId,
    expiresIn: getAgentJwtExpiry() as SignOptions['expiresIn'],
    issuer: 'swerv-agent-auth',
    audience: 'swerv-agent',
  });
}

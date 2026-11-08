import { afterEach, describe, expect, it } from 'vitest';
import { getAgentJwtExpiry, getAgentJwtSecret } from '../src/utils/agentJwt.js';
import { getJwtExpiry } from '../src/utils/jwt.js';

const originalAgentSecret = process.env.AGENT_JWT_SECRET;
const originalAgentExpiry = process.env.AGENT_JWT_EXPIRES_IN;
const originalUserExpiry = process.env.JWT_EXPIRES_IN;
const originalUserSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (originalAgentSecret === undefined) delete process.env.AGENT_JWT_SECRET;
  else process.env.AGENT_JWT_SECRET = originalAgentSecret;
  if (originalAgentExpiry === undefined) delete process.env.AGENT_JWT_EXPIRES_IN;
  else process.env.AGENT_JWT_EXPIRES_IN = originalAgentExpiry;
  if (originalUserExpiry === undefined) delete process.env.JWT_EXPIRES_IN;
  else process.env.JWT_EXPIRES_IN = originalUserExpiry;
  if (originalUserSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalUserSecret;
});

describe('agent JWT configuration', () => {
  it('requires a separate agent secret of at least 32 non-whitespace characters', () => {
    process.env.JWT_SECRET = 'this-user-secret-is-long-enough-but-is-not-the-agent-secret';
    delete process.env.AGENT_JWT_SECRET;
    expect(() => getAgentJwtSecret()).toThrow(/AGENT_JWT_SECRET/);

    process.env.AGENT_JWT_SECRET = `  ${'a'.repeat(31)}  `;
    expect(() => getAgentJwtSecret()).toThrow(/AGENT_JWT_SECRET/);
  });

  it('trims surrounding whitespace without changing the secret value', () => {
    const secret = 'a-random-agent-secret-with-more-than-32-characters';
    process.env.AGENT_JWT_SECRET = `  ${secret}  `;
    expect(getAgentJwtSecret()).toBe(secret);
  });

  it('uses agent and user expiry settings independently', () => {
    process.env.AGENT_JWT_EXPIRES_IN = '2h';
    process.env.JWT_EXPIRES_IN = '1d';
    expect(getAgentJwtExpiry()).toBe('2h');
    expect(getJwtExpiry()).toBe('1d');

    process.env.AGENT_JWT_EXPIRES_IN = 'not-a-duration';
    expect(() => getAgentJwtExpiry()).toThrow(/AGENT_JWT_EXPIRES_IN/);
  });
});

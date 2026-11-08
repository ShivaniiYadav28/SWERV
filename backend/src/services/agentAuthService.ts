import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { Agent } from '../models/Agent.js';
import { HttpError } from '../utils/httpError.js';
import { createAgentAccessToken, getAgentJwtSecret } from '../utils/agentJwt.js';

export type SafeAgent = {
  id: string;
  name: string;
  email: string;
  agentCode: string;
  status: string;
  isActive: boolean;
};

function toSafeAgent(agent: { id: string; name: string; email: string; agentCode: string; status: string; isActive: boolean }): SafeAgent {
  return { id: agent.id, name: agent.name, email: agent.email, agentCode: agent.agentCode, status: agent.status, isActive: agent.isActive };
}

export async function authenticateAgent(email: string, password: string) {
  const agent = await Agent.findOne({ email }).select('+passwordHash');
  if (!agent || !agent.isActive || !agent.passwordHash) return null;
  if (!(await bcrypt.compare(password, agent.passwordHash))) return null;
  return { agent: toSafeAgent(agent), token: createAgentAccessToken(agent.id) };
}

export async function setAgentPassword(agentId: string, password: string) {
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await Agent.updateOne({ _id: agentId }, { $set: { passwordHash } });
  if (!result.matchedCount) throw new HttpError(404, 'Agent not found.');
}

export async function getActiveAgentById(agentId: string): Promise<SafeAgent | null> {
  if (!/^[a-f\d]{24}$/i.test(agentId)) return null;
  const agent = await Agent.findOne({ _id: agentId, isActive: true })
    .select('_id name email agentCode status isActive').lean();
  if (!agent) return null;
  return { id: agent._id.toString(), name: agent.name, email: agent.email, agentCode: agent.agentCode, status: agent.status, isActive: agent.isActive };
}

export function verifyAgentToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, getAgentJwtSecret(), { issuer: 'swerv-agent-auth', audience: 'swerv-agent' });
    if (typeof decoded === 'string') return null;
    const payload = decoded as JwtPayload & { type?: string };
    return payload.type === 'agent' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

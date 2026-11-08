import type { SafeUser } from '../services/authService.js';
import type { SafeAgent } from '../services/agentAuthService.js';

declare global {
  namespace Express {
    interface Request {
      user?: SafeUser;
      agentId?: string;
      agent?: SafeAgent;
    }
  }
}

export {};

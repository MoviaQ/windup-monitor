import type { AuthenticatedSession } from './auth/session.js';
import type { AgentAuthContext } from './agents/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present after the `requireAuth` pre-handler succeeds. */
    auth?: AuthenticatedSession;
    /** Present after the `requireAgent` pre-handler succeeds. */
    agentAuth?: AgentAuthContext;
  }
}

export {};

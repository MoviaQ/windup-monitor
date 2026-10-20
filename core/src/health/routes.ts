import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Liveness: process is up (no dependencies touched).
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: verifies the database is reachable.
  app.get('/health/ready', async (req, reply) => {
    try {
      await ctx.db.$queryRaw`SELECT 1`;
      return { status: 'ready', checks: { database: 'ok' } };
    } catch (error) {
      req.log.error({ err: error }, 'readiness check failed');
      reply.code(503);
      return { status: 'unavailable', checks: { database: 'error' } };
    }
  });
}

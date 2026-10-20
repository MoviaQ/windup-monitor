import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireCsrf, requireOrigin } from '../http/guards.js';
import { createPairingToken, revokeAgent } from '../agents/service.js';
import { METRICS_DEFAULT_LIMIT, getAgentMetrics, listAgentSummaries } from '../metrics/service.js';

const pairingSchema = z.object({
  label: z.string().min(1).max(128).optional(),
});

interface IdParams {
  id: string;
}

export function registerAgentUiRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx;
  const authed = [requireAuth(db, config)];
  const mutating = [requireAuth(db, config), requireOrigin(config), requireCsrf()];

  app.get('/agents', { preHandler: authed }, async () => ({
    agents: await listAgentSummaries(db, config, new Date(ctx.now())),
  }));

  app.get<{ Params: IdParams; Querystring: { limit?: string } }>(
    '/agents/:id/metrics',
    { preHandler: authed },
    async (req) => {
      const rawLimit = req.query.limit;
      const parsed = rawLimit === undefined ? METRICS_DEFAULT_LIMIT : Number.parseInt(rawLimit, 10);
      const limit = Number.isFinite(parsed) ? parsed : METRICS_DEFAULT_LIMIT;
      const samples = await getAgentMetrics(db, req.params.id, limit);
      if (!samples) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
      return { samples };
    },
  );

  app.post('/agents/pairing-tokens', { preHandler: mutating }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    const body = parseBody(pairingSchema, req.body ?? {});
    const result = await createPairingToken(db, config, auth.user.id, body.label);
    reply.code(201);
    return { token: result.token, expiresAt: result.expiresAt.toISOString() };
  });

  app.post<{ Params: IdParams }>('/agents/:id/revoke', { preHandler: mutating }, async (req) => {
    const auth = req.auth;
    if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    await revokeAgent(db, req.params.id, auth.user.id);
    return { id: req.params.id, status: 'revoked' };
  });
}

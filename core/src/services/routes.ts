import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireCsrf, requireOrigin } from '../http/guards.js';
import {
  SERVICES_DEFAULT_LIMIT,
  createService,
  deleteService,
  getServiceHistory,
  listDiscovered,
  listServices,
  updateService,
} from '../services/service.js';
import { MAX_EXPECTED_STATUSES } from '../services/validation.js';

const statusList = z.array(z.number().int().min(100).max(599)).min(1).max(MAX_EXPECTED_STATUSES);

const createSchema = z.object({
  agentId: z.string().min(1).max(64),
  candidateId: z.string().min(1).max(64),
  name: z.string().min(1).max(128).optional(),
  path: z.string().min(1).max(512).optional(),
  expectedStatuses: statusList.optional(),
  intervalSeconds: z.number().int().min(15).max(3600).optional(),
  timeoutSeconds: z.number().int().min(1).max(10).optional(),
  failureThreshold: z.number().int().min(1).max(100).optional(),
  successThreshold: z.number().int().min(1).max(100).optional(),
}).strict();

const updateSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    path: z.string().min(1).max(512).optional(),
    expectedStatuses: statusList.optional(),
    intervalSeconds: z.number().int().min(15).max(3600).optional(),
    timeoutSeconds: z.number().int().min(1).max(10).optional(),
    failureThreshold: z.number().int().min(1).max(100).optional(),
    successThreshold: z.number().int().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

interface IdParams {
  id: string;
}

export function registerServiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx;
  const authed = [requireAuth(db, config)];
  const mutating = [requireAuth(db, config), requireOrigin(config), requireCsrf()];

  app.get('/services', { preHandler: authed }, async () => ({
    services: await listServices(db, config, new Date(ctx.now())),
  }));

  app.get('/services/discovered', { preHandler: authed }, async () => ({
    candidates: await listDiscovered(db, config, new Date(ctx.now())),
  }));

  app.post('/services', { preHandler: mutating }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    const body = parseBody(createSchema, req.body);
    const service = await createService(db, config, auth.user.id, body, new Date(ctx.now()));
    reply.code(201);
    return { service };
  });

  app.patch<{ Params: IdParams }>('/services/:id', { preHandler: mutating }, async (req) => {
    const auth = req.auth;
    if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    const body = parseBody(updateSchema, req.body ?? {});
    const service = await updateService(db, config, auth.user.id, req.params.id, body, new Date(ctx.now()));
    return { service };
  });

  app.delete<{ Params: IdParams }>('/services/:id', { preHandler: mutating }, async (req, reply) => {
    const auth = req.auth;
    if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    await deleteService(db, auth.user.id, req.params.id);
    reply.code(204);
    return null;
  });

  app.get<{ Params: IdParams; Querystring: { limit?: string } }>(
    '/services/:id/history',
    { preHandler: authed },
    async (req) => {
      const rawLimit = req.query.limit;
      const parsed = rawLimit === undefined ? SERVICES_DEFAULT_LIMIT : Number.parseInt(rawLimit, 10);
      const limit = Number.isFinite(parsed) ? parsed : SERVICES_DEFAULT_LIMIT;
      const history = await getServiceHistory(db, req.params.id, limit);
      if (!history) throw new ApiError(404, 'NOT_FOUND', 'Service not found');
      return history;
    },
  );
}

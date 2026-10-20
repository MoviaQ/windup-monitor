/**
 * Public-endpoint routes.
 *
 * CRUD authenticated session + CSRF (same guards as services):
 *   GET    /api/v1/services/:serviceId/public-endpoints -> { endpoints: [...] }
 *   POST   /api/v1/services/:serviceId/public-endpoints -> 201 { endpoint }
 *   PATCH  /api/v1/public-endpoints/:id                 -> { endpoint }
 *   DELETE /api/v1/public-endpoints/:id                 -> 204
 *
 * PENDING SHARED INTEGRATION: the coordinator wires this module into
 * `src/app.ts` with `registerPublicEndpointRoutes(api, ctx)` and runs the
 * DDL in `./migration.sql`. This file intentionally touches no shared file.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireCsrf, requireOrigin } from '../http/guards.js';
import {
  MAX_LABEL_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} from './url-policy.js';
import {
  createEndpoint,
  deleteEndpoint,
  ensureTables,
  getEndpointHistory,
  getEndpointOrThrow,
  listEndpoints,
  updateEndpoint,
  type PublicEndpointRow,
} from './store.js';

const labelSchema = z.string().max(MAX_LABEL_LENGTH).optional();

const createSchema = z.object({
  url: z.string().min(1).max(2048 + 8),
  label: labelSchema,
  intervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS).optional(),
  timeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
}).strict();

const updateSchema = z.object({
  url: z.string().min(1).max(2048 + 8).optional(),
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS).optional(),
  timeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
}).strict();

interface ServiceParams {
  serviceId: string;
}
interface EndpointParams {
  id: string;
}

export interface PublicEndpointDto {
  id: string;
  serviceId: string;
  label: string | null;
  url: string;
  enabled: boolean;
  intervalSeconds: number;
  timeoutSeconds: number;
  status: PublicEndpointRow['status'];
  lastCheckedAt: string | null;
  statusCode: number | null;
  latencyMs: number | null;
  errorCode: string | null;
}

export function toDto(row: PublicEndpointRow): PublicEndpointDto {
  return {
    id: row.id,
    serviceId: row.serviceId,
    label: row.label,
    url: row.url,
    enabled: row.enabled,
    intervalSeconds: row.intervalSeconds,
    timeoutSeconds: row.timeoutSeconds,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt,
    statusCode: row.statusCode,
    latencyMs: row.latencyMs,
    errorCode: row.errorCode,
  };
}

export function registerPublicEndpointRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx;
  const authed = [requireAuth(db, config)];
  const mutating = [requireAuth(db, config), requireOrigin(config), requireCsrf()];
  const raw = db as unknown as {
    $queryRawUnsafe(query: string, ...params: unknown[]): Promise<unknown[]>;
    $executeRawUnsafe(query: string, ...params: unknown[]): Promise<number>;
  };
  void ensureTables(raw).catch((error: unknown) => {
    if (ctx.config.nodeEnv !== 'test') {
      console.error('[public-endpoints] ensureTables failed', error);
    }
  });

  app.get<{ Params: ServiceParams }>(
    '/services/:serviceId/public-endpoints',
    { preHandler: authed },
    async (req) => {
      const endpoints = await listEndpoints(raw, req.params.serviceId);
      return { endpoints: endpoints.map(toDto) };
    },
  );

  app.post<{ Params: ServiceParams }>(
    '/services/:serviceId/public-endpoints',
    { preHandler: mutating },
    async (req, reply) => {
      const auth = req.auth;
      if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
      const body = parseBody(createSchema, req.body);
      try {
        const endpoint = await createEndpoint(raw, () => randomUUID(), {
          serviceId: req.params.serviceId,
          url: body.url,
          label: body.label,
          intervalSeconds: body.intervalSeconds,
          timeoutSeconds: body.timeoutSeconds,
        });
        reply.code(201);
        return { endpoint: toDto(endpoint) };
      } catch (error) {
        if (error instanceof Error && error.name === 'UrlPolicyError') {
          throw new ApiError(400, 'INVALID_BODY', error.message);
        }
        throw error;
      }
    },
  );

  app.get<{ Params: EndpointParams; Querystring: { limit?: string } }>(
    '/public-endpoints/:id/history',
    { preHandler: authed },
    async (req) => {
      const rawLimit = req.query.limit;
      const parsed = rawLimit === undefined ? 100 : Number.parseInt(rawLimit, 10);
      const limit = Number.isFinite(parsed) ? parsed : 100;
      const results = await getEndpointHistory(raw, req.params.id, limit);
      return { results };
    },
  );

  app.patch<{ Params: EndpointParams }>(
    '/public-endpoints/:id',
    { preHandler: mutating },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
      const body = parseBody(updateSchema, req.body ?? {});
      try {
        const endpoint = await updateEndpoint(raw, req.params.id, {
          url: body.url,
          label: body.label,
          enabled: body.enabled,
          intervalSeconds: body.intervalSeconds,
          timeoutSeconds: body.timeoutSeconds,
        });
        return { endpoint: toDto(endpoint) };
      } catch (error) {
        if (error instanceof Error && error.name === 'UrlPolicyError') {
          throw new ApiError(400, 'INVALID_BODY', error.message);
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: EndpointParams }>(
    '/public-endpoints/:id',
    { preHandler: mutating },
    async (req, reply) => {
      const auth = req.auth;
      if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
      await deleteEndpoint(raw, req.params.id);
      reply.code(204);
      return null;
    },
  );

  app.get<{ Params: EndpointParams }>(
    '/public-endpoints/:id',
    { preHandler: authed },
    async (req) => {
      const endpoint = await getEndpointOrThrow(raw, req.params.id);
      return { endpoint: toDto(endpoint) };
    },
  );
}

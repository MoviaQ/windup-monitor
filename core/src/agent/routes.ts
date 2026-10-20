import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { requireAgent, requireProtocolVersion } from '../http/guards.js';
import { enroll, rotate, rotateConfirm } from '../agents/service.js';
import { ingestHeartbeat, parseHeartbeat } from './ingest.js';
import { agentServiceChecks } from '../services/service.js';

const AGENT_BODY_LIMIT = 256 * 1024; // docs/agent-protocol.md §3

const enrollSchema = z.object({
  enroll_token: z.string().min(1).max(1024),
  hostname: z.string().min(1).max(253),
  agent_version: z.string().max(64).optional(),
  protocol_version: z.number().int().min(0).max(1000),
  capabilities: z.array(z.string().min(1).max(32)).max(32).optional(),
});

const rotateSchema = z.object({
  rotation_id: z.string().min(1).max(128),
  new_credential: z.string().min(1).max(512),
});

const rotateConfirmSchema = z.object({
  rotation_id: z.string().min(1).max(128),
});

export function registerAgentProtocolRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx;

  app.post(
    '/agent/enroll',
    { bodyLimit: AGENT_BODY_LIMIT, preHandler: requireProtocolVersion() },
    async (req, reply) => {
      const limit = ctx.enrollLimiter.check(req.ip);
      if (!limit.allowed) {
        reply.header('retry-after', String(limit.retryAfterSeconds));
        throw new ApiError(429, 'RATE_LIMITED', 'Too many enrollment attempts');
      }
      const body = parseBody(enrollSchema, req.body);
      if (body.protocol_version !== 1) {
        throw new ApiError(426, 'UPGRADE_REQUIRED', 'Unsupported agent protocol version');
      }
      const result = await enroll(db, config, {
        enrollToken: body.enroll_token,
        hostname: body.hostname,
        agentVersion: body.agent_version,
        protocolVersion: body.protocol_version,
        capabilities: body.capabilities ?? [],
      });
      reply.code(201);
      return {
        agent_id: result.agentId,
        credential: result.credential,
        heartbeat_interval_s: result.heartbeatIntervalS,
        config_version: result.configVersion,
      };
    },
  );

  app.post(
    '/agent/heartbeat',
    { bodyLimit: AGENT_BODY_LIMIT, preHandler: [requireProtocolVersion(), requireAgent(db)] },
    async (req) => {
      const auth = req.agentAuth;
      if (!auth) throw new ApiError(401, 'BAD_CREDENTIAL', 'Missing agent credentials');
      const body = parseHeartbeat(req.body);
      const outcome = await ingestHeartbeat(db, config, auth, body);
      if (outcome.kind === 'stale') {
        throw new ApiError(409, 'STALE_SEQ', 'Sequence is not newer than the last stored sample');
      }
      return {
        server_time: outcome.serverTime.toISOString(),
        config_version: outcome.configVersion,
        config_changed: outcome.configChanged,
        pending_commands: [],
        full_inventory: false,
        ...(outcome.configChanged ? { code: 'CONFIG_STALE' } : {}),
      };
    },
  );

  app.get('/agent/config', { preHandler: [requireProtocolVersion(), requireAgent(db)] }, async (req) => {
    const auth = req.agentAuth;
    if (!auth) throw new ApiError(401, 'BAD_CREDENTIAL', 'Missing agent credentials');
    return {
      // Per-agent revision: creating/editing/deleting a service bumps it, so
      // the agent refreshes its check set through the canonical CONFIG_STALE
      // path instead of guessing.
      config_version: auth.agent.configVersion,
      heartbeat_interval_s: config.heartbeatIntervalS,
      queue_ttl_s: 300,
      lease_s: 120,
      result_ttl_s: 600,
      // Additive v1: only this agent's own approved checks. An older agent
      // ignores the key; a new agent treats it as the complete set.
      service_checks: await agentServiceChecks(db, auth.agent),
    };
  });

  app.post(
    '/agent/rotate',
    { bodyLimit: AGENT_BODY_LIMIT, preHandler: [requireProtocolVersion(), requireAgent(db)] },
    async (req) => {
      const auth = req.agentAuth;
      if (!auth) throw new ApiError(401, 'BAD_CREDENTIAL', 'Missing agent credentials');
      const body = parseBody(rotateSchema, req.body);
      const result = await rotate(db, config, auth, body.rotation_id, body.new_credential);
      return { overlap_until: result.overlapUntil.toISOString(), rotation_id: result.rotationId };
    },
  );

  app.post(
    '/agent/rotate_confirm',
    { bodyLimit: AGENT_BODY_LIMIT, preHandler: [requireProtocolVersion(), requireAgent(db)] },
    async (req) => {
      const auth = req.agentAuth;
      if (!auth) throw new ApiError(401, 'BAD_CREDENTIAL', 'Missing agent credentials');
      const body = parseBody(rotateConfirmSchema, req.body);
      await rotateConfirm(db, auth, body.rotation_id);
      return { ok: true };
    },
  );
}

import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { Prisma, type Db } from '../db/client.js';
import { authorizeLockedAgent, type AgentAuthContext } from '../agents/service.js';
import { ApiError } from '../lib/errors.js';
import {
  DISCOVERY_NAME_SOURCES,
  MAX_CANDIDATES,
  MAX_EXPECTED_STATUSES,
  MAX_NAME_LENGTH,
  MAX_RESULTS,
  SERVICE_CONFIDENCES,
  SERVICE_SOURCES,
  SERVICE_TRANSPORTS,
  isSafeName,
  isSafePath,
} from '../services/validation.js';
import { applyServicePayload } from '../services/ingest.js';

const diskSchema = z.object({
  mount: z.string().min(1).max(512),
  total_b: z.number().int().nonnegative(),
  used_b: z.number().int().nonnegative(),
  avail_b: z.number().int().nonnegative().optional(),
});

const metricsSchema = z.object({
  cpu: z.object({
    usage_pct: z.number().min(0).max(100),
    load1: z.number().optional(),
  }),
  mem: z.object({
    total_b: z.number().int().nonnegative(),
    used_b: z.number().int().nonnegative(),
    avail_b: z.number().int().nonnegative().optional(),
  }),
  disk: z.array(diskSchema).max(64),
  net: z.object({
    rx_b: z.number().int().nonnegative(),
    tx_b: z.number().int().nonnegative(),
    rx_bps: z.number().optional(),
    tx_bps: z.number().optional(),
  }),
  uptime_s: z.number().int().nonnegative(),
});

const candidateSchema = z.object({
  candidate_id: z.string().min(1).max(64),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  // Generic discovery: a bounded lowercase label, not a closed hardcoded
  // catalog. `unknown` stays valid and does NOT imply unmonitorable.
  kind: z.string().min(1).max(32).regex(/^[a-z0-9][a-z0-9-]*$/),
  port: z.number().int().min(1).max(65535),
  transport: z.enum(SERVICE_TRANSPORTS),
  source: z.enum(SERVICE_SOURCES),
  confidence: z.enum(SERVICE_CONFIDENCES),
  // Additive generic fields (older agents omit them; ingest infers legacy).
  monitorable: z.boolean().optional(),
  name_source: z.enum(DISCOVERY_NAME_SOURCES).nullable().optional(),
  process_started_at: z.string().min(1).max(64).nullable().optional(),
  suggested_path: z.string().max(512).nullable().optional(),
  suggested_statuses: z.array(z.number().int().min(100).max(599)).max(MAX_EXPECTED_STATUSES).optional(),
});

const discoverySchema = z.object({
  observed_at: z.string().min(1),
  complete: z.boolean(),
  candidates: z.array(candidateSchema).max(MAX_CANDIDATES),
});

const MAX_PROCESS_METRICS = 64;

const processMetricSchema = z.object({
  candidate_id: z.string().min(1).max(64),
  process_started_at: z.string().min(1).max(64),
  observed_at: z.string().min(1).max(64),
  cpu_percent: z.number().finite().nonnegative().max(1_000_000).nullable(),
  memory_rss_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
});

const serviceResultSchema = z.object({
  check_id: z.string().uuid(),
  config_revision: z.number().int().nonnegative(),
  observed_at: z.string().min(1),
  ok: z.boolean(),
  status_code: z.number().int().min(100).max(599).nullable(),
  latency_ms: z.number().finite().min(0).max(3_600_000),
  error_code: z.string().max(64).nullable(),
});

const heartbeatSchema = z.object({
  seq: z.number().int().nonnegative(),
  observed_at: z.string().min(1),
  config_version: z.number().int().nonnegative(),
  // Additive caps upgrade: existing agents re-announce their capabilities in
  // every heartbeat so persisted caps can grow without re-enrollment.
  capabilities: z.array(z.enum(['metrics', 'docker', 'restart', 'service_discovery', 'http_checks', 'tcp_checks'])).max(32).optional(),
  metrics: metricsSchema,
  // S1 accepts and ignores these (no docker/commands yet) — unknown fields in
  // general are stripped, matching forward-compatible protocol rules.
  docker: z.unknown().optional(),
  command_results: z.array(z.unknown()).optional(),
  // Services iteration (additive v1 fields). Old Core versions rejected these
  // keys; the new Core validates and applies them atomically with `seq`.
  service_discovery: discoverySchema.optional(),
  service_results: z.array(serviceResultSchema).max(MAX_RESULTS).optional(),
  // Additive per-process CPU/RSS block. Presence is optional so older agents
  // keep working; a malformed block is still INVALID_BODY (strict shape).
  service_process_metrics: z.array(processMetricSchema).max(MAX_PROCESS_METRICS).optional(),
});

export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

export type IngestOutcome =
  | { kind: 'stale' }
  | { kind: 'ok'; serverTime: Date; configVersion: number; configChanged: boolean };

/** Parses and shape-validates a heartbeat body; throws INVALID_BODY (400). */
export function parseHeartbeat(raw: unknown): HeartbeatInput {
  const parsed = heartbeatSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'INVALID_BODY', 'Heartbeat body failed schema validation');
  }
  const body = parsed.data;

  const observedAt = new Date(body.observed_at);
  if (Number.isNaN(observedAt.getTime())) {
    throw new ApiError(400, 'INVALID_BODY', 'observed_at is not a valid timestamp');
  }
  if (body.metrics.mem.used_b > body.metrics.mem.total_b) {
    throw new ApiError(400, 'INVALID_BODY', 'memory used_b exceeds total_b');
  }
  for (const disk of body.metrics.disk) {
    if (disk.used_b > disk.total_b) {
      throw new ApiError(400, 'INVALID_BODY', `disk used_b exceeds total_b for mount ${disk.mount}`);
    }
  }
  if (body.service_discovery) {
    if (Number.isNaN(new Date(body.service_discovery.observed_at).getTime())) {
      throw new ApiError(400, 'INVALID_BODY', 'service_discovery.observed_at is not a valid timestamp');
    }
    const seen = new Set<string>();
    for (const candidate of body.service_discovery.candidates) {
      if (seen.has(candidate.candidate_id)) {
        throw new ApiError(400, 'INVALID_BODY', 'duplicate service candidate_id');
      }
      seen.add(candidate.candidate_id);
      if (!isSafeName(candidate.name)) {
        throw new ApiError(400, 'INVALID_BODY', 'service candidate name is not a safe label');
      }
      if (candidate.process_started_at &&
          Number.isNaN(new Date(candidate.process_started_at).getTime())) {
        throw new ApiError(400, 'INVALID_BODY', 'process_started_at is not a valid timestamp');
      }
      if (candidate.suggested_path != null && !isSafePath(candidate.suggested_path)) {
        throw new ApiError(400, 'INVALID_BODY', 'suggested_path must be a relative path');
      }
    }
  }
  for (const result of body.service_results ?? []) {
    if (Number.isNaN(new Date(result.observed_at).getTime())) {
      throw new ApiError(400, 'INVALID_BODY', 'service result observed_at is not a valid timestamp');
    }
  }
  const seenMetrics = new Set<string>();
  for (const metric of body.service_process_metrics ?? []) {
    if (seenMetrics.has(metric.candidate_id)) {
      throw new ApiError(400, 'INVALID_BODY', 'duplicate service_process_metrics candidate_id');
    }
    seenMetrics.add(metric.candidate_id);
    if (Number.isNaN(new Date(metric.process_started_at).getTime())) {
      throw new ApiError(400, 'INVALID_BODY', 'process_started_at is not a valid timestamp');
    }
    if (Number.isNaN(new Date(metric.observed_at).getTime())) {
      throw new ApiError(400, 'INVALID_BODY', 'process metric observed_at is not a valid timestamp');
    }
  }
  return body;
}

/**
 * Persists one heartbeat batch under a transaction holding a row
 * lock on the agent. `seq` must be strictly greater than the stored `last_seq`;
 * stale or duplicate batches are rejected without writing (no overwrite of
 * newer data, restart-safe because `last_seq` is persisted).
 *
 * The additive service payload is applied in the same transaction, so a
 * retried envelope can never duplicate results or discovery state.
 */
export async function ingestHeartbeat(
  db: Db,
  config: AppConfig,
  auth: AgentAuthContext,
  body: HeartbeatInput,
): Promise<IngestOutcome> {
  const observedAt = new Date(body.observed_at);
  const now = new Date();
  // Reject future service evidence before any write, including discovery's
  // ordering watermark. Small host clock skew is tolerated, never measured.
  const futureLimit = now.getTime() + 30_000;
  const serviceTimes = [
    ...(body.service_discovery ? [body.service_discovery.observed_at,
      ...body.service_discovery.candidates.flatMap(c => c.process_started_at ? [c.process_started_at] : [])] : []),
    ...(body.service_results ?? []).map(r => r.observed_at),
    ...(body.service_process_metrics ?? []).map(m => m.observed_at),
  ];
  if (serviceTimes.some(time => new Date(time).getTime() > futureLimit)) {
    throw new ApiError(400, 'INVALID_BODY', 'Service evidence cannot be in the future');
  }
  const late = now.getTime() - observedAt.getTime() > config.lateSampleSeconds * 1000;
  const seq = BigInt(body.seq);

  return db.$transaction(
    async (tx) => {
      const { agent } = await authorizeLockedAgent(tx, auth);
      const lastSeq = agent.lastSeq;
      if (seq <= lastSeq) return { kind: 'stale' } as const;

      await tx.metricSample.createMany({
        data: [
          {
            id: `${agent.id}:${seq}`,
            agentId: agent.id,
            seq,
            observedAt,
            receivedAt: now,
            late,
            cpuPct: body.metrics.cpu.usage_pct,
            load1: body.metrics.cpu.load1 ?? null,
            memUsedB: BigInt(body.metrics.mem.used_b),
            memTotalB: BigInt(body.metrics.mem.total_b),
            uptimeS: BigInt(body.metrics.uptime_s),
            netRxB: BigInt(body.metrics.net.rx_b),
            netTxB: BigInt(body.metrics.net.tx_b),
          },
        ],
        skipDuplicates: true,
      });

      if (body.metrics.disk.length > 0) {
        await tx.diskSample.createMany({
          data: body.metrics.disk.map((disk) => ({
            id: `${agent.id}:${seq}:${disk.mount}`,
            agentId: agent.id,
            seq,
            mount: disk.mount,
            totalB: BigInt(disk.total_b),
            usedB: BigInt(disk.used_b),
            receivedAt: now,
          })),
          skipDuplicates: true,
        });
      }

      await applyServicePayload(tx, agent, body, seq, now);

      const capsUpgrade = body.capabilities
        ? body.capabilities.filter((capability) =>
            ['metrics', 'docker', 'restart', 'service_discovery', 'http_checks', 'tcp_checks'].includes(capability))
        : null;

      // Wire-v2 evidence implies transport support even if the agent did not
      // announce the capability string. Only a v2 candidate sends
      // `monitorable`/`name_source`; pre-v2 agents never do, so an old agent
      // still never receives a TCP check it would misread as HTTP.
      const discoveryV2 = body.service_discovery?.candidates.some(
        (candidate) => candidate.monitorable !== undefined || candidate.name_source !== undefined,
      ) ?? false;
      const inferredCaps = discoveryV2
        ? [...new Set([...(capsUpgrade ?? agent.capabilities), 'tcp_checks'])]
        : null;

      await tx.agent.update({
        where: { id: agent.id },
        data: {
          lastSeq: seq,
          lastSeenAt: now,
          status: 'online',
          ...((inferredCaps ?? capsUpgrade) ? { capabilities: (inferredCaps ?? capsUpgrade) as string[] } : {}),
        },
      });

      return {
        kind: 'ok',
        serverTime: now,
        configVersion: agent.configVersion,
        configChanged: body.config_version !== agent.configVersion,
      } as const;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      // Body and batches are bounded (256 KB, <=64 candidates/results/
      // process metrics). Discovery/process writes are batched, so 15 s
      // tolerates a slow disk while still failing a genuinely stuck write.
      maxWait: 5_000,
      timeout: 15_000,
    },
  );
}

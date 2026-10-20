import { Prisma } from '../generated/prisma/client.js';
import type { Agent } from '../db/client.js';
import { appendAudit } from '../db/audit.js';
import { newServiceResultId, newServiceIncidentId } from '../lib/ids.js';
import type { HeartbeatInput } from '../agent/ingest.js';
import { AGENT_ACTOR } from '../agents/service.js';
import { fromStoredNameSource, inferMonitorable, toDbNameSource } from './validation.js';

type Tx = Prisma.TransactionClient;

/**
 * Applies the additive service payload of one heartbeat inside the same
 * transaction (and under the same agent row lock) as metrics ingest.
 *
 * Ordering/dedup rules:
 *  - discovery snapshots are accepted only when newer than the last accepted
 *    snapshot; an older one never overwrites newer candidates;
 *  - results are immutable history rows, deduped by (agent, check, observed_at);
 *  - a result is applied only when the authenticated agent owns the check and
 *    the revision matches exactly. Stale/unknown revisions are discarded and
 *    audited, never mixed into current status.
 */
export async function applyServicePayload(
  tx: Tx,
  agent: Agent,
  body: HeartbeatInput,
  seq: bigint,
  now: Date,
): Promise<void> {
  await applyDiscovery(tx, agent, body.service_discovery, now);
  await applyProcessMetrics(tx, agent, body.service_process_metrics ?? [], now);
  await applyResults(tx, agent, body.service_results ?? [], seq, now);
}

type DiscoveryInput = NonNullable<HeartbeatInput['service_discovery']>;
type ResultInput = NonNullable<HeartbeatInput['service_results']>[number];
type ProcessMetricInput = NonNullable<HeartbeatInput['service_process_metrics']>[number];

type ExistingCandidate = {
  candidateId: string;
  name: string;
  kind: string;
  port: number;
  transport: string;
  source: string;
  confidence: string;
  monitorable: boolean;
  nameSource: string | null;
  processStartedAt: Date | null;
  suggestedPath: string | null;
  suggestedStatuses: number[];
  available: boolean;
  completeSnapshot: boolean;
};

const sameTime = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

function sameStatuses(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameCandidate(
  existing: ExistingCandidate,
  candidate: DiscoveryInput['candidates'][number],
  processStartedAt: Date | null,
  complete: boolean,
): boolean {
  return (
    existing.name === candidate.name &&
    existing.kind === candidate.kind &&
    existing.port === candidate.port &&
    existing.transport === candidate.transport &&
    existing.source === candidate.source &&
    existing.confidence === candidate.confidence &&
    existing.monitorable === inferMonitorable(candidate) &&
    fromStoredNameSource(existing.nameSource) === (candidate.name_source ?? null) &&
    sameTime(existing.processStartedAt, processStartedAt) &&
    existing.suggestedPath === (candidate.suggested_path ?? null) &&
    sameStatuses(existing.suggestedStatuses, candidate.suggested_statuses ?? []) &&
    existing.available &&
    existing.completeSnapshot === complete
  );
}

/** One batch upsert for all candidates (bounded by MAX_CANDIDATES = 64). */
async function upsertCandidates(
  tx: Tx,
  agentId: string,
  discovery: DiscoveryInput,
  observedAt: Date,
  now: Date,
): Promise<void> {
  if (discovery.candidates.length === 0) return;
  const rows = discovery.candidates.map((candidate) => {
    const processStartedAt = candidate.process_started_at
      ? new Date(candidate.process_started_at)
      : null;
    return Prisma.sql`(
      ${agentId}, ${candidate.candidate_id}, ${candidate.name}, ${candidate.kind},
      ${candidate.port}, ${candidate.transport}, ${candidate.source}, ${candidate.confidence},
      ${inferMonitorable(candidate)}, ${toDbNameSource(candidate.name_source)}::"DiscoveryNameSource",
      ${processStartedAt}, ${candidate.suggested_path ?? null},
      ${candidate.suggested_statuses ?? []}::int[], true,
      ${now}, ${now}, ${observedAt}, ${discovery.complete}
    )`;
  });
  await tx.$executeRaw`
    INSERT INTO "discovered_services" (
      "agent_id", "candidate_id", "name", "kind", "port", "transport", "source",
      "confidence", "monitorable", "name_source", "process_started_at",
      "suggested_path", "suggested_statuses",
      "available", "first_seen_at", "last_seen_at", "snapshot_observed_at",
      "complete_snapshot"
    )
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("agent_id", "candidate_id") DO UPDATE SET
      "name" = EXCLUDED."name",
      "kind" = EXCLUDED."kind",
      "port" = EXCLUDED."port",
      "transport" = EXCLUDED."transport",
      "source" = EXCLUDED."source",
      "confidence" = EXCLUDED."confidence",
      "monitorable" = EXCLUDED."monitorable",
      "name_source" = EXCLUDED."name_source",
      "process_started_at" = EXCLUDED."process_started_at",
      "suggested_path" = EXCLUDED."suggested_path",
      "suggested_statuses" = EXCLUDED."suggested_statuses",
      "available" = true,
      "last_seen_at" = EXCLUDED."last_seen_at",
      "snapshot_observed_at" = EXCLUDED."snapshot_observed_at",
      "complete_snapshot" = EXCLUDED."complete_snapshot"
  `;
}

/** One batch update of runtime evidence on already monitored services.
 *
 * A changed owner-process start time is a real restart: continuity is reset
 * to `unknown` (never carried across the restart) and `last_restart_at` is
 * stamped so the UI can tell "restart detected" apart from the first healthy
 * observation after a fresh start. `null` on either side is missing evidence,
 * not a restart.
 */
async function updateServiceProcessStarts(
  tx: Tx,
  agentId: string,
  starts: Map<string, Date | null>,
  now: Date,
): Promise<void> {
  if (starts.size === 0) return;
  const services = await tx.service.findMany({
    where: { agentId, candidateId: { in: [...starts.keys()] } },
    select: { candidateId: true, processStartedAt: true, enabled: true },
  });
  const changed = services.flatMap((service) => {
    const next = starts.get(service.candidateId) ?? null;
    if (sameTime(service.processStartedAt, next)) return [];
    const restarted =
      service.processStartedAt !== null &&
      next !== null &&
      service.processStartedAt.getTime() !== next.getTime();
    return [{ service, next, restarted }];
  });
  if (changed.length === 0) return;
  const rows = changed.map(({ service, next, restarted }) =>
    Prisma.sql`(${service.candidateId}, ${next}::timestamptz, ${restarted}::boolean)`,
  );
  await tx.$executeRaw`
    UPDATE "services" AS s
    SET "process_started_at" = v."started",
        "last_restart_at" = CASE WHEN v."restarted" THEN ${now}::timestamptz ELSE s."last_restart_at" END,
        "status" = CASE WHEN v."restarted" AND s."enabled" THEN 'unknown'::"ServiceStatus" ELSE s."status" END,
        "up_since" = CASE WHEN v."restarted" THEN NULL ELSE s."up_since" END,
        "consecutive_failures" = CASE WHEN v."restarted" THEN 0 ELSE s."consecutive_failures" END,
        "consecutive_successes" = CASE WHEN v."restarted" THEN 0 ELSE s."consecutive_successes" END,
        "last_checked_at" = CASE WHEN v."restarted" THEN NULL ELSE s."last_checked_at" END,
        "last_status_code" = CASE WHEN v."restarted" THEN NULL ELSE s."last_status_code" END,
        "last_error_code" = CASE WHEN v."restarted" THEN NULL ELSE s."last_error_code" END,
        "last_latency_ms" = CASE WHEN v."restarted" THEN NULL ELSE s."last_latency_ms" END,
        "updated_at" = CASE WHEN v."restarted" THEN ${now}::timestamptz ELSE s."updated_at" END
    FROM (VALUES ${Prisma.join(rows)}) AS v("candidate_id", "started", "restarted")
    WHERE s."agent_id" = ${agentId} AND s."candidate_id" = v."candidate_id"
  `;
}

async function applyDiscovery(
  tx: Tx,
  agent: Agent,
  discovery: DiscoveryInput | undefined,
  now: Date,
): Promise<void> {
  if (!discovery) return;
  const observedAt = new Date(discovery.observed_at);
  if (agent.lastDiscoveryAt && observedAt.getTime() <= agent.lastDiscoveryAt.getTime()) {
    // Older (or duplicate) snapshot: keep the newer candidate state.
    return;
  }

  const existingRows = await tx.discoveredService.findMany({
    where: { agentId: agent.id },
    select: {
      candidateId: true,
      name: true,
      kind: true,
      port: true,
      transport: true,
      source: true,
      confidence: true,
      monitorable: true,
      nameSource: true,
      processStartedAt: true,
      suggestedPath: true,
      suggestedStatuses: true,
      available: true,
      completeSnapshot: true,
    },
  });
  const existing = new Map(existingRows.map((row) => [row.candidateId, row]));

  let changed = existingRows.length !== discovery.candidates.length;
  const starts = new Map<string, Date | null>();
  for (const candidate of discovery.candidates) {
    const started = candidate.process_started_at
      ? new Date(candidate.process_started_at)
      : null;
    starts.set(candidate.candidate_id, started);
    const previous = existing.get(candidate.candidate_id);
    if (!previous || !sameCandidate(previous, candidate, started, discovery.complete)) {
      changed = true;
    }
  }

  if (!changed) {
    // Identical periodic snapshot: keep ordering without 2×N writes.
    await tx.agent.update({
      where: { id: agent.id },
      data: { lastDiscoveryAt: observedAt },
    });
    return;
  }

  await upsertCandidates(tx, agent.id, discovery, observedAt, now);
  await updateServiceProcessStarts(tx, agent.id, starts, now);

  // A complete snapshot proves which candidates still exist. An incomplete
  // snapshot never marks anything unavailable.
  if (discovery.complete) {
    const seen = discovery.candidates.map((candidate) => candidate.candidate_id);
    await tx.discoveredService.updateMany({
      where: {
        agentId: agent.id,
        candidateId: { notIn: seen },
        available: true,
      },
      data: { available: false },
    });
  }

  await tx.agent.update({
    where: { id: agent.id },
    data: { lastDiscoveryAt: observedAt },
  });
}

async function applyProcessMetrics(
  tx: Tx,
  agent: Agent,
  metrics: ProcessMetricInput[],
  now: Date,
): Promise<void> {
  if (metrics.length === 0) return;
  const ids = metrics.map((metric) => metric.candidate_id);
  const [candidates, existing] = await Promise.all([
    tx.discoveredService.findMany({
      where: { agentId: agent.id, candidateId: { in: ids } },
      select: { candidateId: true, available: true, processStartedAt: true },
    }),
    tx.serviceProcessMetric.findMany({
      where: { agentId: agent.id, candidateId: { in: ids } },
      select: { candidateId: true, observedAt: true },
    }),
  ]);
  const candidateById = new Map(candidates.map((row) => [row.candidateId, row]));
  const existingAt = new Map(existing.map((row) => [row.candidateId, row.observedAt]));

  // Scoped, exact-identity observations only; anything else is ignored per
  // entry and never fails the whole heartbeat.
  const rows = metrics.flatMap((metric) => {
    const candidate = candidateById.get(metric.candidate_id);
    if (!candidate || !candidate.available) return [];
    if (!candidate.processStartedAt) return [];
    const processStartedAt = new Date(metric.process_started_at);
    if (processStartedAt.getTime() !== candidate.processStartedAt.getTime()) return [];
    const observedAt = new Date(metric.observed_at);
    const previous = existingAt.get(metric.candidate_id);
    if (previous && previous.getTime() >= observedAt.getTime()) return [];
    return [Prisma.sql`(
      ${agent.id}, ${metric.candidate_id}, ${processStartedAt}, ${observedAt}, ${now},
      ${metric.cpu_percent ?? null}, ${metric.memory_rss_bytes == null ? null : BigInt(metric.memory_rss_bytes)}
    )`];
  });
  if (rows.length === 0) return;

  await tx.$executeRaw`
    INSERT INTO "service_process_metrics" (
      "agent_id", "candidate_id", "process_started_at", "observed_at", "received_at",
      "cpu_percent", "memory_rss_bytes"
    )
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("agent_id", "candidate_id") DO UPDATE SET
      "process_started_at" = EXCLUDED."process_started_at",
      "observed_at" = EXCLUDED."observed_at",
      "received_at" = EXCLUDED."received_at",
      "cpu_percent" = EXCLUDED."cpu_percent",
      "memory_rss_bytes" = EXCLUDED."memory_rss_bytes"
    WHERE "service_process_metrics"."observed_at" < EXCLUDED."observed_at"
  `;
}

async function applyResults(
  tx: Tx,
  agent: Agent,
  results: ResultInput[],
  seq: bigint,
  now: Date,
): Promise<void> {
  const ordered = [...results].sort(
    (a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime(),
  );

  for (const result of ordered) {
    const service = await tx.service.findUnique({ where: { checkId: result.check_id } });
    if (!service || service.agentId !== agent.id) {
      await auditDiscard(tx, agent.id, result, 'UNKNOWN_CHECK');
      continue;
    }
    if (service.configRevision !== result.config_revision) {
      await auditDiscard(tx, agent.id, result, 'STALE_CONFIG_REVISION');
      continue;
    }
    if (!service.enabled) {
      await auditDiscard(tx, agent.id, result, 'CHECK_DISABLED');
      continue;
    }

    const observedAt = new Date(result.observed_at);
    const duplicate = await tx.serviceResult.findUnique({
      where: {
        agentId_checkId_observedAt: {
          agentId: agent.id,
          checkId: result.check_id,
          observedAt,
        },
      },
      select: { id: true },
    });
    if (duplicate) continue;

    await tx.serviceResult.create({
      data: {
        id: newServiceResultId(),
        agentId: agent.id,
        serviceId: service.id,
        checkId: result.check_id,
        configRevision: result.config_revision,
        agentSeq: seq,
        observedAt,
        receivedAt: now,
        ok: result.ok,
        statusCode: result.status_code ?? null,
        latencyMs: result.latency_ms,
        errorCode: result.error_code ?? null,
      },
    });

    // Late-but-new observations are stored, but never roll the current
    // status backwards.
    if (service.lastCheckedAt && observedAt.getTime() <= service.lastCheckedAt.getTime()) {
      continue;
    }

    await applyStatus(tx, service, result, observedAt, now);
  }
}

type ServiceRow = Awaited<ReturnType<Tx['service']['findUnique']>>;

async function applyStatus(
  tx: Tx,
  service: NonNullable<ServiceRow>,
  result: ResultInput,
  observedAt: Date,
  now: Date,
): Promise<void> {
  const maxGapSeconds = service.intervalSeconds * 2;
  const gapSeconds = service.lastCheckedAt
    ? (observedAt.getTime() - service.lastCheckedAt.getTime()) / 1000
    : null;
  const gapReset = gapSeconds !== null && gapSeconds > maxGapSeconds;

  let failures = gapReset ? 0 : service.consecutiveFailures;
  let successes = gapReset ? 0 : service.consecutiveSuccesses;
  let status = gapReset ? 'unknown' : service.status;
  let upSince = gapReset ? null : service.upSince;

  if (result.ok) {
    if (successes === 0) upSince = observedAt;
    successes += 1;
    failures = 0;
    if (status !== 'up' && successes >= service.successThreshold) {
      status = 'up';
      await tx.serviceIncident.updateMany({
        where: { serviceId: service.id, resolvedAt: null },
        data: { resolvedAt: observedAt },
      });
    }
  } else {
    successes = 0;
    upSince = null;
    failures += 1;
    if (status !== 'down' && failures >= service.failureThreshold) {
      status = 'down';
      upSince = null;
      await openIncident(tx, service.id, observedAt);
    }
  }

  await tx.service.update({
    where: { id: service.id },
    data: {
      status,
      consecutiveFailures: failures,
      consecutiveSuccesses: successes,
      upSince,
      lastCheckedAt: observedAt,
      lastStatusCode: result.status_code ?? null,
      lastLatencyMs: result.latency_ms,
      lastErrorCode: result.error_code ?? null,
      updatedAt: now,
    },
  });
}

async function openIncident(tx: Tx, serviceId: string, openedAt: Date): Promise<void> {
  const open = await tx.serviceIncident.findFirst({
    where: { serviceId, resolvedAt: null },
    select: { id: true },
  });
  if (open) return;
  try {
    await tx.serviceIncident.create({
      data: {
        id: newServiceIncidentId(),
        serviceId,
        openedAt,
        reason: 'HTTP_CHECK_FAILED',
      },
    });
  } catch (error) {
    // Partial unique index: a concurrent writer already opened it.
    if ((error as { code?: string }).code !== 'P2002') throw error;
  }
}

async function auditDiscard(
  tx: Tx,
  agentId: string,
  result: ResultInput,
  reason: string,
): Promise<void> {
  await appendAudit(tx, {
    actor: AGENT_ACTOR,
    action: 'service.result_discarded',
    target: result.check_id,
    detail: {
      agentId,
      checkId: result.check_id,
      configRevision: result.config_revision,
      reason,
    },
  });
}

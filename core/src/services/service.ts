import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { Agent, Service } from '../generated/prisma/client.js';
import { appendAudit } from '../db/audit.js';
import { ApiError } from '../lib/errors.js';
import { newServiceId } from '../lib/ids.js';
import { lockAgent } from '../agents/service.js';
import { computeStatus, type AgentStatus } from '../agents/status.js';
import { computeAvailability, type Availability } from './availability.js';
import {
  AVAILABILITY_WINDOW_MS,
  MAX_EXPECTED_STATUSES,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  assertSafeName,
  assertSafePath,
  assertSchedule,
  fromStoredNameSource,
  normalizeStatuses,
  statusesEqual,
} from './validation.js';

export const SERVICES_DEFAULT_LIMIT = 100;
export const SERVICES_MAX_LIMIT = 500;
const INCIDENTS_MAX_LIMIT = 200;
/** Process CPU/RSS older than this is not presented as current. */
const PROCESS_METRICS_MAX_AGE_MS = 45_000;
/** Upper bound for one service's availability scan (24 h at 15 s). */
const AVAILABILITY_SAMPLE_CAP = 6_000;

export type ServiceStatusValue = 'unknown' | 'up' | 'down' | 'paused' | 'degraded';

export interface ServiceSummaryDto {
  id: string;
  agentId: string;
  agentHostname: string;
  /** Derived agent liveness, so the UI can explain an `unknown` service. */
  agentStatus: AgentStatus;
  name: string;
  candidateId: string;
  port: number;
  /** `http` (legacy) or `tcp` (generic listener, no HTTP semantics). */
  transport: string;
  path: string;
  expectedStatuses: number[];
  intervalSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
  enabled: boolean;
  status: ServiceStatusValue;
  lastCheckedAt: string | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  upSince: string | null;
  /** Set only when an owner-process restart was observed; distinct from upSince. */
  lastRestartAt: string | null;
  processStartedAt: string | null;
  /** CPU of the proven owner process (percent of one core, may exceed 100). */
  processCpuPercent: number | null;
  /** Resident set size of the proven owner process, in bytes. */
  processMemoryRssBytes: number | null;
  processMetricsAt: string | null;
  availabilityPercent: number | null;
  observedSeconds: number;
  unknownSeconds: number;
  configRevision: number;
}

export interface DiscoveredCandidateDto {
  agentId: string;
  agentHostname: string;
  candidateId: string;
  name: string;
  kind: string;
  port: number;
  transport: string;
  source: string;
  confidence: string;
  /** Explicit generic contract; `kind: "unknown"` never implies unmonitorable. */
  monitorable: boolean;
  /** Safe evidence label for the name, or null when the agent did not say. */
  nameSource: string | null;
  processStartedAt: string | null;
  suggestedPath: string | null;
  suggestedStatuses: number[];
  monitored: boolean;
  lastSeenAt: string;
  available: boolean;
  processCpuPercent: number | null;
  processMemoryRssBytes: number | null;
  processMetricsAt: string | null;
}

interface ProcessMetricView {
  processCpuPercent: number | null;
  processMemoryRssBytes: number | null;
  processMetricsAt: string | null;
}

interface ProcessMetricRow {
  candidateId: string;
  processStartedAt: Date;
  observedAt: Date;
  cpuPercent: number | null;
  memoryRssBytes: bigint | null;
}

const emptyProcessMetrics = (): ProcessMetricView => ({
  processCpuPercent: null,
  processMemoryRssBytes: null,
  processMetricsAt: null,
});

/**
 * Honest view of the latest process sample: null unless the agent is online,
 * the observation is fresh, and the stored process start still matches the
 * candidate's current identity. A stale row is never presented as current.
 */
function processMetricsView(
  row: ProcessMetricRow | undefined,
  processStartedAt: Date | null,
  agentStatus: AgentStatus,
  now: Date,
): ProcessMetricView {
  if (!row || !processStartedAt || agentStatus !== 'online') return emptyProcessMetrics();
  if (row.processStartedAt.getTime() !== processStartedAt.getTime()) return emptyProcessMetrics();
  if (now.getTime() - row.observedAt.getTime() > PROCESS_METRICS_MAX_AGE_MS) {
    return emptyProcessMetrics();
  }
  return {
    processCpuPercent: row.cpuPercent,
    processMemoryRssBytes: row.memoryRssBytes == null ? null : Number(row.memoryRssBytes),
    processMetricsAt: row.observedAt.toISOString(),
  };
}

/** The minimal agent shape status derivation needs. */
interface AgentLiveness {
  status: AgentStatus;
  lastSeenAt: Date | null;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/**
 * Status shown to the UI. A stored `up`/`down` is never presented as current
 * when the reporting agent is disconnected or the check is overdue: the
 * honest value is `unknown`. Incidents are intentionally left open in that
 * case — a missing observation is not evidence of recovery.
 */
export function computeServiceStatus(
  service: Pick<Service, 'enabled' | 'status' | 'lastCheckedAt' | 'intervalSeconds'> & {
    consecutiveFailures?: number;
  },
  agent: AgentLiveness,
  config: AppConfig,
  now: Date,
): ServiceStatusValue {
  if (!service.enabled) return 'paused';
  if (computeStatus(agent, config, now) !== 'online') return 'unknown';
  if (!service.lastCheckedAt) return 'unknown';
  const ageSeconds = (now.getTime() - service.lastCheckedAt.getTime()) / 1000;
  // Bounded overdue allowance: two intervals, never less than the agent
  // staleness window and never more than an hour.
  const overdueAfter = Math.min(
    Math.max(service.intervalSeconds * 2, config.agentStaleSeconds),
    7200,
  );
  if (ageSeconds > overdueAfter) return 'unknown';
  // The last completed probe failed but the failure threshold is not met yet:
  // never keep presenting a stale `up` as current. `degraded` says exactly
  // that — responsive historically, last probe failed, no confirmed incident.
  if (service.status === 'up' && (service.consecutiveFailures ?? 0) > 0) return 'degraded';
  return service.status;
}

/** Availability window start: current config horizon, capped to 24 h. */
export function availabilityWindowStart(service: Pick<Service, 'horizonAt'>, now: Date): Date {
  const dayAgo = new Date(now.getTime() - AVAILABILITY_WINDOW_MS);
  return service.horizonAt.getTime() > dayAgo.getTime() ? service.horizonAt : dayAgo;
}

function emptyAvailability(windowStart: Date, now: Date): Availability {
  return {
    percent: null,
    observedSeconds: 0,
    unknownSeconds: Math.max(0, (now.getTime() - windowStart.getTime()) / 1000),
  };
}

async function availabilityFor(
  db: Db,
  service: Service,
  agent: AgentLiveness,
  config: AppConfig,
  now: Date,
): Promise<Availability> {
  const status = computeServiceStatus(service, agent, config, now);
  const start = availabilityWindowStart(service, now);
  const end = now;
  if (status === 'paused' || end.getTime() <= start.getTime()) {
    return emptyAvailability(start, now);
  }
  const samples = await db.serviceResult.findMany({
    where: { serviceId: service.id, observedAt: { gte: start, lte: end } },
    select: { observedAt: true, ok: true },
    orderBy: { observedAt: 'asc' },
    take: AVAILABILITY_SAMPLE_CAP,
  });
  return computeAvailability(samples, start, end, service.intervalSeconds);
}

export function toSummary(
  service: Service,
  agentHostname: string,
  agentStatus: AgentStatus,
  status: ServiceStatusValue,
  availability: Availability,
  processMetrics: ProcessMetricView,
): ServiceSummaryDto {
  return {
    id: service.id,
    agentId: service.agentId,
    agentHostname,
    agentStatus,
    name: service.name,
    candidateId: service.candidateId,
    port: service.port,
    transport: service.transport,
    path: service.path,
    expectedStatuses: service.expectedStatuses,
    intervalSeconds: service.intervalSeconds,
    timeoutSeconds: service.timeoutSeconds,
    failureThreshold: service.failureThreshold,
    successThreshold: service.successThreshold,
    enabled: service.enabled,
    status,
    lastCheckedAt: iso(service.lastCheckedAt),
    lastStatusCode: service.lastStatusCode,
    lastLatencyMs: service.lastLatencyMs,
    lastErrorCode: service.lastErrorCode,
    consecutiveFailures: service.consecutiveFailures,
    upSince: iso(service.upSince),
    lastRestartAt: iso(service.lastRestartAt),
    processStartedAt: iso(service.processStartedAt),
    processCpuPercent: processMetrics.processCpuPercent,
    processMemoryRssBytes: processMetrics.processMemoryRssBytes,
    processMetricsAt: processMetrics.processMetricsAt,
    availabilityPercent: availability.percent,
    observedSeconds: availability.observedSeconds,
    unknownSeconds: availability.unknownSeconds,
    configRevision: service.configRevision,
  };
}

/** Bounded list of services with derived status and measured availability. */
export async function listServices(
  db: Db,
  config: AppConfig,
  now: Date = new Date(),
): Promise<ServiceSummaryDto[]> {
  const services = await db.service.findMany({
    orderBy: [{ agentId: 'asc' }, { createdAt: 'asc' }],
  });
  if (services.length === 0) return [];

  const agents = await db.agent.findMany({
    where: { id: { in: [...new Set(services.map((service) => service.agentId))] } },
  });
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const metricRows = await db.serviceProcessMetric.findMany({
    where: { agentId: { in: [...agentById.keys()] } },
  });
  const metricsByKey = new Map(
    metricRows.map((row) => [`${row.agentId}:${row.candidateId}`, row]),
  );

  return Promise.all(
    services.map(async (service) => {
      const agent = agentById.get(service.agentId);
      const liveness: AgentLiveness = agent
        ? { status: agent.status, lastSeenAt: agent.lastSeenAt }
        : { status: 'offline', lastSeenAt: null };
      const agentStatus = computeStatus(liveness, config, now);
      const status = computeServiceStatus(service, liveness, config, now);
      const availability = await availabilityFor(db, service, liveness, config, now);
      const processMetrics = processMetricsView(
        metricsByKey.get(`${service.agentId}:${service.candidateId}`),
        service.processStartedAt,
        agentStatus,
        now,
      );
      return toSummary(
        service,
        agent?.name ?? '',
        agentStatus,
        status,
        availability,
        processMetrics,
      );
    }),
  );
}

async function summaryFor(
  db: Db,
  config: AppConfig,
  serviceId: string,
  now: Date,
): Promise<ServiceSummaryDto> {
  const service = await db.service.findUnique({ where: { id: serviceId } });
  if (!service) throw new ApiError(404, 'NOT_FOUND', 'Service not found');
  const agent = await db.agent.findUnique({ where: { id: service.agentId } });
  const liveness: AgentLiveness = agent
    ? { status: agent.status, lastSeenAt: agent.lastSeenAt }
    : { status: 'offline', lastSeenAt: null };
  const agentStatus = computeStatus(liveness, config, now);
  const status = computeServiceStatus(service, liveness, config, now);
  const availability = await availabilityFor(db, service, liveness, config, now);
  const metricRow = await db.serviceProcessMetric.findUnique({
    where: {
      agentId_candidateId: { agentId: service.agentId, candidateId: service.candidateId },
    },
  });
  const processMetrics = processMetricsView(
    metricRow ?? undefined,
    service.processStartedAt,
    agentStatus,
    now,
  );
  return toSummary(
    service,
    agent?.name ?? '',
    agentStatus,
    status,
    availability,
    processMetrics,
  );
}

/** Discovery candidates with a `monitored` flag (latest snapshot rows). */
export async function listDiscovered(
  db: Db,
  config: AppConfig,
  now: Date = new Date(),
): Promise<DiscoveredCandidateDto[]> {
  const [candidates, services] = await Promise.all([
    db.discoveredService.findMany({ orderBy: [{ agentId: 'asc' }, { port: 'asc' }] }),
    db.service.findMany({ select: { agentId: true, candidateId: true, port: true } }),
  ]);
  const monitored = new Set(
    services.map((service) => `${service.agentId}:${service.candidateId}:${service.port}`),
  );
  const agentIds = [...new Set(candidates.map((candidate) => candidate.agentId))];
  const agents = await db.agent.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true, status: true, lastSeenAt: true },
  });
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const metricRows = await db.serviceProcessMetric.findMany({
    where: { agentId: { in: agentIds } },
  });
  const metricsByKey = new Map(
    metricRows.map((row) => [`${row.agentId}:${row.candidateId}`, row]),
  );

  return candidates.map((candidate) => {
    const agent = agentById.get(candidate.agentId);
    const liveness: AgentLiveness = agent
      ? { status: agent.status, lastSeenAt: agent.lastSeenAt }
      : { status: 'offline', lastSeenAt: null };
    const agentStatus = computeStatus(liveness, config, now);
    const processMetrics = candidate.available
      ? processMetricsView(
          metricsByKey.get(`${candidate.agentId}:${candidate.candidateId}`),
          candidate.processStartedAt,
          agentStatus,
          now,
        )
      : emptyProcessMetrics();
    return {
    agentId: candidate.agentId,
    agentHostname: agent?.name ?? '',
    candidateId: candidate.candidateId,
    name: candidate.name,
    kind: candidate.kind,
    port: candidate.port,
    transport: candidate.transport,
    source: candidate.source,
    confidence: candidate.confidence,
    monitorable: candidate.monitorable,
    nameSource: fromStoredNameSource(candidate.nameSource),
    processStartedAt: iso(candidate.processStartedAt),
    suggestedPath: candidate.suggestedPath,
    suggestedStatuses: candidate.suggestedStatuses,
    monitored: monitored.has(
      `${candidate.agentId}:${candidate.candidateId}:${candidate.port}`,
    ),
    lastSeenAt: candidate.lastSeenAt.toISOString(),
    available: candidate.available,
    ...processMetrics,
    };
  });
}

export interface CreateServiceInput {
  agentId: string;
  candidateId: string;
  name?: string | undefined;
  path?: string | undefined;
  expectedStatuses?: number[] | undefined;
  intervalSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
  failureThreshold?: number | undefined;
  successThreshold?: number | undefined;
}

/**
 * Creates a monitored target from a discovered local candidate. Only a
 * candidate present in the latest snapshot and still available can be
 * selected; the port always comes from that snapshot (never from the body).
 */
export async function createService(
  db: Db,
  config: AppConfig,
  actor: string,
  input: CreateServiceInput,
  now: Date = new Date(),
): Promise<ServiceSummaryDto> {
  const intervalSeconds = input.intervalSeconds ?? 30;
  const timeoutSeconds = input.timeoutSeconds ?? 5;
  const failureThreshold = input.failureThreshold ?? 3;
  const successThreshold = input.successThreshold ?? 2;
  assertSchedule(intervalSeconds, timeoutSeconds);
  if (failureThreshold < 1 || failureThreshold > 100 ||
      successThreshold < 1 || successThreshold > 100) {
    throw new ApiError(400, 'INVALID_BODY', 'thresholds must be 1..100');
  }

  const serviceId = newServiceId();
  try {
    await db.$transaction(async (tx) => {
      const agent = await lockAgent(tx, input.agentId);
      if (agent.status === 'revoked') {
        throw new ApiError(409, 'AGENT_REVOKED', 'Agent is revoked');
      }
      const candidate = await tx.discoveredService.findUnique({
        where: {
          agentId_candidateId: { agentId: input.agentId, candidateId: input.candidateId },
        },
      });
      if (!candidate) {
        throw new ApiError(404, 'CANDIDATE_NOT_FOUND', 'Discovered candidate does not exist');
      }
      if (!candidate.available) {
        throw new ApiError(409, 'CANDIDATE_UNAVAILABLE', 'Candidate is no longer available');
      }

      // An explicit operator-chosen HTTP path remains the legacy escape
      // hatch for an otherwise unmonitorable listener. Without it, only an
      // explicitly monitorable candidate can be enabled.
      const explicitHttpPath = input.path !== undefined && input.path !== '';
      if (!candidate.monitorable && !explicitHttpPath) {
        throw new ApiError(400, 'PATH_REQUIRED', 'An explicit path is required for this candidate');
      }
      const transport =
        candidate.transport === 'tcp' && !explicitHttpPath ? 'tcp' : 'http';
      let path = '';
      let expectedStatuses: number[] = [];
      if (transport === 'http') {
        // Unknown/TCP listeners have no safe HTTP preset: monitoring them as
        // HTTP requires an explicit operator-chosen path. The discovery hint
        // is a suggestion only; the operator may rename it freely.
        path = input.path ?? candidate.suggestedPath ?? '';
        if (!path) {
          throw new ApiError(400, 'PATH_REQUIRED', 'An explicit path is required for this candidate');
        }
        assertSafePath(path);
        if (path.length > MAX_PATH_LENGTH) throw new ApiError(400, 'INVALID_BODY', 'path too long');
        expectedStatuses = normalizeStatuses(
          input.expectedStatuses ??
            (candidate.suggestedStatuses.length > 0 ? candidate.suggestedStatuses : [200]),
        );
        if (expectedStatuses.length === 0 || expectedStatuses.length > MAX_EXPECTED_STATUSES) {
          throw new ApiError(400, 'INVALID_BODY', 'expectedStatuses must contain 1..10 codes');
        }
      }

      const name = input.name ?? candidate.name;
      assertSafeName(name);
      if (name.length > MAX_NAME_LENGTH) throw new ApiError(400, 'INVALID_BODY', 'name too long');

      await tx.service.create({
        data: {
          id: serviceId,
          checkId: randomUUID(),
          agentId: input.agentId,
          candidateId: candidate.candidateId,
          name,
          port: candidate.port,
          transport,
          path,
          expectedStatuses,
          intervalSeconds,
          timeoutSeconds,
          failureThreshold,
          successThreshold,
          enabled: true,
          configRevision: 1,
          horizonAt: now,
          status: 'unknown',
          processStartedAt: candidate.processStartedAt,
        },
      });

      await tx.agent.update({
        where: { id: agent.id },
        data: { configVersion: { increment: 1 } },
      });

      await appendAudit(tx, {
        actor,
        action: 'service.create',
        target: serviceId,
        detail: {
          agentId: input.agentId,
          candidateId: candidate.candidateId,
          port: candidate.port,
          transport,
          path,
          expectedStatuses,
          intervalSeconds,
          timeoutSeconds,
          failureThreshold,
          successThreshold,
        },
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new ApiError(409, 'SERVICE_EXISTS', 'This candidate is already monitored');
    }
    throw error;
  }

  return summaryFor(db, config, serviceId, now);
}

export interface UpdateServiceInput {
  name?: string | undefined;
  path?: string | undefined;
  expectedStatuses?: number[] | undefined;
  intervalSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
  failureThreshold?: number | undefined;
  successThreshold?: number | undefined;
  enabled?: boolean | undefined;
}

/** Edits an approved target; incompatible edits reset the measurement horizon. */
export async function updateService(
  db: Db,
  config: AppConfig,
  actor: string,
  serviceId: string,
  input: UpdateServiceInput,
  now: Date = new Date(),
): Promise<ServiceSummaryDto> {
  const updated = await db.$transaction(async (tx) => {
    const existing = await tx.service.findUnique({ where: { id: serviceId } });
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Service not found');
    const agent = await lockAgent(tx, existing.agentId);
    const current = await tx.service.findUnique({ where: { id: serviceId } });
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Service not found');

    if (input.name !== undefined) assertSafeName(input.name);

    const isTcp = current.transport === 'tcp';
    // A TCP check has no HTTP path: `path` in the patch body is a client
    // mistake, not a harmless no-op — reject it instead of silently dropping
    // the operator's edit (HTTP path validation stays untouched below).
    if (input.path !== undefined) {
      if (isTcp) {
        throw new ApiError(400, 'INVALID_BODY', 'path is not editable for a TCP check');
      }
      assertSafePath(input.path);
    }

    const intervalSeconds = input.intervalSeconds ?? current.intervalSeconds;
    const timeoutSeconds = input.timeoutSeconds ?? current.timeoutSeconds;
    assertSchedule(intervalSeconds, timeoutSeconds);

    const failureThreshold = input.failureThreshold ?? current.failureThreshold;
    const successThreshold = input.successThreshold ?? current.successThreshold;
    if (failureThreshold < 1 || failureThreshold > 100 ||
        successThreshold < 1 || successThreshold > 100) {
      throw new ApiError(400, 'INVALID_BODY', 'thresholds must be 1..100');
    }

    // TCP checks carry no HTTP path/status semantics: expectedStatuses are not
    // editable for a TCP target and never reset its measurement horizon.
    const expectedStatuses = input.expectedStatuses !== undefined && !isTcp
      ? normalizeStatuses(input.expectedStatuses)
      : current.expectedStatuses;
    if (!isTcp && (expectedStatuses.length === 0 || expectedStatuses.length > MAX_EXPECTED_STATUSES)) {
      throw new ApiError(400, 'INVALID_BODY', 'expectedStatuses must contain 1..10 codes');
    }

    // A target/rule change invalidates the meaning of older successes: the
    // availability horizon and the check revision move forward.
    const targetChanged =
      (!isTcp && input.path !== undefined && input.path !== current.path) ||
      (!isTcp && input.expectedStatuses !== undefined && !statusesEqual(expectedStatuses, current.expectedStatuses)) ||
      intervalSeconds !== current.intervalSeconds;
    const resuming = input.enabled === true && !current.enabled;
    const enabled = input.enabled ?? current.enabled;
    const checkVisible =
      targetChanged ||
      timeoutSeconds !== current.timeoutSeconds ||
      enabled !== current.enabled;
    const changed =
      checkVisible ||
      (input.name !== undefined && input.name !== current.name) ||
      failureThreshold !== current.failureThreshold ||
      successThreshold !== current.successThreshold;

    if (!changed) {
      return current;
    }

    const next = await tx.service.update({
      where: { id: serviceId },
      data: {
        name: input.name ?? current.name,
        path: isTcp ? current.path : (input.path ?? current.path),
        expectedStatuses,
        intervalSeconds,
        timeoutSeconds,
        failureThreshold,
        successThreshold,
        enabled,
        ...(checkVisible ? { configRevision: { increment: 1 } } : {}),
        ...(targetChanged || resuming
          ? {
              horizonAt: now,
              status: 'unknown' as const,
              consecutiveFailures: 0,
              consecutiveSuccesses: 0,
              upSince: null,
              // Old observations describe the previous target/rules; the
              // first new-revision probe starts the fresh streak.
              lastCheckedAt: null,
              lastStatusCode: null,
              lastLatencyMs: null,
              lastErrorCode: null,
            }
          : {}),
        ...(enabled === false ? { status: 'paused' as const } : {}),
        updatedAt: now,
      },
    });

    // Any mutation refreshes the agent's config so it fetches the new check
    // set (and so an operator-visible change is never silently delayed).
    await tx.agent.update({
      where: { id: agent.id },
      data: { configVersion: { increment: 1 } },
    });

    await appendAudit(tx, {
      actor,
      action: 'service.update',
      target: serviceId,
      detail: {
        agentId: current.agentId,
        configRevision: next.configRevision,
        fields: Object.keys(input).filter(
          (key) => input[key as keyof UpdateServiceInput] !== undefined,
        ),
      },
    });

    return next;
  });

  return summaryFor(db, config, updated.id, now);
}

export async function deleteService(
  db: Db,
  actor: string,
  serviceId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const existing = await tx.service.findUnique({ where: { id: serviceId } });
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Service not found');
    const agent = await lockAgent(tx, existing.agentId);
    await tx.service.delete({ where: { id: serviceId } });
    await tx.agent.update({
      where: { id: agent.id },
      data: { configVersion: { increment: 1 } },
    });
    await appendAudit(tx, {
      actor,
      action: 'service.delete',
      target: serviceId,
      detail: { agentId: existing.agentId, candidateId: existing.candidateId },
    });
  });
}

export interface ServiceHistoryDto {
  results: Array<{
    checkedAt: string;
    ok: boolean;
    statusCode: number | null;
    latencyMs: number;
    errorCode: string | null;
  }>;
  incidents: Array<{
    id: string;
    openedAt: string;
    resolvedAt: string | null;
    reason: string;
  }>;
}

export async function getServiceHistory(
  db: Db,
  serviceId: string,
  limit: number,
): Promise<ServiceHistoryDto | null> {
  const service = await db.service.findUnique({ where: { id: serviceId }, select: { id: true } });
  if (!service) return null;
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), SERVICES_MAX_LIMIT);

  const results = await db.serviceResult.findMany({
    where: { serviceId },
    orderBy: { observedAt: 'desc' },
    take: bounded,
    select: { observedAt: true, ok: true, statusCode: true, latencyMs: true, errorCode: true },
  });
  results.reverse();

  const incidents = await db.serviceIncident.findMany({
    where: { serviceId },
    orderBy: { openedAt: 'desc' },
    take: Math.min(bounded, INCIDENTS_MAX_LIMIT),
    select: { id: true, openedAt: true, resolvedAt: true, reason: true },
  });

  return {
    results: results.map((result) => ({
      checkedAt: result.observedAt.toISOString(),
      ok: result.ok,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
    })),
    incidents: incidents.map((incident) => ({
      id: incident.id,
      openedAt: incident.openedAt.toISOString(),
      resolvedAt: iso(incident.resolvedAt),
      reason: incident.reason,
    })),
  };
}

/** Agent-facing check set: only this agent's own approved checks. */
export interface AgentServiceCheckDto {
  check_id: string;
  config_revision: number;
  candidate_id: string;
  port: number;
  /** `http` (default, legacy) or `tcp`. */
  transport: string;
  path: string;
  expected_statuses: number[];
  interval_s: number;
  timeout_s: number;
  enabled: boolean;
}

export async function agentServiceChecks(
  db: Db,
  agent: Pick<Agent, 'id' | 'capabilities'>,
): Promise<AgentServiceCheckDto[]> {
  const httpCapable = agent.capabilities.includes('http_checks');
  const tcpCapable = agent.capabilities.includes('tcp_checks');
  // Old agents without the capability must not receive checks they cannot
  // execute (an old agent would treat a TCP check as HTTP and report a false
  // down); an explicit empty array replaces any stale local set.
  if (!httpCapable && !tcpCapable) return [];
  const checks = await db.service.findMany({
    where: { agentId: agent.id, enabled: true },
    orderBy: { checkId: 'asc' },
  });
  return checks
    .filter((check) => (check.transport === 'tcp' ? tcpCapable : httpCapable))
    .map((check) => ({
      check_id: check.checkId,
      config_revision: check.configRevision,
      candidate_id: check.candidateId,
      port: check.port,
      transport: check.transport,
      path: check.transport === 'tcp' ? '' : check.path,
      expected_statuses: check.transport === 'tcp' ? [] : check.expectedStatuses,
      interval_s: check.intervalSeconds,
      timeout_s: check.timeoutSeconds,
      enabled: check.enabled,
    }));
}

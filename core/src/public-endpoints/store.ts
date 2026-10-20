/**
 * Public-endpoint persistence.
 *
 * Prisma-agnostic by design: it talks to the database through a narrow raw-SQL
 * surface (`$queryRawUnsafe` / `$executeRawUnsafe`) so this module compiles,
 * tests and runs BEFORE the shared `schema.prisma` migration lands (the
 * process-metrics owner is editing that file in parallel). Once the real
 * `PublicEndpoint` / `PublicEndpointResult` models exist, this store keeps
 * working unchanged — column names follow docs/data-model snake_case.
 *
 * `ensureTables` uses CREATE TABLE IF NOT EXISTS: safe to call at Core
 * startup and in tests; it never wipes. The authoritative DDL for the real
 * migration lives in `./migration.sql` (+ `./prisma-snippet.prisma`).
 */

import { ApiError } from '../lib/errors.js';
import {
  MAX_ENDPOINTS_PER_SERVICE,
  MAX_INTERVAL_SECONDS,
  MAX_LABEL_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MIN_INTERVAL_SECONDS,
  assertValidLabel,
  normalizePublicUrl,
} from './url-policy.js';

export type PublicEndpointStatus = 'unknown' | 'up' | 'down' | 'paused';

export interface PublicEndpointRow {
  id: string;
  serviceId: string;
  label: string | null;
  url: string;
  enabled: boolean;
  intervalSeconds: number;
  timeoutSeconds: number;
  status: PublicEndpointStatus;
  lastCheckedAt: string | null;
  statusCode: number | null;
  latencyMs: number | null;
  errorCode: string | null;
}

export interface PublicEndpointResultRow {
  checkedAt: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  errorCode: string | null;
}

/** Minimal raw-SQL surface (subset of PrismaClient). Implemented by tests with fakes. */
export interface RawDb {
  $queryRawUnsafe(query: string, ...params: unknown[]): Promise<unknown[]>;
  $executeRawUnsafe(query: string, ...params: unknown[]): Promise<number>;
}

/** Result of one probe tick, ready to persist. */
export interface ProbeResultInput {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  errorCode: string | null;
}

const HISTORY_CAP = 100;

export async function ensureTables(db: RawDb): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS public_endpoints (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      label TEXT,
      url TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      interval_seconds INTEGER NOT NULL DEFAULT 60,
      timeout_seconds INTEGER NOT NULL DEFAULT 8,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_checked_at TIMESTAMPTZ,
      last_status_code INTEGER,
      last_latency_ms DOUBLE PRECISION,
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (service_id, url)
    )`);
  await db.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS public_endpoints_service_idx
      ON public_endpoints (service_id)`);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS public_endpoint_results (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL REFERENCES public_endpoints(id) ON DELETE CASCADE,
      observed_at TIMESTAMPTZ NOT NULL,
      ok BOOLEAN NOT NULL,
      status_code INTEGER,
      latency_ms DOUBLE PRECISION NOT NULL,
      error_code TEXT
    )`);
  await db.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS public_endpoint_results_endpoint_idx
      ON public_endpoint_results (endpoint_id, observed_at DESC)`);
}

interface RawRow {
  id: string;
  service_id: string;
  label: string | null;
  url: string;
  enabled: boolean;
  interval_seconds: number;
  timeout_seconds: number;
  status: PublicEndpointStatus;
  last_checked_at: Date | string | null;
  last_status_code: number | null;
  last_latency_ms: number | null;
  last_error_code: string | null;
}

const iso = (value: Date | string | null): string | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

function toRow(raw: RawRow): PublicEndpointRow {
  return {
    id: raw.id,
    serviceId: raw.service_id,
    label: raw.label,
    url: raw.url,
    enabled: raw.enabled,
    intervalSeconds: raw.interval_seconds,
    timeoutSeconds: raw.timeout_seconds,
    status: raw.status,
    lastCheckedAt: iso(raw.last_checked_at),
    statusCode: raw.last_status_code,
    latencyMs: raw.last_latency_ms,
    errorCode: raw.last_error_code,
  };
}

async function serviceExists(db: RawDb, serviceId: string): Promise<boolean> {
  const rows = (await db.$queryRawUnsafe(
    'SELECT id FROM services WHERE id = $1',
    serviceId,
  )) as Array<{ id: string }>;
  return rows.length > 0;
}

export interface CreateInput {
  serviceId: string;
  url: string;
  label?: string | undefined;
  intervalSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
}

/** Creates an endpoint; validates service FK, per-service limit and uniqueness. */
export async function createEndpoint(
  db: RawDb,
  id: () => string,
  input: CreateInput,
  now: Date = new Date(),
): Promise<PublicEndpointRow> {
  const canonical = normalizePublicUrl(input.url);
  const label = input.label?.trim() === '' ? undefined : input.label;
  assertValidLabel(label);
  const intervalSeconds = input.intervalSeconds ?? 60;
  const timeoutSeconds = input.timeoutSeconds ?? 8;
  assertSchedule(intervalSeconds, timeoutSeconds);

  if (!(await serviceExists(db, input.serviceId))) {
    throw new ApiError(404, 'SERVICE_NOT_FOUND', 'Service not found');
  }
  const counted = (await db.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS count FROM public_endpoints WHERE service_id = $1',
    input.serviceId,
  )) as Array<{ count: number }>;
  if ((counted[0]?.count ?? 0) >= MAX_ENDPOINTS_PER_SERVICE) {
    throw new ApiError(409, 'ENDPOINT_LIMIT', 'Ta usługa ma już maksymalnie 5 adresów publicznych.');
  }
  try {
    const rows = (await db.$queryRawUnsafe(
      `INSERT INTO public_endpoints
         (id, service_id, label, url, enabled, interval_seconds, timeout_seconds, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6, 'unknown', $7, $7)
       RETURNING id, service_id, label, url, enabled, interval_seconds, timeout_seconds,
                 status, last_checked_at, last_status_code, last_latency_ms, last_error_code`,
      id(),
      input.serviceId,
      label ?? null,
      canonical,
      intervalSeconds,
      timeoutSeconds,
      now,
    )) as RawRow[];
    const created = rows[0];
    if (!created) throw new ApiError(500, 'INTERNAL', 'Internal server error');
    return toRow(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'ENDPOINT_EXISTS', 'Ten adres jest już dodany do tej usługi.');
    }
    throw error;
  }
}

export interface UpdateInput {
  url?: string | undefined;
  label?: string | undefined;
  enabled?: boolean | undefined;
  intervalSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
}

/**
 * Edits an endpoint. When the probed target changes (URL), the stored result
 * is cleared back to `unknown` — old successes must never describe the new
 * target (same honesty rule as service retargeting).
 */
export async function updateEndpoint(
  db: RawDb,
  endpointId: string,
  input: UpdateInput,
  now: Date = new Date(),
): Promise<PublicEndpointRow> {
  const existing = (await db.$queryRawUnsafe(
    `SELECT id, service_id, label, url, enabled, interval_seconds, timeout_seconds,
            status, last_checked_at, last_status_code, last_latency_ms, last_error_code
       FROM public_endpoints WHERE id = $1`,
    endpointId,
  )) as RawRow[];
  const current = existing[0];
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'Public endpoint not found');

  const canonical = input.url !== undefined ? normalizePublicUrl(input.url) : current.url;
  const label = input.label !== undefined
    ? (input.label.trim() === '' ? null : input.label)
    : current.label;
  assertValidLabel(label ?? undefined);
  const intervalSeconds = input.intervalSeconds ?? current.interval_seconds;
  const timeoutSeconds = input.timeoutSeconds ?? current.timeout_seconds;
  assertSchedule(intervalSeconds, timeoutSeconds);
  const enabled = input.enabled ?? current.enabled;

  const targetChanged = canonical !== current.url;
  const resuming = enabled && !current.enabled;
  const status: PublicEndpointStatus = !enabled
    ? 'paused'
    : targetChanged || resuming
      ? 'unknown'
      : current.status;

  try {
    const rows = (await db.$queryRawUnsafe(
      `UPDATE public_endpoints SET
         label = $2, url = $3, enabled = $4,
         interval_seconds = $5, timeout_seconds = $6, status = $7,
         last_checked_at = CASE WHEN $8 THEN NULL ELSE last_checked_at END,
         last_status_code = CASE WHEN $8 THEN NULL ELSE last_status_code END,
         last_latency_ms = CASE WHEN $8 THEN NULL ELSE last_latency_ms END,
         last_error_code = CASE WHEN $8 THEN NULL ELSE last_error_code END,
         updated_at = $9
       WHERE id = $1
       RETURNING id, service_id, label, url, enabled, interval_seconds, timeout_seconds,
                 status, last_checked_at, last_status_code, last_latency_ms, last_error_code`,
      endpointId,
      label,
      canonical,
      enabled,
      intervalSeconds,
      timeoutSeconds,
      status,
      targetChanged || resuming,
      now,
    )) as RawRow[];
    const updated = rows[0];
    if (!updated) throw new ApiError(404, 'NOT_FOUND', 'Public endpoint not found');
    if (targetChanged || resuming) {
      await db.$executeRawUnsafe(
        'DELETE FROM public_endpoint_results WHERE endpoint_id = $1',
        endpointId,
      );
    }
    return toRow(updated);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'ENDPOINT_EXISTS', 'Ten adres jest już dodany do tej usługi.');
    }
    throw error;
  }
}

export async function deleteEndpoint(db: RawDb, endpointId: string): Promise<void> {
  const count = await db.$executeRawUnsafe('DELETE FROM public_endpoints WHERE id = $1', endpointId);
  if (count === 0) throw new ApiError(404, 'NOT_FOUND', 'Public endpoint not found');
}

export async function listEndpoints(db: RawDb, serviceId: string): Promise<PublicEndpointRow[]> {
  if (!(await serviceExists(db, serviceId))) {
    throw new ApiError(404, 'SERVICE_NOT_FOUND', 'Service not found');
  }
  const rows = (await db.$queryRawUnsafe(
    `SELECT id, service_id, label, url, enabled, interval_seconds, timeout_seconds,
            status, last_checked_at, last_status_code, last_latency_ms, last_error_code
       FROM public_endpoints WHERE service_id = $1 ORDER BY created_at ASC`,
    serviceId,
  )) as RawRow[];
  return rows.map(toRow);
}

/** All due endpoints across services (single query for the scheduler tick). */
export async function listDueEndpoints(db: RawDb, now: Date = new Date()): Promise<PublicEndpointRow[]> {
  const rows = (await db.$queryRawUnsafe(
    `SELECT id, service_id, label, url, enabled, interval_seconds, timeout_seconds,
            status, last_checked_at, last_status_code, last_latency_ms, last_error_code
       FROM public_endpoints
      WHERE enabled = TRUE
        AND (last_checked_at IS NULL OR last_checked_at <= $1)
      ORDER BY last_checked_at NULLS FIRST`,
    now,
  )) as RawRow[];
  return rows
    .filter((row) => {
      if (!row.last_checked_at) return true;
      const nextDue = new Date(row.last_checked_at).getTime() + row.interval_seconds * 1000;
      return nextDue <= now.getTime();
    })
    .map(toRow);
}

/** Persists one probe result + bounded history (last 100 kept). */
export async function recordProbeResult(
  db: RawDb,
  resultId: () => string,
  endpointId: string,
  result: ProbeResultInput,
  now: Date = new Date(),
): Promise<PublicEndpointRow> {
  const status: PublicEndpointStatus = result.ok ? 'up' : 'down';
  const rows = (await db.$queryRawUnsafe(
    `UPDATE public_endpoints SET
       status = $2, last_checked_at = $3, last_status_code = $4,
       last_latency_ms = $5, last_error_code = $6, updated_at = $3
     WHERE id = $1 AND enabled = TRUE
     RETURNING id, service_id, label, url, enabled, interval_seconds, timeout_seconds,
               status, last_checked_at, last_status_code, last_latency_ms, last_error_code`,
    endpointId,
    status,
    now,
    result.statusCode,
    result.latencyMs,
    result.errorCode,
  )) as RawRow[];
  const updated = rows[0];
  if (!updated) {
    // Paused/deleted mid-flight: drop the observation, keep the row honest.
    return getEndpointOrThrow(db, endpointId);
  }
  await db.$executeRawUnsafe(
    `INSERT INTO public_endpoint_results
       (id, endpoint_id, observed_at, ok, status_code, latency_ms, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    resultId(),
    endpointId,
    now,
    result.ok,
    result.statusCode,
    result.latencyMs,
    result.errorCode,
  );
  await db.$executeRawUnsafe(
    `DELETE FROM public_endpoint_results WHERE id IN (
       SELECT id FROM public_endpoint_results
        WHERE endpoint_id = $1 ORDER BY observed_at DESC OFFSET ${HISTORY_CAP}
     )`,
    endpointId,
  );
  return toRow(updated);
}

export async function getEndpointOrThrow(db: RawDb, endpointId: string): Promise<PublicEndpointRow> {
  const rows = (await db.$queryRawUnsafe(
    `SELECT id, service_id, label, url, enabled, interval_seconds, timeout_seconds,
            status, last_checked_at, last_status_code, last_latency_ms, last_error_code
       FROM public_endpoints WHERE id = $1`,
    endpointId,
  )) as RawRow[];
  const row = rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Public endpoint not found');
  return toRow(row);
}

export async function getEndpointHistory(
  db: RawDb,
  endpointId: string,
  limit: number,
): Promise<PublicEndpointResultRow[]> {
  await getEndpointOrThrow(db, endpointId);
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), HISTORY_CAP);
  const rows = (await db.$queryRawUnsafe(
    `SELECT observed_at, ok, status_code, latency_ms, error_code
       FROM public_endpoint_results WHERE endpoint_id = $1
      ORDER BY observed_at DESC LIMIT $2`,
    endpointId,
    bounded,
  )) as Array<{
    observed_at: Date | string;
    ok: boolean;
    status_code: number | null;
    latency_ms: number;
    error_code: string | null;
  }>;
  return rows.reverse().map((row) => ({
    checkedAt: iso(row.observed_at) ?? new Date(0).toISOString(),
    ok: row.ok,
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    errorCode: row.error_code,
  }));
}

function assertSchedule(intervalSeconds: number, timeoutSeconds: number): void {
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < MIN_INTERVAL_SECONDS ||
    intervalSeconds > MAX_INTERVAL_SECONDS
  ) {
    throw new ApiError(400, 'INVALID_BODY', `intervalSeconds musi być w zakresie ${MIN_INTERVAL_SECONDS}..${MAX_INTERVAL_SECONDS}.`);
  }
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS ||
    timeoutSeconds >= intervalSeconds
  ) {
    throw new ApiError(400, 'INVALID_BODY', 'timeoutSeconds musi być 1..10 i mniejszy niż intervalSeconds.');
  }
  if (timeoutSeconds > 8) {
    // Total probe deadline is 8 s; larger timeouts would lie about the cap.
    throw new ApiError(400, 'INVALID_BODY', 'timeoutSeconds nie może przekraczać 8 (limit czasu sondy).');
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (code === 'P2002' || code === '23505') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /unique|duplicate/i.test(message) && /public_endpoint|service_id.*url|url/i.test(message);
}

export function assertLabelWithinBounds(label: string | undefined): void {
  if (label !== undefined && label.length > MAX_LABEL_LENGTH) {
    throw new ApiError(400, 'INVALID_BODY', `Etykieta może mieć maksymalnie ${MAX_LABEL_LENGTH} znaków.`);
  }
}

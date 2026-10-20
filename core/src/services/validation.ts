import { invalidBody } from '../lib/errors.js';

export const SERVICE_KINDS = ['jellyfin', 't3-code', 'opencode', 'unknown'] as const;
export const SERVICE_TRANSPORTS = ['http', 'tcp'] as const;
export const SERVICE_CONFIDENCES = ['high', 'medium', 'low'] as const;

/**
 * Safe generic-discovery name evidence. Kept separate from `source` so old
 * agents can keep sending the closed legacy source enum; new agents add
 * `name_source` without widening `source`.
 */
export const DISCOVERY_NAME_SOURCES = [
  'exe',
  'comm',
  'package-json',
  'systemd',
  'container',
  'fallback',
  'fingerprint',
] as const;
export type DiscoveryNameSource = (typeof DISCOVERY_NAME_SOURCES)[number];

/** Prisma stores the hyphenated wire value via `@map`; raw SQL uses it as-is. */
export function toDbNameSource(
  source: DiscoveryNameSource | null | undefined,
): DiscoveryNameSource | null {
  return source ?? null;
}

/** Prisma client enum identifier for the hyphenated `package-json` value. */
export function toClientNameSource(
  source: DiscoveryNameSource | undefined,
): 'exe' | 'comm' | 'package_json' | 'systemd' | 'container' | 'fallback' | 'fingerprint' | null {
  if (source === undefined) return null;
  return source === 'package-json' ? 'package_json' : source;
}

/** Normalizes either DB/wire (`package-json`) or Prisma client (`package_json`). */
export function fromStoredNameSource(
  source: string | null | undefined,
): DiscoveryNameSource | null {
  if (!source) return null;
  return (source === 'package_json' ? 'package-json' : source) as DiscoveryNameSource;
}

/**
 * Legacy inference: agents that do not send `monitorable` may only be
 * monitored as HTTP, and only when they supplied an explicit path or a known
 * kind. New agents send the field explicitly (a generic TCP listener with an
 * unknown kind can therefore be monitorable).
 */
export function inferMonitorable(candidate: {
  monitorable?: boolean | undefined;
  transport: string;
  kind: string;
  suggested_path?: string | null | undefined;
  suggestedPath?: string | null | undefined;
}): boolean {
  if (candidate.monitorable !== undefined) return candidate.monitorable;
  const path = candidate.suggestedPath ?? candidate.suggested_path ?? null;
  return candidate.transport === 'http' && (path !== null || candidate.kind !== 'unknown');
}

/**
 * Safe, closed set of discovery evidence labels. The wire never carries
 * cmdline/env/stdout/body — only the name of the local rule that produced
 * the candidate.
 */
export const SERVICE_SOURCES = [
  'proc',
  'proc-comm',
  'docker-proxy',
  'http-fingerprint',
] as const;

export const MAX_CANDIDATES = 64;
export const MAX_RESULTS = 64;
export const MAX_PATH_LENGTH = 512;
export const MAX_NAME_LENGTH = 128;
export const MIN_INTERVAL_S = 15;
export const MAX_INTERVAL_S = 3600;
export const MIN_TIMEOUT_S = 1;
export const MAX_TIMEOUT_S = 10;
export const MAX_EXPECTED_STATUSES = 10;
export const AVAILABILITY_WINDOW_MS = 24 * 3_600_000;

/**
 * Relative-path allowlist, identical to the agent-side probe rule: a single
 * leading '/', no '//', no absolute URL, no userinfo, no backslash and no
 * whitespace/control characters. A path can never smuggle a host.
 */
export function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (!path.startsWith('/')) return false;
  if (path.includes('//')) return false;
  if (path.includes('://')) return false;
  if (path.includes('@') || path.includes('\\')) return false;
  if (/\s/.test(path) || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false;
  return true;
}

/** Safe display label: bounded, no control characters. */
export function isSafeName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  return ![...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function assertSafePath(path: string): void {
  if (!isSafePath(path)) throw invalidBody('path must be a relative path starting with a single "/"');
}

export function assertSafeName(name: string): void {
  if (!isSafeName(name)) throw invalidBody('name must be 1..128 printable characters');
}

/** Validates interval/timeout/threshold bounds and timeout < interval. */
export function assertSchedule(intervalSeconds: number, timeoutSeconds: number): void {
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < MIN_INTERVAL_S ||
    intervalSeconds > MAX_INTERVAL_S
  ) {
    throw invalidBody(`intervalSeconds must be ${MIN_INTERVAL_S}..${MAX_INTERVAL_S}`);
  }
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < MIN_TIMEOUT_S ||
    timeoutSeconds > MAX_TIMEOUT_S ||
    timeoutSeconds >= intervalSeconds
  ) {
    throw invalidBody('timeoutSeconds must be 1..10 and strictly below intervalSeconds');
  }
}

export function normalizeStatuses(statuses: number[]): number[] {
  return [...new Set(statuses)].sort((a, b) => a - b);
}

export function statusesEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

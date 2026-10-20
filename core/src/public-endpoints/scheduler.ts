/**
 * Public-endpoint scheduler (Core side, independent of agent heartbeats).
 *
 * - Bounded concurrency 2; never overlaps one endpoint (in-flight set).
 * - Ticks on its own timer; a slow probe never blocks agent ingest or host
 *   metrics because it runs on a separate tick with its own pool.
 * - Definitions + last results persist in Postgres, so a Core restart
 *   resumes without fabricating uptime: rows with no fresh probe read as
 *   `unknown` until the first tick completes (startup marks nothing `up`).
 * - Paused endpoints are skipped.
 */

import { randomUUID } from 'node:crypto';
import {
  listDueEndpoints,
  recordProbeResult,
  type ProbeResultInput,
  type RawDb,
} from './store.js';
import { probePublicEndpoint, type ProbeDeps, type ProbeOutcome } from './probe.js';

/**
 * Maps a probe outcome to stored status/error. Honesty rules:
 *  - any answered status (2xx/3xx/4xx) means the endpoint responded, so it is
 *    stored `up`; 3xx keeps errorCode `REDIRECT` and 401/403 `AUTH_REQUIRED`
 *    so the UI can label it without claiming it is healthy;
 *  - only a transport failure or 5xx is stored `down`;
 *  - a redirect is never chased, so it is never presented as final health.
 */
export function classifyProbeOutcome(outcome: ProbeOutcome): ProbeResultInput {
  if (outcome.kind === 'failed') {
    return { ok: false, statusCode: null, latencyMs: outcome.latencyMs, errorCode: outcome.errorCode };
  }
  const { statusCode, latencyMs } = outcome;
  if (outcome.kind === 'redirect') {
    return { ok: true, statusCode, latencyMs, errorCode: 'REDIRECT' };
  }
  if (statusCode >= 200 && statusCode < 300) {
    return { ok: true, statusCode, latencyMs, errorCode: null };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { ok: true, statusCode, latencyMs, errorCode: 'AUTH_REQUIRED' };
  }
  if (statusCode >= 300 && statusCode < 500) {
    return { ok: true, statusCode, latencyMs, errorCode: 'UNEXPECTED_STATUS' };
  }
  return { ok: false, statusCode, latencyMs, errorCode: 'UNEXPECTED_STATUS' };
}

export interface PublicEndpointSchedulerOptions {
  /** Tick period in ms. Defaults to 15 s. */
  tickMs?: number;
  /** Max parallel probes. Defaults to 2, never above 4. */
  concurrency?: number;
  probeDeps?: ProbeDeps;
  now?: () => Date;
}

export class PublicEndpointScheduler {
  private readonly db: RawDb;
  private readonly tickMs: number;
  private readonly concurrency: number;
  private readonly probeDeps: ProbeDeps;
  private readonly now: () => Date;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  onError: ((error: unknown) => void) | null = null;

  constructor(db: RawDb, options: PublicEndpointSchedulerOptions = {}) {
    this.db = db;
    this.tickMs = options.tickMs ?? 15_000;
    this.concurrency = Math.min(Math.max(1, options.concurrency ?? 2), 4);
    this.probeDeps = options.probeDeps ?? {};
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tickOnce().catch((error: unknown) => this.onError?.(error));
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get pendingCount(): number {
    return this.inFlight.size;
  }

  /** One bounded tick: probes due endpoints with a worker pool. */
  async tickOnce(): Promise<number> {
    if (this.ticking) return 0; // never overlap ticks
    this.ticking = true;
    try {
      const now = this.now();
      const due = (await listDueEndpoints(this.db, now)).filter(
        (endpoint) => !this.inFlight.has(endpoint.id),
      );
      let completed = 0;
      const queue = [...due];
      const workers = Array.from(
        { length: Math.min(this.concurrency, queue.length) },
        async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (!next) return;
            this.inFlight.add(next.id);
            try {
              const outcome = await probePublicEndpoint(
                { url: next.url, timeoutSeconds: next.timeoutSeconds },
                this.probeDeps,
              );
              await recordProbeResult(
                this.db,
                () => randomUUID(),
                next.id,
                classifyProbeOutcome(outcome),
                this.now(),
              );
              completed += 1;
            } catch (error) {
              this.onError?.(error);
            } finally {
              this.inFlight.delete(next.id);
            }
          }
        },
      );
      await Promise.all(workers);
      return completed;
    } finally {
      this.ticking = false;
    }
  }
}

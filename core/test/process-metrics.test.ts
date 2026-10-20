import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  bootstrapAndEnroll,
  candidate,
  createHarness,
  createServiceViaApi,
  discoveryPayload,
  heartbeatPayload,
  resetDb,
  sendHeartbeat,
  sendServiceHeartbeat,
  type EnrolledAgent,
  type Harness,
  type Session,
} from './helpers.js';

let h: Harness;

const CAPS = ['metrics', 'service_discovery', 'http_checks'];
const STARTED = new Date(Date.now() - 3_600_000).toISOString();
const MiB = 1024 * 1024;

beforeEach(async () => {
  h = await createHarness();
  await resetDb(h.db);
});

afterEach(async () => {
  await h.close();
});

function processMetric(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: 'jellyfin-8096',
    process_started_at: STARTED,
    observed_at: new Date().toISOString(),
    cpu_percent: 12.5,
    memory_rss_bytes: 84 * MiB,
    ...overrides,
  };
}

async function withCandidate(): Promise<{ session: Session; agent: EnrolledAgent }> {
  const { session, agent } = await bootstrapAndEnroll(h, 'process-host', CAPS);
  const res = await sendServiceHeartbeat(h, agent, 1, {
    discovery: discoveryPayload([candidate(8096, { process_started_at: STARTED })]),
  });
  expect(res.statusCode).toBe(200);
  return { session, agent };
}

async function sendMetrics(
  agent: EnrolledAgent,
  seq: number,
  metrics: Array<Record<string, unknown>>,
) {
  return sendHeartbeat(
    h,
    agent,
    heartbeatPayload(seq, { service_process_metrics: metrics }),
  );
}

async function discovered(session: Session): Promise<Array<Record<string, unknown>>> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/services/discovered',
    headers: authHeaders(h.config, session),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { candidates: Array<Record<string, unknown>> }).candidates;
}

async function services(session: Session): Promise<Array<Record<string, unknown>>> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/services',
    headers: authHeaders(h.config, session),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { services: Array<Record<string, unknown>> }).services;
}

describe('process metrics ingest and API', () => {
  it('stores first null-CPU sample with RSS and exposes it on candidates and services', async () => {
    const { session, agent } = await withCandidate();
    const res = await sendMetrics(agent, 2, [
      processMetric({ cpu_percent: null }),
    ]);
    expect(res.statusCode).toBe(200);

    const first = (await discovered(session)).find((c) => c.candidateId === 'jellyfin-8096');
    expect(first).toMatchObject({
      processCpuPercent: null,
      processMemoryRssBytes: 84 * MiB,
    });
    expect(first?.processMetricsAt).toEqual(expect.any(String));

    await createServiceViaApi(h, session, {
      agentId: agent.agentId,
      candidateId: 'jellyfin-8096',
      path: '/Health',
      expectedStatuses: [200],
    });
    const service = (await services(session))[0];
    expect(service).toMatchObject({
      processCpuPercent: null,
      processMemoryRssBytes: 84 * MiB,
    });
  });

  it('keeps multi-core values above 100% and updates the latest observation', async () => {
    const { session, agent } = await withCandidate();
    expect((await sendMetrics(agent, 2, [processMetric({ cpu_percent: 137.5 })])).statusCode).toBe(200);

    const row = (await discovered(session)).find((c) => c.candidateId === 'jellyfin-8096');
    expect(row).toMatchObject({ processCpuPercent: 137.5, processMemoryRssBytes: 84 * MiB });
  });

  it('ignores reordered observations, process-start mismatches and unknown candidates', async () => {
    const { session, agent } = await withCandidate();
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 5_000).toISOString();

    await sendMetrics(agent, 2, [
      processMetric({ observed_at: newer, cpu_percent: 20 }),
      processMetric({ candidate_id: 'unknown-9999', observed_at: newer, cpu_percent: 99 }),
    ]);
    await sendMetrics(agent, 3, [
      processMetric({ observed_at: older, cpu_percent: 80 }),
    ]);

    let row = (await discovered(session)).find((c) => c.candidateId === 'jellyfin-8096');
    expect(row).toMatchObject({ processCpuPercent: 20 });

    // Different process start (restart/identity changed) is never attached
    // to the current candidate identity.
    await sendMetrics(agent, 4, [
      processMetric({
        process_started_at: new Date(Date.now() - 60_000).toISOString(),
        cpu_percent: 55,
      }),
    ]);
    row = (await discovered(session)).find((c) => c.candidateId === 'jellyfin-8096');
    expect(row).toMatchObject({ processCpuPercent: 20 });
    expect((await discovered(session)).some((c) => c.candidateId === 'unknown-9999')).toBe(false);
  });

  it('nullifies a stored observation older than 45 s instead of retaining it', async () => {
    const { session, agent } = await withCandidate();
    const stale = new Date(Date.now() - 60_000).toISOString();
    expect((await sendMetrics(agent, 2, [
      processMetric({ observed_at: stale, cpu_percent: 33, memory_rss_bytes: 10 * MiB }),
    ])).statusCode).toBe(200);

    const row = (await discovered(session)).find((c) => c.candidateId === 'jellyfin-8096');
    expect(row).toMatchObject({
      processCpuPercent: null,
      processMemoryRssBytes: null,
      processMetricsAt: null,
    });
  });

  it('handles a full 64-candidate snapshot with 64 process metrics and 64 results in one bounded transaction', async () => {
    const { session, agent } = await withCandidate();
    const created = await createServiceViaApi(h, session, {
      agentId: agent.agentId,
      candidateId: 'jellyfin-8096',
      path: '/Health',
      expectedStatuses: [200],
    });
    const stored = await h.db.service.findUniqueOrThrow({ where: { id: created.id as string } });

    const candidates = Array.from({ length: 64 }, (_, i) => {
      if (i === 0) return candidate(8096, { process_started_at: STARTED });
      return candidate(10000 + i, {
        candidate_id: `t3-code-${10000 + i}`,
        name: 'T3 Code',
        kind: 't3-code',
        source: 'proc',
        confidence: 'high',
        suggested_path: '/',
        suggested_statuses: [200],
        process_started_at: STARTED,
      });
    });
    const metrics = candidates.map((c) => processMetric({
      candidate_id: c.candidate_id as string,
      process_started_at: STARTED,
      cpu_percent: 1,
      memory_rss_bytes: MiB,
    }));
    const now = Date.now();
    const results = Array.from({ length: 64 }, (_, i) => ({
      check_id: stored.checkId,
      config_revision: stored.configRevision,
      observed_at: new Date(now - 120_000 + i * 1_000).toISOString(),
      ok: true,
      status_code: 200,
      latency_ms: 2,
      error_code: null,
    }));

    const startedAt = performance.now();
    const res = await sendHeartbeat(h, agent, heartbeatPayload(2, {
      service_discovery: discoveryPayload(candidates),
      service_process_metrics: metrics,
      service_results: results,
    }));
    const elapsed = performance.now() - startedAt;
    expect(res.statusCode, res.body).toBe(200);
    // The explicit 15 s transaction bound must hold for the maximum bounded
    // payload even on a slow review disk.
    expect(elapsed).toBeLessThan(15_000);

    expect(await h.db.discoveredService.count()).toBe(64);
    expect(await h.db.serviceProcessMetric.count()).toBe(64);
    expect(await h.db.serviceResult.count()).toBe(64);

    // Identical periodic snapshot is skipped (no per-candidate rewrite):
    // lastSeenAt stays at the first accepted snapshot.
    const before = await h.db.discoveredService.findUniqueOrThrow({
      where: { agentId_candidateId: { agentId: agent.agentId, candidateId: 'jellyfin-8096' } },
      select: { lastSeenAt: true },
    });
    const skip = await sendServiceHeartbeat(h, agent, 3, {
      discovery: discoveryPayload(candidates, {
        observed_at: new Date(now + 10_000).toISOString(),
      }),
    });
    expect(skip.statusCode).toBe(200);
    const after = await h.db.discoveredService.findUniqueOrThrow({
      where: { agentId_candidateId: { agentId: agent.agentId, candidateId: 'jellyfin-8096' } },
      select: { lastSeenAt: true },
    });
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());
  });

  it('rejects invalid values and future observations without poisoning host metrics', async () => {
    const { agent } = await withCandidate();
    const negative = await sendMetrics(agent, 2, [processMetric({ cpu_percent: -1 })]);
    expect(negative.statusCode).toBe(400);
    expect((negative.json() as { code: string }).code).toBe('INVALID_BODY');

    const future = await sendMetrics(agent, 3, [
      processMetric({ observed_at: new Date(Date.now() + 120_000).toISOString() }),
    ]);
    expect(future.statusCode).toBe(400);

    // Host metrics for the rejected sequences were never written, but the
    // next valid heartbeat still succeeds normally.
    const ok = await sendMetrics(agent, 4, [processMetric({ cpu_percent: 0, memory_rss_bytes: 0 })]);
    expect(ok.statusCode).toBe(200);
  });
});

/**
 * Generic service discovery (additive v2 contract) against real Postgres.
 *
 * Covers: bounded new candidate fields (`monitorable`, `name_source`), the
 * rule that `kind: "unknown"` never implies unmonitorable, generic candidate
 * ids, TCP checks in the agent config (capability-gated), no path required
 * for TCP, restart detection resetting continuity, and the derived
 * `degraded` status before a confirmed incident.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentHeaders,
  authHeaders,
  bootstrapAndEnroll,
  candidate,
  createHarness,
  createServiceViaApi,
  discoveryPayload,
  heartbeatPayload,
  resetDb,
  resultPayload,
  sendHeartbeat,
  sendServiceHeartbeat,
  type EnrolledAgent,
  type Harness,
  type Session,
} from './helpers.js';
import { computeServiceStatus } from '../src/services/service.js';

let h: Harness;

const HTTP_CAPS = ['metrics', 'service_discovery', 'http_checks'];
const V2_CAPS = ['metrics', 'service_discovery', 'http_checks', 'tcp_checks'];

beforeEach(async () => {
  h = await createHarness();
  await resetDb(h.db);
});

afterEach(async () => {
  await h.close();
});

async function discovered(session: Session): Promise<Array<Record<string, unknown>>> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/services/discovered',
    headers: authHeaders(h.config, session),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { candidates: Array<Record<string, unknown>> }).candidates;
}

async function agentConfig(agent: EnrolledAgent): Promise<{
  service_checks: Array<Record<string, unknown>>;
}> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/agent/config',
    headers: agentHeaders(agent),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { service_checks: Array<Record<string, unknown>> };
}

const genericTcp = (port: number) =>
  candidate(port, {
    candidate_id: `generic-${port}`,
    name: 'Moja baza',
    kind: 'unknown',
    transport: 'tcp',
    source: 'proc',
    confidence: 'low',
    monitorable: true,
    name_source: 'package-json',
    suggested_path: null,
    suggested_statuses: [],
  });

describe('generic discovery contract', () => {
  it('persists monitorable/name_source and exposes them with actual names', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'generic-host', V2_CAPS);
    const res = await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([genericTcp(5432)]),
    });
    expect(res.statusCode).toBe(200);

    const rows = await discovered(session);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      candidateId: 'generic-5432',
      name: 'Moja baza',
      kind: 'unknown',
      transport: 'tcp',
      monitorable: true,
      nameSource: 'package-json',
    });
    const stored = await h.db.discoveredService.findUniqueOrThrow({
      where: { agentId_candidateId: { agentId: agent.agentId, candidateId: 'generic-5432' } },
    });
    expect(stored.monitorable).toBe(true);
    expect(stored.nameSource).toBe('package_json');
  });

  it('infers legacy monitorability when the field is absent (kind unknown over tcp stays unmonitorable)', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'legacy-host', V2_CAPS);
    await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([
        candidate(9090, {
          candidate_id: 'unknown-9090',
          kind: 'unknown',
          transport: 'tcp',
          suggested_path: null,
          suggested_statuses: [],
        }),
      ]),
    });
    const rows = await discovered(session);
    expect(rows[0]).toMatchObject({ monitorable: false, nameSource: null });
  });

  it('rejects an out-of-contract name_source and duplicate candidate ids', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'bad-host', V2_CAPS);
    const badSource = await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([
        { ...genericTcp(5432), name_source: 'cmdline' },
      ]),
    });
    expect(badSource.statusCode).toBe(400);
    expect(badSource.json()).toMatchObject({ code: 'INVALID_BODY' });

    const duplicate = await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([genericTcp(5432), genericTcp(5432)]),
    });
    expect(duplicate.statusCode).toBe(400);
  });

  it('enables a generic TCP listener without a path and sends transport tcp to a capable agent', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'tcp-host', V2_CAPS);
    await sendServiceHeartbeat(h, agent, 1, { discovery: discoveryPayload([genericTcp(5432)]) });

    const service = await createServiceViaApi(h, session, {
      agentId: agent.agentId,
      candidateId: 'generic-5432',
    });
    expect(service).toMatchObject({
      name: 'Moja baza',
      transport: 'tcp',
      path: '',
      expectedStatuses: [],
      status: 'unknown',
    });

    const cfg = await agentConfig(agent);
    expect(cfg.service_checks).toHaveLength(1);
    expect(cfg.service_checks[0]).toMatchObject({
      candidate_id: 'generic-5432',
      port: 5432,
      transport: 'tcp',
      path: '',
      expected_statuses: [],
    });
  });

  it('infers TCP support from wire-v2 evidence (monitorable) so old capability strings are not required', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'http-only-host', HTTP_CAPS);
    // The v2 candidate carries `monitorable`; that is itself proof of a
    // transport-aware agent. The old agent never sends this field.
    await sendServiceHeartbeat(h, agent, 1, { discovery: discoveryPayload([genericTcp(5432)]) });
    const service = await createServiceViaApi(h, session, {
      agentId: agent.agentId,
      candidateId: 'generic-5432',
    });
    expect(service).toMatchObject({ transport: 'tcp' });

    const stored = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(stored.capabilities).toContain('tcp_checks');
    const cfg = await agentConfig(agent);
    expect(cfg.service_checks).toHaveLength(1);
    expect(cfg.service_checks[0]).toMatchObject({ transport: 'tcp', port: 5432 });
  });

  it('accepts process metrics for a generic candidate only with exact identity (no kind whitelist)', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'generic-metrics-host', V2_CAPS);
    const started = new Date(Date.now() - 3_600_000).toISOString();
    const withPid = genericTcp(5432);
    withPid.process_started_at = started;
    const withoutPid = genericTcp(5433);
    withoutPid.process_started_at = null;
    await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([withPid, withoutPid]),
    });

    const observed = new Date().toISOString();
    const res = await sendHeartbeat(h, agent, heartbeatPayload(2, {
      service_process_metrics: [
        {
          candidate_id: 'generic-5432',
          process_started_at: started,
          observed_at: observed,
          cpu_percent: 37.5,
          memory_rss_bytes: 64 * 1024 * 1024,
        },
        {
          // No proven owner start: must never be attached.
          candidate_id: 'generic-5433',
          process_started_at: started,
          observed_at: observed,
          cpu_percent: 99,
          memory_rss_bytes: 1024,
        },
      ],
    }));
    expect(res.statusCode).toBe(200);

    const rows = await discovered(session);
    expect(rows.find((r) => r.candidateId === 'generic-5432')).toMatchObject({
      kind: 'unknown',
      transport: 'tcp',
      processCpuPercent: 37.5,
      processMemoryRssBytes: 64 * 1024 * 1024,
      processMetricsAt: observed,
    });
    expect(rows.find((r) => r.candidateId === 'generic-5433')).toMatchObject({
      processCpuPercent: null,
      processMemoryRssBytes: null,
      processMetricsAt: null,
    });
  });

  it('resets continuity on an owner-process restart and keeps lastRestartAt distinct from upSince', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'restart-host', V2_CAPS);
    const start1 = new Date(Date.now() - 3_600_000).toISOString();
    await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([candidate(8096, { process_started_at: start1 })]),
    });
    const service = await createServiceViaApi(h, session, {
      agentId: agent.agentId,
      candidateId: 'jellyfin-8096',
    });
    const id = service.id as string;
    const stored = await h.db.service.findUniqueOrThrow({ where: { id } });

    // Two healthy probes make it `up`.
    await sendServiceHeartbeat(h, agent, 2, {
      results: [resultPayload({ check_id: stored.checkId, config_revision: 1, ok: true })],
    });
    await sendServiceHeartbeat(h, agent, 3, {
      results: [resultPayload({
        check_id: stored.checkId,
        config_revision: 1,
        ok: true,
        observed_at: new Date(Date.now() + 1_000).toISOString(),
      })],
    });
    let row = await h.db.service.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('up');
    expect(row.upSince).not.toBeNull();

    // Owner process restarts: continuity must not survive it.
    const start2 = new Date(Date.now() - 60_000).toISOString();
    await sendServiceHeartbeat(h, agent, 4, {
      discovery: discoveryPayload([candidate(8096, { process_started_at: start2 })], {
        observed_at: new Date(Date.now() + 2_000).toISOString(),
      }),
    });
    row = await h.db.service.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('unknown');
    expect(row.upSince).toBeNull();
    expect(row.lastRestartAt).not.toBeNull();
    expect(row.consecutiveSuccesses).toBe(0);
    expect(row.processStartedAt?.toISOString()).toBe(new Date(start2).toISOString());

    // The API exposes both timestamps separately.
    const listed = await h.app.inject({
      method: 'GET',
      url: '/api/v1/services',
      headers: authHeaders(h.config, session),
    });
    const dto = (listed.json() as { services: Array<Record<string, unknown>> }).services[0];
    expect(dto?.lastRestartAt).not.toBeNull();
    expect(dto?.upSince).toBeNull();
  });
});

describe('derived service status', () => {
  it('reports degraded when the last probe failed before the threshold', () => {
    const now = new Date();
    const agent = { status: 'online' as const, lastSeenAt: now };
    const status = computeServiceStatus(
      {
        enabled: true,
        status: 'up',
        lastCheckedAt: new Date(now.getTime() - 5_000),
        intervalSeconds: 30,
        consecutiveFailures: 1,
      },
      agent,
      h.config,
      now,
    );
    expect(status).toBe('degraded');
  });

  it('never claims up from missing or stale data', () => {
    const now = new Date();
    const agent = { status: 'online' as const, lastSeenAt: now };
    expect(
      computeServiceStatus(
        { enabled: true, status: 'up', lastCheckedAt: null, intervalSeconds: 30, consecutiveFailures: 0 },
        agent,
        h.config,
        now,
      ),
    ).toBe('unknown');
    expect(
      computeServiceStatus(
        {
          enabled: true,
          status: 'up',
          lastCheckedAt: new Date(now.getTime() - 3 * 3_600_000),
          intervalSeconds: 30,
          consecutiveFailures: 0,
        },
        agent,
        h.config,
        now,
      ),
    ).toBe('unknown');
    expect(
      computeServiceStatus(
        { enabled: true, status: 'up', lastCheckedAt: new Date(now.getTime() - 5_000), intervalSeconds: 30, consecutiveFailures: 0 },
        { status: 'offline', lastSeenAt: null },
        h.config,
        now,
      ),
    ).toBe('unknown');
  });
});

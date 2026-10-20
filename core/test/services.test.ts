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
import { computeAvailability } from '../src/services/availability.js';
import { computeServiceStatus } from '../src/services/service.js';

let h: Harness;

const CAPS = ['metrics', 'service_discovery', 'http_checks'];

beforeEach(async () => {
  h = await createHarness();
  await resetDb(h.db);
});

afterEach(async () => {
  await h.close();
});

interface Monitored {
  session: Session;
  agent: EnrolledAgent;
  service: Record<string, unknown>;
  id: string;
  checkId: string;
}

async function discoveredThenMonitored(
  port = 8096,
  options: { path?: string; statuses?: number[]; intervalSeconds?: number } = {},
): Promise<Monitored> {
  const { session, agent } = await bootstrapAndEnroll(h, `host-${port}`, CAPS);
  const res = await sendServiceHeartbeat(h, agent, 1, {
    discovery: discoveryPayload([candidate(port)]),
  });
  expect(res.statusCode).toBe(200);
  const service = await createServiceViaApi(h, session, {
    agentId: agent.agentId,
    candidateId: `jellyfin-${port}`,
    ...(options.path ? { path: options.path } : {}),
    ...(options.statuses ? { expectedStatuses: options.statuses } : {}),
    ...(options.intervalSeconds ? { intervalSeconds: options.intervalSeconds } : {}),
  });
  const id = service.id as string;
  const stored = await h.db.service.findUniqueOrThrow({ where: { id } });
  return { session, agent, service, id, checkId: stored.checkId };
}

async function listServices(session: Session): Promise<Array<Record<string, unknown>>> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/services',
    headers: authHeaders(h.config, session),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { services: Array<Record<string, unknown>> }).services;
}

describe('service discovery ingest', () => {
  it('persists candidates with stable identity and exposes them to the UI', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'discover-host', CAPS);
    const res = await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([
        candidate(8096),
        candidate(3773, {
          candidate_id: 't3-code-3773',
          name: 'T3 Code',
          kind: 't3-code',
          source: 'proc',
          confidence: 'high',
          suggested_path: '/',
          suggested_statuses: [200],
        }),
        candidate(9999, {
          candidate_id: 'unknown-9999',
          name: 'Nierozpoznana usługa',
          kind: 'unknown',
          transport: 'tcp',
          source: 'proc',
          confidence: 'low',
          suggested_path: null,
          suggested_statuses: [],
        }),
      ]),
    });
    expect(res.statusCode).toBe(200);

    const listed = await h.app.inject({
      method: 'GET',
      url: '/api/v1/services/discovered',
      headers: authHeaders(h.config, session),
    });
    expect(listed.statusCode).toBe(200);
    const candidates = (listed.json() as { candidates: Array<Record<string, unknown>> }).candidates;
    expect(candidates).toHaveLength(3);
    expect(candidates.find((c) => c.candidateId === 'jellyfin-8096')).toMatchObject({
      agentId: agent.agentId,
      agentHostname: 'discover-host',
      name: 'Jellyfin',
      kind: 'jellyfin',
      port: 8096,
      transport: 'http',
      source: 'docker-proxy',
      confidence: 'medium',
      suggestedPath: '/Health',
      suggestedStatuses: [200],
      monitored: false,
      available: true,
    });
    const unknown = candidates.find((c) => c.candidateId === 'unknown-9999');
    expect(unknown).toMatchObject({ transport: 'tcp', suggestedPath: null });
  });

  it('never overwrites newer discovery with an older snapshot', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'ordering-host', CAPS);
    const newer = new Date(Date.now() + 5_000).toISOString();
    const older = new Date(Date.now() - 5_000).toISOString();

    await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([candidate(8096, { name: 'Jellyfin (new)' })], { observed_at: newer }),
    });
    await sendServiceHeartbeat(h, agent, 2, {
      discovery: discoveryPayload([candidate(8096, { name: 'Jellyfin (old)' })], { observed_at: older }),
    });

    const stored = await h.db.discoveredService.findFirstOrThrow({
      where: { agentId: agent.agentId, candidateId: 'jellyfin-8096' },
    });
    expect(stored.name).toBe('Jellyfin (new)');
    expect(stored.snapshotObservedAt.toISOString()).toBe(new Date(newer).toISOString());
  });

  it('marks vanished candidates unavailable only on a complete snapshot', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'vanish-host', CAPS);
    const first = new Date().toISOString();
    await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload(
        [candidate(8096), candidate(3773, { candidate_id: 't3-code-3773' })],
        { observed_at: first },
      ),
    });

    // Incomplete snapshot: nothing may be disabled.
    await sendServiceHeartbeat(h, agent, 2, {
      discovery: discoveryPayload([candidate(8096)], {
        observed_at: new Date(Date.now() + 1_000).toISOString(),
        complete: false,
      }),
    });
    let rows = await h.db.discoveredService.findMany({ where: { agentId: agent.agentId } });
    expect(rows.every((row) => row.available)).toBe(true);

    // Complete snapshot without 3773: it becomes unavailable, the other stays.
    await sendServiceHeartbeat(h, agent, 3, {
      discovery: discoveryPayload([candidate(8096)], {
        observed_at: new Date(Date.now() + 2_000).toISOString(),
        complete: true,
      }),
    });
    rows = await h.db.discoveredService.findMany({ where: { agentId: agent.agentId } });
    expect(rows.find((row) => row.candidateId === 't3-code-3773')?.available).toBe(false);
    expect(rows.find((row) => row.candidateId === 'jellyfin-8096')?.available).toBe(true);
  });

  it('returns an empty check set to old agents without the http_checks capability', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'old-agent', ['metrics']);
    const cfg = await h.app.inject({
      method: 'GET',
      url: '/api/v1/agent/config',
      headers: agentHeaders(agent),
    });
    expect(cfg.statusCode).toBe(200);
    expect((cfg.json() as Record<string, unknown>).service_checks).toEqual([]);
  });

  it('upgrades persisted capabilities from the additive heartbeat field', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'caps-host', ['metrics']);
    const before = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(before.capabilities).toEqual(['metrics']);
    const rejected = await sendHeartbeat(h, agent, heartbeatPayload(1, { capabilities: ['unknown-cap'] }));
    expect(rejected.statusCode).toBe(400);

    const res = await sendHeartbeat(h, agent, heartbeatPayload(1, {
      capabilities: ['metrics', 'service_discovery', 'http_checks'],
    }));
    expect(res.statusCode).toBe(200);
    const after = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(after.capabilities).toEqual(['metrics', 'service_discovery', 'http_checks']);
  });
});

describe('service config API', () => {
  it('creates a service from a discovered candidate and bumps the agent config', async () => {
    const { agent, service, checkId } = await discoveredThenMonitored(8096);
    expect(service).toMatchObject({
      agentHostname: 'host-8096',
      candidateId: 'jellyfin-8096',
      name: 'Jellyfin',
      port: 8096,
      path: '/Health',
      expectedStatuses: [200],
      intervalSeconds: 30,
      timeoutSeconds: 5,
      enabled: true,
      status: 'unknown',
      availabilityPercent: null,
      consecutiveFailures: 0,
      configRevision: 1,
    });
    expect(service.lastCheckedAt).toBeNull();

    const stored = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(stored.configVersion).toBe(2);

    const cfg = await h.app.inject({
      method: 'GET',
      url: '/api/v1/agent/config',
      headers: agentHeaders(agent),
    });
    const body = cfg.json() as {
      config_version: number;
      service_checks: Array<Record<string, unknown>>;
    };
    expect(body.config_version).toBe(2);
    expect(body.service_checks).toHaveLength(1);
    expect(body.service_checks[0]).toMatchObject({
      check_id: checkId,
      config_revision: 1,
      candidate_id: 'jellyfin-8096',
      port: 8096,
      path: '/Health',
      expected_statuses: [200],
      interval_s: 30,
      timeout_s: 5,
      enabled: true,
    });
  });

  it('rejects unknown/unavailable candidates and requires a path for unknown listeners', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'api-host', CAPS);
    await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([
        candidate(9999, {
          candidate_id: 'unknown-9999',
          kind: 'unknown',
          transport: 'tcp',
          suggested_path: null,
          suggested_statuses: [],
        }),
      ]),
    });

    const missingPath = await h.app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: authHeaders(h.config, session),
      payload: { agentId: agent.agentId, candidateId: 'unknown-9999' },
    });
    expect(missingPath.statusCode).toBe(400);
    expect(missingPath.json()).toMatchObject({ code: 'PATH_REQUIRED' });

    const unknownCandidate = await h.app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: authHeaders(h.config, session),
      payload: { agentId: agent.agentId, candidateId: 'jellyfin-1', path: '/' },
    });
    expect(unknownCandidate.statusCode).toBe(404);
    expect(unknownCandidate.json()).toMatchObject({ code: 'CANDIDATE_NOT_FOUND' });

    // Explicit path lets the operator opt an unknown listener into HTTP.
    const explicit = await createServiceViaApi(h, session, {
      agentId: agent.agentId,
      candidateId: 'unknown-9999',
      path: '/',
      expectedStatuses: [200],
    });
    expect(explicit).toMatchObject({ path: '/', expectedStatuses: [200] });
  });

  it('validates paths strictly and never accepts a host or absolute URL', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'path-host', CAPS);
    await sendServiceHeartbeat(h, agent, 1, { discovery: discoveryPayload([candidate(8096)]) });

    for (const path of ['//evil', 'http://evil.test/', '/a@b', '/a\\b', '/a b', 'relative']) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/services',
        headers: authHeaders(h.config, session),
        payload: { agentId: agent.agentId, candidateId: 'jellyfin-8096', path },
      });
      expect(res.statusCode, path).toBe(400);
    }

    const badInterval = await h.app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: authHeaders(h.config, session),
      payload: { agentId: agent.agentId, candidateId: 'jellyfin-8096', intervalSeconds: 10 },
    });
    expect(badInterval.statusCode).toBe(400);

    const badTimeout = await h.app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: authHeaders(h.config, session),
      payload: { agentId: agent.agentId, candidateId: 'jellyfin-8096', intervalSeconds: 30, timeoutSeconds: 30 },
    });
    expect(badTimeout.statusCode).toBe(400);
  });

  it('requires authentication, CSRF and same-origin for mutations', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'auth-host', CAPS);
    await sendServiceHeartbeat(h, agent, 1, { discovery: discoveryPayload([candidate(8096)]) });

    const unauthenticated = await h.app.inject({
      method: 'POST',
      url: '/api/v1/services',
      payload: { agentId: agent.agentId, candidateId: 'jellyfin-8096' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const noCsrf = await h.app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: { cookie: `sp_session=${session.cookie}`, origin: 'http://localhost:8080' },
      payload: { agentId: agent.agentId, candidateId: 'jellyfin-8096' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ code: 'CSRF_INVALID' });

    const foreignOrigin = await h.app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: { ...authHeaders(h.config, session), origin: 'http://evil.test' },
      payload: { agentId: agent.agentId, candidateId: 'jellyfin-8096' },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });

    const reads = await h.app.inject({ method: 'GET', url: '/api/v1/services' });
    expect(reads.statusCode).toBe(401);
    const discovery = await h.app.inject({ method: 'GET', url: '/api/v1/services/discovered' });
    expect(discovery.statusCode).toBe(401);
  });

  it('does not allow duplicate targets for one candidate (including a create race)', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'race-host', CAPS);
    await sendServiceHeartbeat(h, agent, 1, { discovery: discoveryPayload([candidate(8096)]) });

    const [first, second] = await Promise.all([
      h.app.inject({
        method: 'POST',
        url: '/api/v1/services',
        headers: authHeaders(h.config, session),
        payload: { agentId: agent.agentId, candidateId: 'jellyfin-8096' },
      }),
      h.app.inject({
        method: 'POST',
        url: '/api/v1/services',
        headers: authHeaders(h.config, session),
        payload: { agentId: agent.agentId, candidateId: 'jellyfin-8096' },
      }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    await expect(h.db.service.count()).resolves.toBe(1);
  });

  it('rejects a service for a revoked agent', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'revoked-host', CAPS);
    await sendServiceHeartbeat(h, agent, 1, { discovery: discoveryPayload([candidate(8096)]) });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.agentId}/revoke`,
      headers: authHeaders(h.config, session),
      payload: {},
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: authHeaders(h.config, session),
      payload: { agentId: agent.agentId, candidateId: 'jellyfin-8096' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'AGENT_REVOKED' });
  });

  it('PATCH updates fields, bumps revision and resets the horizon on target changes', async () => {
    const { session, agent, service, id } = await discoveredThenMonitored(8096);

    const renamed = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: authHeaders(h.config, session),
      payload: { name: 'Jellyfin (dom)' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { service: Record<string, unknown> }).service).toMatchObject({
      name: 'Jellyfin (dom)',
      configRevision: 1,
    });

    const retargeted = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: authHeaders(h.config, session),
      payload: { path: '/System/Info/Public' },
    });
    expect(retargeted.statusCode).toBe(200);
    expect((retargeted.json() as { service: Record<string, unknown> }).service).toMatchObject({
      path: '/System/Info/Public',
      configRevision: 2,
      status: 'unknown',
      availabilityPercent: null,
    });

    const paused = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: authHeaders(h.config, session),
      payload: { enabled: false },
    });
    expect((paused.json() as { service: Record<string, unknown> }).service).toMatchObject({
      enabled: false,
      status: 'paused',
      configRevision: 3,
    });

    const stored = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(stored.configVersion).toBe(5);

    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/services/${id}`,
      headers: authHeaders(h.config, session),
    });
    expect(removed.statusCode).toBe(204);
    await expect(h.db.service.count()).resolves.toBe(0);
    expect(service.id).toBe(id);
  });

  it('rejects PATCH fields that are not editable and 404s unknown ids', async () => {
    const { session, id } = await discoveredThenMonitored(8096);
    const bad = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: authHeaders(h.config, session),
      payload: { port: 1234 },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/services/svc_nope',
      headers: authHeaders(h.config, session),
      payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects an HTTP path on a TCP target instead of silently ignoring it', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'tcp-patch-host', [...CAPS, 'tcp_checks']);
    const discovery = await sendServiceHeartbeat(h, agent, 1, {
      discovery: discoveryPayload([
        candidate(5432, {
          candidate_id: 'generic-5432',
          name: 'Moja baza',
          kind: 'unknown',
          transport: 'tcp',
          source: 'proc',
          confidence: 'low',
          monitorable: true,
          name_source: 'package-json',
          suggested_path: null,
          suggested_statuses: [],
        }),
      ]),
    });
    expect(discovery.statusCode).toBe(200);

    const service = await createServiceViaApi(h, session, {
      agentId: agent.agentId,
      candidateId: 'generic-5432',
    });
    const id = service.id as string;
    expect(service).toMatchObject({ transport: 'tcp', path: '', expectedStatuses: [] });

    // `path` means nothing for a TCP check: 400, never a silent no-op.
    const rejected = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: authHeaders(h.config, session),
      payload: { path: '/health' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ code: 'INVALID_BODY' });

    // The rejected patch left the service byte-identical and wrote no audit row.
    const stored = await h.db.service.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({
      transport: 'tcp',
      path: '',
      expectedStatuses: [],
      configRevision: 1,
      enabled: true,
      status: 'unknown',
    });
    await expect(
      h.db.auditLog.count({ where: { action: 'service.update', target: id } }),
    ).resolves.toBe(0);

    // Ordinary TCP edits still work: rename, then pause.
    const renamed = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: authHeaders(h.config, session),
      payload: { name: 'Moja baza (TCP)' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { service: Record<string, unknown> }).service)
      .toMatchObject({ name: 'Moja baza (TCP)', path: '', transport: 'tcp' });

    const paused = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: authHeaders(h.config, session),
      payload: { enabled: false },
    });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as { service: Record<string, unknown> }).service)
      .toMatchObject({ enabled: false, status: 'paused', transport: 'tcp' });
  });
});

describe('service results ingest and status', () => {
  it('stores immutable results, dedupes retried envelopes and survives Core restart', async () => {
    const { agent, id, checkId } = await discoveredThenMonitored(8096);
    const observedAt = new Date().toISOString();

    const res = await sendServiceHeartbeat(h, agent, 2, {
      results: [resultPayload({ check_id: checkId, config_revision: 1, observed_at: observedAt, ok: true })],
    });
    expect(res.statusCode).toBe(200);

    // Retry of the same seq is rejected and adds no history row.
    const duplicate = await sendServiceHeartbeat(h, agent, 2, {
      results: [resultPayload({ check_id: checkId, config_revision: 1, observed_at: observedAt, ok: false })],
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'STALE_SEQ' });

    // A new seq carrying the same observation is deduped by check+time.
    await sendServiceHeartbeat(h, agent, 3, {
      results: [resultPayload({ check_id: checkId, config_revision: 1, observed_at: observedAt, ok: true })],
    });
    await expect(h.db.serviceResult.count({ where: { serviceId: id } })).resolves.toBe(1);

    const restarted = await createHarness();
    try {
      const rows = await restarted.db.serviceResult.count();
      expect(rows).toBe(1);
    } finally {
      await restarted.close();
    }
  });

  it('rejects forged results from another agent without touching history', async () => {
    const { session, agent, checkId } = await discoveredThenMonitored(8096);
    const otherToken = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agents/pairing-tokens',
      headers: authHeaders(h.config, session),
      payload: {},
    });
    const other = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      headers: { 'agent-protocol-version': '1' },
      payload: {
        enroll_token: (otherToken.json() as { token: string }).token,
        hostname: 'attacker-host',
        protocol_version: 1,
        capabilities: CAPS,
      },
    });
    const otherBody = other.json() as { agent_id: string; credential: string };

    const forged = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/heartbeat',
      headers: {
        'agent-protocol-version': '1',
        'x-agent-id': otherBody.agent_id,
        authorization: `Bearer ${otherBody.credential}`,
      },
      payload: heartbeatPayload(1, {
        service_results: [
          resultPayload({ check_id: checkId, config_revision: 1, ok: true }),
        ],
      }),
    });
    expect(forged.statusCode).toBe(200);
    await expect(h.db.serviceResult.count()).resolves.toBe(0);

    const audits = await h.db.auditLog.findMany({ where: { action: 'service.result_discarded' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ reason: 'UNKNOWN_CHECK', agentId: otherBody.agent_id });
    expect(agent.agentId).not.toBe(otherBody.agent_id);
  });

  it('discards stale config revisions and audits them', async () => {
    const { agent, checkId } = await discoveredThenMonitored(8096);
    const res = await sendServiceHeartbeat(h, agent, 2, {
      results: [resultPayload({ check_id: checkId, config_revision: 99, ok: true })],
    });
    expect(res.statusCode).toBe(200);
    await expect(h.db.serviceResult.count()).resolves.toBe(0);
    const audit = await h.db.auditLog.findFirstOrThrow({
      where: { action: 'service.result_discarded' },
    });
    expect(audit.detail).toMatchObject({ reason: 'STALE_CONFIG_REVISION', configRevision: 99 });
  });

  it('opens one incident at N failures and resolves at M successes', async () => {
    const { session, agent, id, checkId } = await discoveredThenMonitored(8096);
    let seq = 2;
    const base = Date.now() - 20 * 60_000;

    const send = async (ok: boolean): Promise<void> => {
      const observed = new Date(base + seq * 30_000).toISOString();
      const res = await sendServiceHeartbeat(h, agent, seq, {
        results: [resultPayload({
          check_id: checkId,
          config_revision: 1,
          observed_at: observed,
          ok,
          status_code: ok ? 200 : 503,
          error_code: ok ? null : 'UNEXPECTED_STATUS',
        })],
      });
      expect(res.statusCode).toBe(200);
      seq += 1;
    };

    await send(false);
    await send(false);
    let row = await h.db.service.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('unknown');
    expect(row.consecutiveFailures).toBe(2);
    await expect(h.db.serviceIncident.count()).resolves.toBe(0);

    await send(false);
    row = await h.db.service.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('down');
    expect(row.upSince).toBeNull();
    await expect(h.db.serviceIncident.count({ where: { resolvedAt: null } })).resolves.toBe(1);

    // Further failures never open a second incident.
    await send(false);
    await expect(h.db.serviceIncident.count()).resolves.toBe(1);

    await send(true);
    row = await h.db.service.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('down');
    expect(row.consecutiveSuccesses).toBe(1);

    await send(true);
    row = await h.db.service.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('up');
    expect(row.upSince).not.toBeNull();
    const incident = await h.db.serviceIncident.findFirstOrThrow({ where: { serviceId: id } });
    expect(incident.resolvedAt).not.toBeNull();

    const history = await h.app.inject({
      method: 'GET',
      url: `/api/v1/services/${id}/history?limit=100`,
      headers: authHeaders(h.config, session),
    });
    expect(history.statusCode).toBe(200);
    const body = history.json() as {
      results: Array<Record<string, unknown>>;
      incidents: Array<Record<string, unknown>>;
    };
    expect(body.results).toHaveLength(6);
    expect(body.results[0]?.ok).toBe(false);
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0]?.reason).toBe('HTTP_CHECK_FAILED');
  });

  it('resets the streak on a gap larger than two intervals instead of bridging it', async () => {
    const { agent, id, checkId } = await discoveredThenMonitored(8096, { intervalSeconds: 30 });
    const start = Date.now() - 5 * 60_000;

    await sendServiceHeartbeat(h, agent, 2, {
      results: [resultPayload({
        check_id: checkId, config_revision: 1, observed_at: new Date(start).toISOString(), ok: false,
      })],
    });
    await sendServiceHeartbeat(h, agent, 3, {
      results: [resultPayload({
        check_id: checkId, config_revision: 1, observed_at: new Date(start + 61_000).toISOString(), ok: false,
      })],
    });
    const row = await h.db.service.findUniqueOrThrow({ where: { id } });
    // The 61s gap is > 2×30s, so the second observation starts a new streak.
    expect(row.consecutiveFailures).toBe(1);
    expect(row.status).toBe('unknown');
  });

  it('ignores results for a paused check and re-enables cleanly', async () => {
    const { session, agent, id, checkId } = await discoveredThenMonitored(8096);
    const paused = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: authHeaders(h.config, session),
      payload: { enabled: false },
    });
    const pausedService = (paused.json() as { service: Record<string, unknown> }).service;
    expect(pausedService.configRevision).toBe(2);

    const res = await sendServiceHeartbeat(h, agent, 2, {
      results: [resultPayload({ check_id: checkId, config_revision: 1, ok: false })],
    });
    expect(res.statusCode).toBe(200);
    await expect(h.db.serviceResult.count()).resolves.toBe(0);
    const audit = await h.db.auditLog.findFirstOrThrow({
      where: { action: 'service.result_discarded' },
    });
    // The revision moved on pause; an old-revision result is rejected first.
    expect(audit.detail).toMatchObject({ reason: 'STALE_CONFIG_REVISION' });

    // The current revision for a disabled check is discarded as disabled.
    await sendServiceHeartbeat(h, agent, 3, {
      results: [resultPayload({ check_id: checkId, config_revision: 2, ok: false })],
    });
    const disabled = await h.db.auditLog.findFirstOrThrow({
      where: { action: 'service.result_discarded', detail: { path: ['reason'], equals: 'CHECK_DISABLED' } },
    });
    expect(disabled.detail).toMatchObject({ reason: 'CHECK_DISABLED' });
  });
});

describe('availability and honest status', () => {
  it('reports null availability and unknown status until M successes are met', async () => {
    const { session, agent, id, checkId } = await discoveredThenMonitored(8096);
    // Move the measurement horizon back so the samples below are in-window.
    await h.db.service.update({
      where: { id },
      data: { horizonAt: new Date(Date.now() - 10 * 60_000) },
    });
    const base = Date.now() - 35_000;
    await sendServiceHeartbeat(h, agent, 2, {
      results: [resultPayload({
        check_id: checkId,
        config_revision: 1,
        ok: true,
        observed_at: new Date(base).toISOString(),
      })],
    });
    let dto = (await listServices(session)).find((item) => item.id === id);
    // M=2: one success is not yet a healthy streak, and one sample cannot
    // produce a measured percentage.
    expect(dto).toMatchObject({ availabilityPercent: null, status: 'unknown' });

    await sendServiceHeartbeat(h, agent, 3, {
      results: [resultPayload({
        check_id: checkId,
        config_revision: 1,
        ok: true,
        observed_at: new Date(base + 30_000).toISOString(),
      })],
    });
    dto = (await listServices(session)).find((item) => item.id === id);
    expect(dto).toMatchObject({ status: 'up', availabilityPercent: 100 });
    expect(dto?.observedSeconds).toBeGreaterThan(0);
  });

  it('computes a measured percentage over completed intervals only', () => {
    const start = new Date('2026-10-19T10:00:00Z');
    const samples = [
      { observedAt: start, ok: true },
      { observedAt: new Date(start.getTime() + 30_000), ok: true },
      { observedAt: new Date(start.getTime() + 60_000), ok: false },
      // A gap to 10:10 is > 2×30s and must be unknown, not counted.
      { observedAt: new Date(start.getTime() + 600_000), ok: true },
    ];
    const result = computeAvailability(
      samples,
      start,
      new Date(start.getTime() + 630_000),
      30,
    );
    // Covered: 30s up + 30s up; the long gap is unknown. 60/60 = 100%.
    expect(result.observedSeconds).toBe(60);
    expect(result.percent).toBe(100);
    expect(result.unknownSeconds).toBe(570);
  });

  it('never credits a silent tail as uptime', () => {
    const start = new Date('2026-10-19T10:00:00Z');
    const samples = [
      { observedAt: start, ok: true },
      { observedAt: new Date(start.getTime() + 30_000), ok: true },
    ];
    const result = computeAvailability(samples, start, new Date(start.getTime() + 3_600_000), 30);
    expect(result.percent).toBe(100);
    expect(result.observedSeconds).toBe(30);
    expect(result.unknownSeconds).toBe(3570);
  });

  it('treats agent disconnect as unknown, keeping incidents open', async () => {
    const { session, agent, id, checkId } = await discoveredThenMonitored(8096);
    const base = Date.now() - 20 * 60_000;

    for (let i = 0; i < 3; i += 1) {
      await sendServiceHeartbeat(h, agent, 2 + i, {
        results: [resultPayload({
          check_id: checkId,
          config_revision: 1,
          observed_at: new Date(base + i * 30_000).toISOString(),
          ok: false,
        })],
      });
    }
    const row = await h.db.service.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('down');

    // Disconnect the agent.
    await h.db.agent.update({
      where: { id: agent.agentId },
      data: { lastSeenAt: new Date(Date.now() - 120_000) },
    });
    const dto = (await listServices(session)).find((item) => item.id === id);
    expect(dto).toMatchObject({ status: 'unknown', availabilityPercent: null });
    // Missing observations are not recovery.
    await expect(h.db.serviceIncident.count({ where: { serviceId: id, resolvedAt: null } }))
      .resolves.toBe(1);
    expect(row.status).toBe('down');
  });

  it('shows paused for disabled services and unknown before any sample', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const config = { agentStaleSeconds: 45, agentOfflineSeconds: 300 } as never;
    const agent = { status: 'online' as const, lastSeenAt: now };
    expect(computeServiceStatus(
      { enabled: false, status: 'up', lastCheckedAt: now, intervalSeconds: 30 },
      agent,
      config,
      now,
    )).toBe('paused');
    expect(computeServiceStatus(
      { enabled: true, status: 'up', lastCheckedAt: null, intervalSeconds: 30 },
      agent,
      config,
      now,
    )).toBe('unknown');
  });
});


describe('service integration guards', () => {
  it('rejects future evidence atomically and retains custom thresholds on rename', async () => {
    const { session, agent, id, checkId } = await discoveredThenMonitored();
    const future = new Date(Date.now() + 120_000).toISOString();
    const response = await sendServiceHeartbeat(h, agent, 2, {
      results: [resultPayload({ check_id: checkId, config_revision: 1, observed_at: future, ok: true })],
    });
    expect(response.statusCode).toBe(400);
    await expect(h.db.serviceResult.count()).resolves.toBe(0);
    const row = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(row.lastSeq).toBe(1n);
    const patch = (payload: Record<string, unknown>) => h.app.inject({
      method: 'PATCH', url: `/api/v1/services/${id}`, headers: authHeaders(h.config, session), payload,
    });
    await patch({ failureThreshold: 7, successThreshold: 4 });
    const renamed = await patch({ name: 'Retained thresholds' });
    expect(renamed.json().service).toMatchObject({ failureThreshold: 7, successThreshold: 4 });
  });

  it('clips measured coverage to the window and excludes future intervals', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const sample = (offset: number) => ({ observedAt: new Date(now.getTime() + offset * 1000), ok: true });
    expect(computeAvailability([sample(-60), sample(-30), sample(30)],
      new Date(now.getTime() - 45_000), now, 30)).toEqual({
      percent: 100, observedSeconds: 15, unknownSeconds: 30,
    });
  });
});

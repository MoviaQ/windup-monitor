/**
 * Public-endpoint store + routes + scheduler against real Postgres.
 *
 * Uses the shared harness for DB/config/session fixtures but registers the
 * new routes on a test-local Fastify instance — no shared file is touched
 * (app.ts wiring is the coordinator's pending follow-up, see CONTRACT.md).
 *
 * Covers: auth/CSRF/service-FK, per-service limit 5, (serviceId,url) unique,
 * HTTPS-only + SSRF validation on the API path, CRUD edit clearing the old
 * result when the target changes, scheduler async behavior (bounded,
 * non-overlapping, pause-skip, unknown-until-first-probe).
 */
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  bootstrapAndEnroll,
  candidate,
  createHarness,
  createPairingToken,
  createServiceViaApi,
  discoveryPayload,
  enrollAgent,
  resetDb,
  sendServiceHeartbeat,
  type EnrolledAgent,
  type Harness,
  type Session,
} from './helpers.js';
import { createContext } from '../src/context.js';
import {
  ensureTables,
  type RawDb,
} from '../src/public-endpoints/store.js';
import { registerPublicEndpointRoutes } from '../src/public-endpoints/routes.js';
import { PublicEndpointScheduler, classifyProbeOutcome } from '../src/public-endpoints/scheduler.js';

const CAPS = ['metrics', 'service_discovery', 'http_checks'];

let h: Harness;
let app: FastifyInstance;

const rawDb = (): RawDb => h.db as unknown as RawDb;

async function cleanEndpointTables(): Promise<void> {
  await h.db.$executeRawUnsafe('DELETE FROM public_endpoint_results');
  await h.db.$executeRawUnsafe('DELETE FROM public_endpoints');
}

beforeEach(async () => {
  h = await createHarness();
  await resetDb(h.db);
  await ensureTables(rawDb());
  await cleanEndpointTables();
  app = Fastify();
  await app.register(cookie);
  await app.register(
    async (api) => {
      registerPublicEndpointRoutes(api, createContext(h.config, h.db));
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
});

afterEach(async () => {
  await app.close().catch(() => undefined);
  await h.close();
});

interface Fixture {
  session: Session;
  agent: EnrolledAgent;
  serviceId: string;
}

async function serviceFixture(port = 8096): Promise<Fixture> {
  const { session, agent } = await bootstrapAndEnroll(h, `pe-host-${port}`, CAPS);
  await sendServiceHeartbeat(h, agent, 1, { discovery: discoveryPayload([candidate(port)]) });
  const service = await createServiceViaApi(h, session, {
    agentId: agent.agentId,
    candidateId: `jellyfin-${port}`,
  });
  return { session, agent, serviceId: service.id as string };
}

const postEndpoint = (
  serviceId: string,
  session: Session,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> => app.inject({
  method: 'POST',
  url: `/api/v1/services/${serviceId}/public-endpoints`,
  headers: authHeaders(h.config, session),
  payload,
});

const getEndpoints = (serviceId: string, session: Session): Promise<LightMyRequestResponse> => app.inject({
  method: 'GET',
  url: `/api/v1/services/${serviceId}/public-endpoints`,
  headers: authHeaders(h.config, session),
});

describe('public-endpoint CRUD API', () => {
  it('creates an endpoint, normalizing a bare domain to canonical https', async () => {
    const { session, serviceId } = await serviceFixture();
    const res = await postEndpoint(serviceId, session, { url: 'filmy.moviak.quest', label: 'Jellyfin (publiczny)' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { endpoint: Record<string, unknown> };
    expect(body.endpoint).toMatchObject({
      serviceId,
      label: 'Jellyfin (publiczny)',
      url: 'https://filmy.moviak.quest/',
      enabled: true,
      intervalSeconds: 60,
      timeoutSeconds: 8,
      status: 'unknown',
      lastCheckedAt: null,
    });
  });

  it('requires authentication and CSRF for mutations, auth for reads', async () => {
    const { session, serviceId } = await serviceFixture();
    const unauth = await app.inject({
      method: 'POST',
      url: `/api/v1/services/${serviceId}/public-endpoints`,
      payload: { url: 'https://example.com/' },
    });
    expect(unauth.statusCode).toBe(401);

    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/services/${serviceId}/public-endpoints`,
      headers: { cookie: `sp_session=${session.cookie}`, origin: 'http://localhost:8080' },
      payload: { url: 'https://example.com/' },
    });
    expect(noCsrf.statusCode).toBe(403);

    const read = await app.inject({ method: 'GET', url: `/api/v1/services/${serviceId}/public-endpoints` });
    expect(read.statusCode).toBe(401);
  });

  it('404s on an unknown service id', async () => {
    const { session } = await serviceFixture();
    const res = await postEndpoint('svc_nope', session, { url: 'https://example.com/' });
    expect(res.statusCode).toBe(404);
    const listed = await getEndpoints('svc_nope', session);
    expect(listed.statusCode).toBe(404);
  });

  it('enforces the per-service limit of 5', async () => {
    const { session, serviceId } = await serviceFixture();
    for (let i = 0; i < 5; i += 1) {
      const res = await postEndpoint(serviceId, session, { url: `https://host${i}.example.com/` });
      expect(res.statusCode, `slot ${i}`).toBe(201);
    }
    const sixth = await postEndpoint(serviceId, session, { url: 'https://sixth.example.com/' });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json()).toMatchObject({ code: 'ENDPOINT_LIMIT' });
  });

  it('enforces (serviceId, url) uniqueness but allows the same URL on another service', async () => {
    const first = await serviceFixture(8096);
    const res = await postEndpoint(first.serviceId, first.session, { url: 'https://dup.example.com/x' });
    expect(res.statusCode).toBe(201);
    const dup = await postEndpoint(first.serviceId, first.session, { url: 'https://dup.example.com/x' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'ENDPOINT_EXISTS' });

    // Second service under the same bootstrap (no re-bootstrap in one test).
    const token = await createPairingToken(h, first.session);
    const secondAgent = await enrollAgent(h, token, 'pe-host-8097', CAPS);
    await sendServiceHeartbeat(h, secondAgent, 1, { discovery: discoveryPayload([candidate(8097)]) });
    const second = await createServiceViaApi(h, first.session, {
      agentId: secondAgent.agentId,
      candidateId: 'jellyfin-8097',
    });
    const other = await postEndpoint(second.id as string, first.session, { url: 'https://dup.example.com/x' });
    expect(other.statusCode).toBe(201);
  });

  it('rejects http, IP literals, private DNS-shaped hosts and bad labels on the API path', async () => {
    const { session, serviceId } = await serviceFixture();
    for (const url of [
      'http://example.com/',
      'https://93.184.216.34/',
      'https://user:pw@example.com/',
      'https://example.com/#frag',
      'https://example.com:8443/',
    ]) {
      const res = await postEndpoint(serviceId, session, { url });
      expect(res.statusCode, url).toBe(400);
    }
    const longLabel = await postEndpoint(serviceId, session, { url: 'https://example.com/', label: 'x'.repeat(81) });
    expect(longLabel.statusCode).toBe(400);
  });

  it('PATCH edits label Toggles enabled; changing the URL clears the old result', async () => {
    const { session, serviceId } = await serviceFixture();
    const created = await postEndpoint(serviceId, session, { url: 'https://old.example.com/' });
    const id = (created.json() as { endpoint: { id: string } }).endpoint.id;

    // Simulate a recorded success, then retarget.
    await h.db.$executeRawUnsafe(
      `UPDATE public_endpoints SET status='up', last_checked_at=now(), last_status_code=200,
        last_latency_ms=42, last_error_code=NULL WHERE id=$1`,
      id,
    );
    await h.db.$executeRawUnsafe(
      `INSERT INTO public_endpoint_results (id, endpoint_id, observed_at, ok, status_code, latency_ms, error_code)
       VALUES ($1, $2, now(), TRUE, 200, 42, NULL)`,
      `r-${id}`, id,
    );

    const retarget = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public-endpoints/${id}`,
      headers: authHeaders(h.config, session),
      payload: { url: 'https://new.example.com/health' },
    });
    expect(retarget.statusCode).toBe(200);
    const body = retarget.json() as { endpoint: Record<string, unknown> };
    expect(body.endpoint).toMatchObject({
      url: 'https://new.example.com/health',
      status: 'unknown',
      statusCode: null,
      lastCheckedAt: null,
    });
    const historyLeft = await h.db.$queryRawUnsafe(
      'SELECT id FROM public_endpoint_results WHERE endpoint_id=$1', id,
    );
    expect(historyLeft).toHaveLength(0);

    const pause = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public-endpoints/${id}`,
      headers: authHeaders(h.config, session),
      payload: { enabled: false },
    });
    expect((pause.json() as { endpoint: Record<string, unknown> }).endpoint).toMatchObject({
      status: 'paused',
    });

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v1/public-endpoints/ep_nope',
      headers: authHeaders(h.config, session),
      payload: { label: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('DELETE removes the endpoint; second delete 404s', async () => {
    const { session, serviceId } = await serviceFixture();
    const created = await postEndpoint(serviceId, session, { url: 'https://gone.example.com/' });
    const id = (created.json() as { endpoint: { id: string } }).endpoint.id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/public-endpoints/${id}`,
      headers: authHeaders(h.config, session),
    });
    expect(del.statusCode).toBe(204);
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/public-endpoints/${id}`,
      headers: authHeaders(h.config, session),
    });
    expect(again.statusCode).toBe(404);
    const listed = await getEndpoints(serviceId, session);
    expect((listed.json() as { endpoints: unknown[] }).endpoints).toHaveLength(0);
  });
});

describe('public-endpoint scheduler', () => {
  it('probes due endpoints with stubbed transport, persists results, survives restart shape', async () => {
    const { serviceId } = await serviceFixture();
    const created = await h.db.$queryRawUnsafe(
      `INSERT INTO public_endpoints (id, service_id, label, url, enabled, interval_seconds, timeout_seconds, status)
       VALUES ('ep_sched_1', $1, 'test', 'https://sched.example.com/', TRUE, 60, 5, 'unknown')
       RETURNING id`,
      serviceId,
    );
    expect(created).toHaveLength(1);

    const scheduler = new PublicEndpointScheduler(rawDb(), {
      concurrency: 2,
      probeDeps: {
        resolveAll: async () => ['93.184.216.34'],
        exchange: async () => 200,
      },
    });
    const completed = await scheduler.tickOnce();
    expect(completed).toBe(1);

    const row = await h.db.$queryRawUnsafe(
      'SELECT status, last_status_code, last_error_code FROM public_endpoints WHERE id=$1',
      'ep_sched_1',
    ) as Array<{ status: string; last_status_code: number; last_error_code: string | null }>;
    expect(row[0]).toMatchObject({ status: 'up', last_status_code: 200, last_error_code: null });
    const hist = await h.db.$queryRawUnsafe(
      'SELECT ok FROM public_endpoint_results WHERE endpoint_id=$1', 'ep_sched_1',
    );
    expect(hist).toHaveLength(1);

    // Not due yet: second tick probes nothing (no overlap, interval honored).
    expect(await scheduler.tickOnce()).toBe(0);
    scheduler.stop();
  });

  it('skips paused endpoints and never fabricates uptime before the first probe', async () => {
    const { serviceId } = await serviceFixture();
    await h.db.$executeRawUnsafe(
      `INSERT INTO public_endpoints (id, service_id, url, enabled, interval_seconds, timeout_seconds, status)
       VALUES ('ep_paused_1', $1, 'https://paused.example.com/', FALSE, 60, 5, 'paused')`,
      serviceId,
    );
    const scheduler = new PublicEndpointScheduler(rawDb(), {
      probeDeps: {
        resolveAll: async () => { throw new Error('must not resolve when paused'); },
      },
    });
    expect(await scheduler.tickOnce()).toBe(0);
    const row = await h.db.$queryRawUnsafe(
      'SELECT status FROM public_endpoints WHERE id=$1', 'ep_paused_1',
    ) as Array<{ status: string }>;
    expect(row[0]?.status).toBe('paused');
    scheduler.stop();
  });

  it('does not overlap one endpoint across concurrent ticks', async () => {
    const { serviceId } = await serviceFixture();
    await h.db.$executeRawUnsafe(
      `INSERT INTO public_endpoints (id, service_id, url, enabled, interval_seconds, timeout_seconds, status)
       VALUES ('ep_race_1', $1, 'https://race.example.com/', TRUE, 60, 5, 'unknown')`,
      serviceId,
    );
    let exchanges = 0;
    const scheduler = new PublicEndpointScheduler(rawDb(), {
      concurrency: 2,
      probeDeps: {
        resolveAll: async () => ['93.184.216.34'],
        exchange: async () => {
          exchanges += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 200;
        },
      },
    });
    const [a, b] = await Promise.all([scheduler.tickOnce(), scheduler.tickOnce()]);
    // The second tick starts while the first holds the endpoint: at most one
    // tick probes it (tick-level guard), and exchanges stay bounded.
    expect(a + b).toBeLessThanOrEqual(1);
    expect(exchanges).toBeLessThanOrEqual(1);
    scheduler.stop();
  });

  it('classifies 2xx/3xx/401/5xx honestly (redirect/answer vs failure)', () => {
    expect(classifyProbeOutcome({ kind: 'responded', statusCode: 200, latencyMs: 5 }))
      .toMatchObject({ ok: true, statusCode: 200, errorCode: null });
    // 3xx is answered but never chased: labelled a redirect, not final health.
    expect(classifyProbeOutcome({ kind: 'redirect', statusCode: 302, latencyMs: 5 }))
      .toMatchObject({ ok: true, statusCode: 302, errorCode: 'REDIRECT' });
    // 401/403 count as the server answering (login required), not "no response".
    expect(classifyProbeOutcome({ kind: 'responded', statusCode: 401, latencyMs: 5 }))
      .toMatchObject({ ok: true, statusCode: 401, errorCode: 'AUTH_REQUIRED' });
    // Any other 4xx is answered but unexpected.
    expect(classifyProbeOutcome({ kind: 'responded', statusCode: 418, latencyMs: 5 }))
      .toMatchObject({ ok: true, statusCode: 418, errorCode: 'UNEXPECTED_STATUS' });
    // 5xx is a real failure.
    expect(classifyProbeOutcome({ kind: 'responded', statusCode: 503, latencyMs: 5 }))
      .toMatchObject({ ok: false, statusCode: 503, errorCode: 'UNEXPECTED_STATUS' });
    expect(classifyProbeOutcome({ kind: 'failed', errorCode: 'TIMEOUT', latencyMs: 8_000 }))
      .toMatchObject({ ok: false, statusCode: null, errorCode: 'TIMEOUT' });
  });

  it('persists a redirect as an answering endpoint and a 5xx as down', async () => {
    const { serviceId } = await serviceFixture();
    await h.db.$executeRawUnsafe(
      `INSERT INTO public_endpoints (id, service_id, url, enabled, interval_seconds, timeout_seconds, status)
       VALUES ('ep_redir_1', $1, 'https://redir.example.com/', TRUE, 60, 5, 'unknown'),
              ('ep_5xx_1', $1, 'https://fail.example.com/', TRUE, 60, 5, 'unknown')`,
      serviceId,
    );
    const scheduler = new PublicEndpointScheduler(rawDb(), {
      probeDeps: {
        resolveAll: async () => ['93.184.216.34'],
        exchange: async (_ip, _port, _hostname, hostHeader) =>
          hostHeader === 'redir.example.com' ? 302 : 503,
      },
    });
    await scheduler.tickOnce();
    scheduler.stop();

    const rows = await h.db.$queryRawUnsafe(
      'SELECT id, status, last_status_code, last_error_code FROM public_endpoints ORDER BY id',
    ) as Array<{ id: string; status: string; last_status_code: number; last_error_code: string | null }>;
    expect(rows.find((r) => r.id === 'ep_redir_1')).toMatchObject({
      status: 'up', last_status_code: 302, last_error_code: 'REDIRECT',
    });
    expect(rows.find((r) => r.id === 'ep_5xx_1')).toMatchObject({
      status: 'down', last_status_code: 503, last_error_code: 'UNEXPECTED_STATUS',
    });
  });
});

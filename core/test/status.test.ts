import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  bootstrapAndEnroll,
  bootstrapAdmin,
  createHarness,
  createPairingToken,
  enrollAgent,
  heartbeatPayload,
  resetDb,
  sendHeartbeat,
  type Harness,
} from './helpers.js';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  await resetDb(h.db);
});

afterEach(async () => {
  await h.close();
});

async function listAgents(session: { cookie: string; csrfToken: string }): Promise<Array<Record<string, unknown>>> {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/agents', headers: authHeaders(h.config, session) });
  expect(res.statusCode).toBe(200);
  return (res.json() as { agents: Array<Record<string, unknown>> }).agents;
}

describe('agent status derivation', () => {
  it('reports pending before the first heartbeat', async () => {
    const session = await bootstrapAdmin(h);
    const token = await createPairingToken(h, session);
    await enrollAgent(h, token, 'pending-host');

    const agents = await listAgents(session);
    expect(agents[0]).toMatchObject({ status: 'pending', lastSeenAt: null, metrics: null });
  });

  it('transitions online -> stale (46s) -> offline (>5min)', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'status-host');
    await sendHeartbeat(h, agent, heartbeatPayload(1));

    expect((await listAgents(session))[0]?.status).toBe('online');

    await h.db.agent.update({
      where: { id: agent.agentId },
      data: { lastSeenAt: new Date(Date.now() - 46_000) },
    });
    expect((await listAgents(session))[0]?.status).toBe('stale');

    await h.db.agent.update({
      where: { id: agent.agentId },
      data: { lastSeenAt: new Date(Date.now() - 301_000) },
    });
    expect((await listAgents(session))[0]?.status).toBe('offline');
  });

  it('revoked is terminal even with a fresh last_seen_at', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'revoked-host');
    await sendHeartbeat(h, agent, heartbeatPayload(1));
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.agentId}/revoke`,
      headers: authHeaders(h.config, session),
      payload: {},
    });
    expect((await listAgents(session))[0]?.status).toBe('revoked');
  });
});

describe('metrics history', () => {
  it('returns ascending bounded samples with disk aggregates', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'history-host');
    for (let seq = 1; seq <= 3; seq += 1) {
      const payload = heartbeatPayload(seq, {
        metrics: {
          cpu: { usage_pct: seq * 10, load1: seq },
          mem: { total_b: 8_000_000_000, used_b: seq * 1_000_000_000 },
          disk: [{ mount: '/', total_b: 100_000_000_000, used_b: seq * 10_000_000_000 }],
          net: { rx_b: seq * 100, tx_b: seq * 200 },
          uptime_s: seq * 1000,
        },
      });
      expect((await sendHeartbeat(h, agent, payload)).statusCode).toBe(200);
    }

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.agentId}/metrics?limit=2`,
      headers: authHeaders(h.config, session),
    });
    expect(res.statusCode).toBe(200);
    const samples = (res.json() as { samples: Array<Record<string, unknown>> }).samples;
    expect(samples).toHaveLength(2);
    // Ascending order, newest two samples (seq 2 and 3).
    expect(samples.map((s) => s.cpuPercent)).toEqual([20, 30]);
    expect(samples[1]).toMatchObject({
      cpuPercent: 30,
      memoryUsedBytes: 3_000_000_000,
      memoryTotalBytes: 8_000_000_000,
      diskUsedBytes: 30_000_000_000,
      diskTotalBytes: 100_000_000_000,
      uptimeSeconds: 3000,
      networkRxBytes: 300,
      networkTxBytes: 600,
    });
    expect(typeof samples[0]?.sampledAt).toBe('string');
  });

  it('clamps the limit and 404s for unknown agents', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'bounded-host');
    await sendHeartbeat(h, agent, heartbeatPayload(1));

    const huge = await h.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.agentId}/metrics?limit=99999`,
      headers: authHeaders(h.config, session),
    });
    expect(huge.statusCode).toBe(200);
    expect((huge.json() as { samples: unknown[] }).samples).toHaveLength(1);

    const wrong = await h.app.inject({
      method: 'GET',
      url: '/api/v1/agents/ag_does_not_exist/metrics',
      headers: authHeaders(h.config, session),
    });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires authentication for the UI API', async () => {
    const agents = await h.app.inject({ method: 'GET', url: '/api/v1/agents' });
    expect(agents.statusCode).toBe(401);
    const metrics = await h.app.inject({ method: 'GET', url: '/api/v1/agents/ag_x/metrics' });
    expect(metrics.statusCode).toBe(401);
  });
});

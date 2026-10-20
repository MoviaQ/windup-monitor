import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentHeaders,
  authHeaders,
  bootstrapAndEnroll,
  createHarness,
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

describe('heartbeat ingest', () => {
  it('persists CPU/RAM/disk/net/uptime and marks the agent online', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'metrics-host');

    const res = await sendHeartbeat(h, agent, heartbeatPayload(1));
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      config_version: 1,
      config_changed: false,
      pending_commands: [],
      full_inventory: false,
    });
    expect(typeof body.server_time).toBe('string');

    const sample = await h.db.metricSample.findFirstOrThrow({ where: { agentId: agent.agentId } });
    expect(sample.seq).toBe(1n);
    expect(sample.cpuPct).toBeCloseTo(12.5);
    expect(sample.memUsedB).toBe(4_000_000_000n);
    expect(sample.memTotalB).toBe(8_000_000_000n);
    expect(sample.uptimeS).toBe(12_345n);
    expect(sample.netRxB).toBe(1_000n);
    expect(sample.netTxB).toBe(2_000n);
    expect(sample.late).toBe(false);

    const disk = await h.db.diskSample.findMany({ where: { agentId: agent.agentId } });
    expect(disk).toHaveLength(1);
    expect(disk[0]?.mount).toBe('/');

    const stored = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(stored.lastSeq).toBe(1n);
    expect(stored.status).toBe('online');
    expect(stored.lastSeenAt).not.toBeNull();

    const list = await h.app.inject({ method: 'GET', url: '/api/v1/agents', headers: authHeaders(h.config, session) });
    expect(list.statusCode).toBe(200);
    const agents = (list.json() as { agents: Array<Record<string, unknown>> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: agent.agentId,
      hostname: 'metrics-host',
      status: 'online',
      metrics: {
        cpuPercent: 12.5,
        memoryUsedBytes: 4_000_000_000,
        memoryTotalBytes: 8_000_000_000,
        diskUsedBytes: 40_000_000_000,
        diskTotalBytes: 100_000_000_000,
        uptimeSeconds: 12_345,
        networkRxBytes: 1_000,
        networkTxBytes: 2_000,
      },
    });
  });

  it('signals CONFIG_STALE via config_changed until the agent fetches config', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'config-host');

    const first = await sendHeartbeat(h, agent, heartbeatPayload(1, { config_version: 0 }));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ config_changed: true, code: 'CONFIG_STALE', config_version: 1 });

    const cfg = await h.app.inject({
      method: 'GET',
      url: '/api/v1/agent/config',
      headers: agentHeaders(agent),
    });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toEqual({
      config_version: 1,
      heartbeat_interval_s: 15,
      queue_ttl_s: 300,
      lease_s: 120,
      result_ttl_s: 600,
      service_checks: [],
    });

    const second = await sendHeartbeat(h, agent, heartbeatPayload(2, { config_version: 1 }));
    expect(second.json()).toMatchObject({ config_changed: false });
    expect((second.json() as { code?: string }).code).toBeUndefined();
  });

  it('deduplicates retries and rejects stale seq without overwriting newer data', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'seq-host');

    expect((await sendHeartbeat(h, agent, heartbeatPayload(5))).statusCode).toBe(200);

    const duplicate = await sendHeartbeat(h, agent, heartbeatPayload(5));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'STALE_SEQ' });

    const older = await sendHeartbeat(
      h,
      agent,
      heartbeatPayload(3, {
        metrics: {
          cpu: { usage_pct: 99, load1: 9 },
          mem: { total_b: 8_000_000_000, used_b: 1, avail_b: 1 },
          disk: [{ mount: '/', total_b: 100, used_b: 1, avail_b: 99 }],
          net: { rx_b: 1, tx_b: 1 },
          uptime_s: 1,
        },
      }),
    );
    expect(older.statusCode).toBe(409);
    expect(older.json()).toMatchObject({ code: 'STALE_SEQ' });

    await expect(h.db.metricSample.count({ where: { agentId: agent.agentId } })).resolves.toBe(1);
    const sample = await h.db.metricSample.findFirstOrThrow({ where: { agentId: agent.agentId } });
    expect(sample.cpuPct).toBeCloseTo(12.5);
    expect(sample.seq).toBe(5n);
  });

  it('keeps seq state across a Core restart (persisted last_seq)', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'restart-host');
    expect((await sendHeartbeat(h, agent, heartbeatPayload(7))).statusCode).toBe(200);

    const restarted = await createHarness();
    try {
      const replay = await sendHeartbeat(restarted, agent, heartbeatPayload(7));
      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toMatchObject({ code: 'STALE_SEQ' });
      await expect(h.db.metricSample.count({ where: { agentId: agent.agentId } })).resolves.toBe(1);
    } finally {
      await restarted.close();
    }
  });

  it('rejects malformed / out-of-range batches atomically with INVALID_BODY', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'invalid-host');

    const badCpu = await sendHeartbeat(h, agent, heartbeatPayload(1, {
      metrics: {
        cpu: { usage_pct: 120 },
        mem: { total_b: 8_000_000_000, used_b: 1 },
        disk: [],
        net: { rx_b: 1, tx_b: 1 },
        uptime_s: 1,
      },
    }));
    expect(badCpu.statusCode).toBe(400);
    expect(badCpu.json()).toMatchObject({ code: 'INVALID_BODY' });

    const badMem = await sendHeartbeat(h, agent, heartbeatPayload(2, {
      metrics: {
        cpu: { usage_pct: 10 },
        mem: { total_b: 100, used_b: 200 },
        disk: [],
        net: { rx_b: 1, tx_b: 1 },
        uptime_s: 1,
      },
    }));
    expect(badMem.statusCode).toBe(400);

    const badDisk = await sendHeartbeat(h, agent, heartbeatPayload(3, {
      metrics: {
        cpu: { usage_pct: 10 },
        mem: { total_b: 100, used_b: 50 },
        disk: [{ mount: '/', total_b: 10, used_b: 20 }],
        net: { rx_b: 1, tx_b: 1 },
        uptime_s: 1,
      },
    }));
    expect(badDisk.statusCode).toBe(400);

    await expect(h.db.metricSample.count({ where: { agentId: agent.agentId } })).resolves.toBe(0);
  });

  it('flags late samples older than 10 minutes', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'late-host');
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    expect((await sendHeartbeat(h, agent, heartbeatPayload(1, { observed_at: old }))).statusCode).toBe(200);
    const sample = await h.db.metricSample.findFirstOrThrow({ where: { agentId: agent.agentId } });
    expect(sample.late).toBe(true);
  });

  it('rejects a bad credential and unknown agents', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'auth-host');

    const badSecret = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/heartbeat',
      headers: { ...agentHeaders(agent), authorization: 'Bearer nope' },
      payload: heartbeatPayload(1),
    });
    expect(badSecret.statusCode).toBe(401);
    expect(badSecret.json()).toMatchObject({ code: 'BAD_CREDENTIAL' });

    const noId = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/heartbeat',
      headers: { 'agent-protocol-version': '1', authorization: `Bearer ${agent.credential}` },
      payload: heartbeatPayload(1),
    });
    expect(noId.statusCode).toBe(401);
    expect(noId.json()).toMatchObject({ code: 'BAD_CREDENTIAL' });
  });
});

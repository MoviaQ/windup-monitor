import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/crypto.js';
import {
  authHeaders,
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

describe('agent pairing + enrollment', () => {
  it('exchanges a one-time token for a credential and stores only its argon2id hash', async () => {
    const session = await bootstrapAdmin(h);
    const token = await createPairingToken(h, session);

    const { agentId, credential } = await enrollAgent(h, token, 'nas-01');
    expect(agentId).toMatch(/^ag_/);
    expect(credential.length).toBeGreaterThan(30);

    const agent = await h.db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.name).toBe('nas-01');
    expect(agent.status).toBe('pending');
    expect(agent.capabilities).toEqual(['metrics']);
    expect(agent.credentialHash).toMatch(/^\$argon2id\$/);
    expect(agent.credentialHash).not.toContain(credential);

    // The credential never comes back through the UI API.
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/agents', headers: authHeaders(h.config, session) });
    expect(list.body).not.toContain(credential);
    expect(list.body).not.toContain('credentialHash');
  });

  it('rejects a reused enrollment token', async () => {
    const session = await bootstrapAdmin(h);
    const token = await createPairingToken(h, session);
    await enrollAgent(h, token, 'host-a');

    const replay = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      headers: { 'agent-protocol-version': '1' },
      payload: {
        enroll_token: token,
        hostname: 'host-b',
        agent_version: '0.1.0',
        protocol_version: 1,
        capabilities: ['metrics'],
      },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: 'BAD_CREDENTIAL' });
    await expect(h.db.agent.count()).resolves.toBe(1);
  });

  it('does not burn the token when enrollment fails (duplicate hostname)', async () => {
    const session = await bootstrapAdmin(h);
    const firstToken = await createPairingToken(h, session);
    await enrollAgent(h, firstToken, 'dup-host');

    const retryToken = await createPairingToken(h, session);
    const conflict = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      headers: { 'agent-protocol-version': '1' },
      payload: {
        enroll_token: retryToken,
        hostname: 'dup-host',
        agent_version: '0.1.0',
        protocol_version: 1,
        capabilities: ['metrics'],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'NAME_TAKEN' });

    // Same token still works with a different hostname.
    const retry = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      headers: { 'agent-protocol-version': '1' },
      payload: {
        enroll_token: retryToken,
        hostname: 'other-host',
        agent_version: '0.1.0',
        protocol_version: 1,
        capabilities: ['metrics'],
      },
    });
    expect(retry.statusCode).toBe(201);
  });

  it('rejects an expired enrollment token', async () => {
    const expired = 'expired-enroll-token';
    await h.db.enrollToken.create({
      data: {
        id: 'ent_expired',
        tokenHash: sha256Hex(expired),
        createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      headers: { 'agent-protocol-version': '1' },
      payload: {
        enroll_token: expired,
        hostname: 'late-host',
        agent_version: '0.1.0',
        protocol_version: 1,
        capabilities: ['metrics'],
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'BAD_CREDENTIAL' });
  });

  it('rejects unsupported protocol versions with UPGRADE_REQUIRED', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      headers: { 'agent-protocol-version': '2' },
      payload: {
        enroll_token: 'whatever',
        hostname: 'future-host',
        agent_version: '9.0.0',
        protocol_version: 2,
        capabilities: ['metrics'],
      },
    });
    expect(res.statusCode).toBe(426);
    expect(res.json()).toMatchObject({ code: 'UPGRADE_REQUIRED' });
  });

  it('rate-limits enrollment attempts per IP', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/agent/enroll',
        headers: { 'agent-protocol-version': '1' },
        payload: {
          enroll_token: `bad-token-${i}`,
          hostname: `host-${i}`,
          agent_version: '0.1.0',
          protocol_version: 1,
          capabilities: ['metrics'],
        },
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      headers: { 'agent-protocol-version': '1' },
      payload: {
        enroll_token: 'another',
        hostname: 'host-x',
        agent_version: '0.1.0',
        protocol_version: 1,
        capabilities: ['metrics'],
      },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('agent revocation', () => {
  it('revokes immediately: both hashes cleared and heartbeat gets AGENT_REVOKED', async () => {
    const session = await bootstrapAdmin(h);
    const token = await createPairingToken(h, session);
    const { agentId, credential } = await enrollAgent(h, token, 'revoke-me');
    const agent = { agentId, credential };

    await sendHeartbeat(h, agent, heartbeatPayload(1));

    const revoke = await h.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/revoke`,
      headers: authHeaders(h.config, session),
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);

    const stored = await h.db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(stored.status).toBe('revoked');
    expect(stored.credentialHash).toBeNull();
    expect(stored.credentialHashNext).toBeNull();
    expect(stored.revokedAt).not.toBeNull();

    const rejected = await sendHeartbeat(h, agent, heartbeatPayload(2));
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ code: 'AGENT_REVOKED' });
  });
});

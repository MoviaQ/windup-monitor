import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';
import * as credentials from '../src/agents/service.js';
import { randomToken } from '../src/lib/crypto.js';
import {
  agentHeaders, authHeaders, bootstrapAndEnroll, createHarness,
  heartbeatPayload, resetDb, sendHeartbeat, type EnrolledAgent, type Harness,
} from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await resetDb(h.db);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});
const rid = (): string => `rot_${ulid()}`;

function rotate(agent: EnrolledAgent, rotationId: string, next: string) {
  return h.app.inject({
    method: 'POST', url: '/api/v1/agent/rotate', headers: agentHeaders(agent),
    payload: { rotation_id: rotationId, new_credential: next },
  });
}
function confirm(agent: EnrolledAgent, rotationId: string) {
  return h.app.inject({
    method: 'POST', url: '/api/v1/agent/rotate_confirm', headers: agentHeaders(agent),
    payload: { rotation_id: rotationId },
  });
}
async function pending(agent: EnrolledAgent) {
  const next = { agentId: agent.agentId, credential: randomToken(32) };
  const rotationId = rid();
  expect((await rotate(agent, rotationId, next.credential)).statusCode).toBe(200);
  return { next, rotationId };
}

/**
 * Only the scheduling boundary is instrumented. Authentication, HTTP handlers,
 * SQL row locks, commits and all assertions run against real PostgreSQL.
 * Hold one request immediately AFTER successful auth until the competing HTTP
 * mutation has committed. No sleeps, fake DB, fake clock or probabilistic race.
 */
function pauseAfterAuth(agent: EnrolledAgent) {
  let release!: () => void;
  let reached!: () => void;
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  const authenticated = new Promise<void>((resolve) => { reached = resolve; });
  const original = credentials.authenticateAgent;
  let held = false;
  vi.spyOn(credentials, 'authenticateAgent').mockImplementation(async (db, id, bearer) => {
    const result = await original(db, id, bearer);
    if (!held && id === agent.agentId && bearer === agent.credential) {
      held = true;
      reached();
      await resumed;
    }
    return result;
  });
  return { authenticated, release };
}

async function assertNoSamples(agent: EnrolledAgent) {
  expect(await h.db.metricSample.count({ where: { agentId: agent.agentId } })).toBe(0);
  expect(await h.db.diskSample.count({ where: { agentId: agent.agentId } })).toBe(0);
  const row = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
  expect(row.lastSeq).toBe(0n);
  expect(row.lastSeenAt).toBeNull();
}

describe('credential authorization is atomic with agent mutations (real PG)', () => {
  it.each(['old', 'next', 'invalid'] as const)('promotes expired pending even when first Bearer is %s', async (first) => {
    const { agent } = await bootstrapAndEnroll(h);
    const { next, rotationId } = await pending(agent);
    const before = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    await h.db.agent.update({
      where: { id: agent.agentId }, data: { credentialOverlapUntil: new Date(0) },
    });
    const bearer = first === 'old' ? agent : first === 'next' ? next : { ...agent, credential: 'invalid' };
    const response = await h.app.inject({ url: '/api/v1/agent/config', headers: agentHeaders(bearer) });
    expect(response.statusCode).toBe(first === 'next' ? 200 : 401);
    if (first !== 'next') expect(response.json()).toMatchObject({ code: 'BAD_CREDENTIAL' });
    expect(await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } })).toMatchObject({
      credentialHash: before.credentialHashNext, credentialHashNext: null,
      rotationId: null, credentialOverlapUntil: null, lastRotationId: rotationId,
    });
    expect((await sendHeartbeat(h, agent, heartbeatPayload(1))).statusCode).toBe(401);
    expect((await sendHeartbeat(h, next, heartbeatPayload(1))).statusCode).toBe(200);
    expect((await confirm(next, rotationId)).statusCode).toBe(200);
  });

  it('rejects old-auth rotate after legitimate confirm commits; cannot install attacker next', async () => {
    const { agent } = await bootstrapAndEnroll(h);
    const { next, rotationId } = await pending(agent);
    const barrier = pauseAfterAuth(agent);
    const attack = rotate(agent, rid(), randomToken(32)).then((res) => res);
    try {
      await barrier.authenticated;
      expect((await confirm(next, rotationId)).statusCode).toBe(200);
    } finally { barrier.release(); }
    const response = await attack;
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'BAD_CREDENTIAL' });
    expect(await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } })).toMatchObject({
      credentialHashNext: null, lastRotationId: rotationId, rotationId: null,
    });
    expect(await h.db.auditLog.count({ where: { action: 'agent.rotate', target: agent.agentId } })).toBe(1);
    expect((await sendHeartbeat(h, next, heartbeatPayload(1))).statusCode).toBe(200);
  });

  it.each(['rotate', 'confirm', 'heartbeat'] as const)('rejects previously authorized %s after revoke commits', async (operation) => {
    const { agent, session } = await bootstrapAndEnroll(h);
    const { next, rotationId } = await pending(agent);
    const caller = operation === 'confirm' ? next : agent;
    const barrier = pauseAfterAuth(caller);
    const request = (operation === 'rotate' ? rotate(caller, rid(), randomToken(32)) :
      operation === 'confirm' ? confirm(caller, rotationId) :
        sendHeartbeat(h, caller, heartbeatPayload(1))).then((res) => res);
    try {
      await barrier.authenticated;
      expect((await h.app.inject({
        method: 'POST', url: `/api/v1/agents/${agent.agentId}/revoke`,
        headers: authHeaders(h.config, session), payload: {},
      })).statusCode).toBe(200);
    } finally { barrier.release(); }
    const response = await request;
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AGENT_REVOKED' });
    expect(await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } })).toMatchObject({
      status: 'revoked', credentialHash: null, credentialHashNext: null, rotationId: null,
    });
    await assertNoSamples(agent);
    expect((await confirm(next, rotationId)).statusCode).toBe(401);
    expect((await sendHeartbeat(h, next, heartbeatPayload(2))).statusCode).toBe(401);
  });

  it.each(['confirm', 'deadline'] as const)('rejects old-auth heartbeat after %s invalidates it', async (operation) => {
    const { agent } = await bootstrapAndEnroll(h);
    const { next, rotationId } = await pending(agent);
    const barrier = pauseAfterAuth(agent);
    const request = sendHeartbeat(h, agent, heartbeatPayload(1));
    try {
      await barrier.authenticated;
      if (operation === 'confirm') expect((await confirm(next, rotationId)).statusCode).toBe(200);
      else await h.db.agent.update({
        where: { id: agent.agentId }, data: { credentialOverlapUntil: new Date(0) },
      });
    } finally { barrier.release(); }
    const response = await request;
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'BAD_CREDENTIAL' });
    await assertNoSamples(agent);
    expect((await sendHeartbeat(h, next, heartbeatPayload(1))).statusCode).toBe(200);
  });

  it('serializes concurrent identical rotate and confirm retries without resurrecting pending', async () => {
    const { agent } = await bootstrapAndEnroll(h);
    const next = { ...agent, credential: randomToken(32) };
    const rotationId = rid();
    const starts = await Promise.all([rotate(agent, rotationId, next.credential), rotate(agent, rotationId, next.credential)]);
    expect(starts.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(starts[0].json()).toEqual(starts[1].json());
    const confirms = await Promise.all([confirm(next, rotationId), confirm(next, rotationId)]);
    expect(confirms.map((res) => res.statusCode)).toEqual([200, 200]);
    expect((await rotate(next, rotationId, next.credential)).statusCode).toBe(409);
    expect(await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } })).toMatchObject({
      credentialHashNext: null, rotationId: null, lastRotationId: rotationId,
    });
    expect(await h.db.auditLog.count({ where: { action: 'agent.rotate', target: agent.agentId } })).toBe(1);
    expect(await h.db.auditLog.count({ where: { action: 'agent.rotate_confirm', target: agent.agentId } })).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { randomToken } from '../src/lib/crypto.js';
import {
  agentHeaders,
  authHeaders,
  bootstrapAndEnroll,
  createHarness,
  heartbeatPayload,
  resetDb,
  sendHeartbeat,
  type EnrolledAgent,
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

const rotationId = (): string => `rot_${ulid()}`;

async function rotate(
  harness: Harness,
  agent: EnrolledAgent,
  rid: string,
  next: string,
  bearer = agent.credential,
): Promise<{ statusCode: number; body: string; json: () => Record<string, unknown> }> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/agent/rotate',
    headers: { ...agentHeaders(agent), authorization: `Bearer ${bearer}` },
    payload: { rotation_id: rid, new_credential: next },
  });
  return res;
}

async function confirm(
  harness: Harness,
  agent: EnrolledAgent,
  rid: string,
  bearer: string,
): Promise<{ statusCode: number; json: () => Record<string, unknown> }> {
  return harness.app.inject({
    method: 'POST',
    url: '/api/v1/agent/rotate_confirm',
    headers: { ...agentHeaders(agent), authorization: `Bearer ${bearer}` },
    payload: { rotation_id: rid },
  });
}

describe('credential rotation (SP-105)', () => {
  it('dual-accepts old+next during overlap, promotes on confirm, then rejects the old secret', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'rotate-host');
    const next = randomToken(32);
    const rid = rotationId();

    const started = await rotate(h, agent, rid, next);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ rotation_id: rid });
    expect(typeof started.json().overlap_until).toBe('string');

    const stored = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(stored.rotationId).toBe(rid);
    expect(stored.credentialHashNext).toMatch(/^\$argon2id\$/);
    expect(stored.credentialHashNext).not.toContain(next);

    // Rotation does not block metrics: both secrets are accepted.
    expect((await sendHeartbeat(h, agent, heartbeatPayload(1))).statusCode).toBe(200);
    expect((await sendHeartbeat(h, { agentId: agent.agentId, credential: next }, heartbeatPayload(2))).statusCode).toBe(200);

    const confirmed = await confirm(h, agent, rid, next);
    expect(confirmed.statusCode).toBe(200);

    const promoted = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(promoted.credentialHashNext).toBeNull();
    expect(promoted.rotationId).toBeNull();
    expect(promoted.lastRotationId).toBe(rid);
    expect(promoted.credentialOverlapUntil).toBeNull();

    const oldRejected = await sendHeartbeat(h, agent, heartbeatPayload(3));
    expect(oldRejected.statusCode).toBe(401);
    expect(oldRejected.json()).toMatchObject({ code: 'BAD_CREDENTIAL' });

    const newWorks = await sendHeartbeat(h, { agentId: agent.agentId, credential: next }, heartbeatPayload(4));
    expect(newWorks.statusCode).toBe(200);

    // Repeated confirm after a lost response is idempotent.
    expect((await confirm(h, agent, rid, next)).statusCode).toBe(200);
  });

  it('is idempotent for the same rotation_id + next and conflicts on a different next', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'rotate-idem-host');
    const next = randomToken(32);
    const rid = rotationId();

    const first = await rotate(h, agent, rid, next);
    expect(first.statusCode).toBe(200);
    const overlap = first.json().overlap_until;

    const retry = await rotate(h, agent, rid, next);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().overlap_until).toBe(overlap);

    const conflict = await rotate(h, agent, rid, randomToken(32));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'ROTATION_CONFLICT' });
  });

  it('enforces the 5 rotations/day/agent cap', async () => {
    const { agent } = await bootstrapAndEnroll(h, 'rotate-cap-host');
    let current = agent.credential;

    for (let i = 0; i < 5; i += 1) {
      const next = randomToken(32);
      const rid = rotationId();
      const started = await rotate(h, agent, rid, next, current);
      expect(started.statusCode).toBe(200);
      const done = await confirm(h, agent, rid, next);
      expect(done.statusCode).toBe(200);
      current = next;
    }

    const blocked = await rotate(h, agent, rotationId(), randomToken(32), current);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('revocation clears a pending next secret immediately', async () => {
    const { session, agent } = await bootstrapAndEnroll(h, 'rotate-revoke-host');
    const next = randomToken(32);
    const rid = rotationId();
    expect((await rotate(h, agent, rid, next)).statusCode).toBe(200);

    const revoke = await h.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.agentId}/revoke`,
      headers: authHeaders(h.config, session),
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);

    const stored = await h.db.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
    expect(stored.credentialHash).toBeNull();
    expect(stored.credentialHashNext).toBeNull();
    expect(stored.rotationId).toBeNull();

    const rejected = await confirm(h, agent, rid, next);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ code: 'AGENT_REVOKED' });
  });
});

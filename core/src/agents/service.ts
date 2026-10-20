import type { AppConfig } from '../config.js';
import type { Agent, Db } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { appendAudit, countAuditSince } from '../db/audit.js';
import { ApiError, invalidBody } from '../lib/errors.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { newAgentId, newEnrollTokenId } from '../lib/ids.js';
import { hashCredential, generateCredential, verifyCredential } from './credentials.js';

export const AGENT_ACTOR = 'agent';
const ROTATION_ID_RE = /^rot_[0-9A-HJKMNP-TV-Z]{26}$/;
const OVERLAP_MS = 10 * 60_000; // canonical rotation overlap: 10 minutes
const KNOWN_CAPABILITIES = new Set([
  'metrics',
  'docker',
  'restart',
  'service_discovery',
  'http_checks',
  'tcp_checks',
]);

export interface PairingTokenResult {
  token: string;
  expiresAt: Date;
}

export async function createPairingToken(
  db: Db,
  config: AppConfig,
  actor: string,
  label?: string | undefined,
): Promise<PairingTokenResult> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.enrollTokenTtlMs);
  const id = newEnrollTokenId();
  await db.$transaction(async (tx) => {
    await tx.enrollToken.create({
      data: { id, tokenHash: sha256Hex(token), label: label ?? null, expiresAt },
    });
    await appendAudit(tx, {
      actor,
      action: 'agent.pairing_token',
      target: id,
      detail: label ? { label } : null,
    });
  });
  return { token, expiresAt };
}

export interface EnrollInput {
  enrollToken: string;
  hostname: string;
  agentVersion?: string | undefined;
  protocolVersion: number;
  capabilities: string[];
}

export interface EnrollResult {
  agentId: string;
  credential: string;
  heartbeatIntervalS: number;
  configVersion: number;
}

/**
 * Exchanges a one-time enroll token for agent credentials. The token is
 * consumed atomically in the same transaction that creates the agent; a failed
 * attempt (bad/expired token, duplicate hostname) leaves the token intact.
 */
export async function enroll(db: Db, config: AppConfig, input: EnrollInput): Promise<EnrollResult> {
  const tokenHash = sha256Hex(input.enrollToken);
  const credential = generateCredential();
  const credentialHash = await hashCredential(credential);
  const agentId = newAgentId();
  const now = new Date();
  const capabilities = [...new Set(input.capabilities.filter((c) => KNOWN_CAPABILITIES.has(c)))];

  await db.$transaction(
    async (tx) => {
      const token = await tx.enrollToken.findUnique({ where: { tokenHash } });
      if (!token || token.usedAt != null || token.expiresAt.getTime() <= now.getTime()) {
        throw new ApiError(401, 'BAD_CREDENTIAL', 'Invalid or expired enrollment token');
      }
      const existing = await tx.agent.findUnique({ where: { name: input.hostname } });
      if (existing) {
        throw new ApiError(409, 'NAME_TAKEN', 'An agent with this hostname is already enrolled');
      }
      const consumed = await tx.enrollToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new ApiError(401, 'BAD_CREDENTIAL', 'Enrollment token already used');
      }
      await tx.agent.create({
        data: {
          id: agentId,
          name: input.hostname,
          credentialHash,
          status: 'pending',
          capabilities,
          agentVersion: input.agentVersion ?? null,
          protocolVersion: input.protocolVersion,
          configVersion: config.configVersion,
        },
      });
      await appendAudit(tx, {
        actor: AGENT_ACTOR,
        action: 'agent.enroll',
        target: agentId,
        detail: {
          hostname: input.hostname,
          protocolVersion: input.protocolVersion,
          capabilities,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  return {
    agentId,
    credential,
    heartbeatIntervalS: config.heartbeatIntervalS,
    configVersion: config.configVersion,
  };
}

export interface AgentAuthContext {
  agent: Agent;
  credentialKind: 'current' | 'next';
  /** Exact Argon2 hash verified outside the row lock; never client supplied. */
  verifiedHash: string;
}

/** All credential mutations and ingest serialize on this same agent row. */
export async function lockAgent(tx: Prisma.TransactionClient, agentId: string): Promise<Agent> {
  await tx.$queryRaw`SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE`;
  const agent = await tx.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new ApiError(401, 'BAD_CREDENTIAL', 'Unknown agent');
  return agent;
}

/** Called only with the row locked. Expiry is checked before either hash. */
async function promoteExpired(tx: Prisma.TransactionClient, agent: Agent): Promise<Agent> {
  if (agent.status === 'revoked' || agent.revokedAt) return agent;
  if (agent.credentialHashNext && agent.credentialOverlapUntil &&
      agent.credentialOverlapUntil.getTime() <= Date.now()) {
    return tx.agent.update({
      where: { id: agent.id },
      data: {
        credentialHash: agent.credentialHashNext,
        credentialHashNext: null,
        credentialOverlapUntil: null,
        rotationId: null,
        lastRotationId: agent.rotationId,
      },
    });
  }
  return agent;
}

function credentialKind(agent: Agent, verifiedHash: string | null): 'current' | 'next' {
  if (agent.status === 'revoked' || agent.revokedAt) {
    throw new ApiError(401, 'AGENT_REVOKED', 'Agent revoked');
  }
  const expired = agent.credentialHashNext && agent.credentialOverlapUntil &&
    agent.credentialOverlapUntil.getTime() <= Date.now();
  if (!expired && verifiedHash && verifiedHash === agent.credentialHash) return 'current';
  if (verifiedHash && verifiedHash === agent.credentialHashNext &&
      agent.credentialOverlapUntil && agent.credentialOverlapUntil.getTime() > Date.now()) return 'next';
  throw new ApiError(401, 'BAD_CREDENTIAL', 'Invalid or expired credential');
}

/** Revalidates a verified hash against live state in the mutation transaction. */
export async function authorizeLockedAgent(
  tx: Prisma.TransactionClient,
  auth: AgentAuthContext,
): Promise<AgentAuthContext> {
  const agent = await promoteExpired(tx, await lockAgent(tx, auth.agent.id));
  return { agent, verifiedHash: auth.verifiedHash, credentialKind: credentialKind(agent, auth.verifiedHash) };
}

/** Argon2 runs outside the lock; only a hash still present under lock authorizes. */
export async function authenticateAgent(db: Db, agentId: string, bearer: string): Promise<AgentAuthContext> {
  if (!agentId || !bearer) throw new ApiError(401, 'BAD_CREDENTIAL', 'Missing agent credentials');
  const snapshot = await db.agent.findUnique({ where: { id: agentId } });
  if (!snapshot) throw new ApiError(401, 'BAD_CREDENTIAL', 'Unknown agent');
  let verifiedHash: string | null = null;
  for (const hash of [snapshot.credentialHash, snapshot.credentialHashNext]) {
    if (hash && await verifyCredential(hash, bearer)) {
      verifiedHash = hash;
      break;
    }
  }
  // Commit deadline promotion even when this request used the expired old Bearer.
  const agent = await db.$transaction(async (tx) =>
    promoteExpired(tx, await lockAgent(tx, agentId)),
  { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  const kind = credentialKind(agent, verifiedHash);
  return { agent, verifiedHash: verifiedHash!, credentialKind: kind };
}

export async function revokeAgent(db: Db, agentId: string, actor: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId);
    if (agent.status === 'revoked') return; // idempotent
    await tx.agent.update({
      where: { id: agentId },
      data: {
        credentialHash: null,
        credentialHashNext: null,
        credentialOverlapUntil: null,
        rotationId: null,
        status: 'revoked',
        revokedAt: new Date(),
      },
    });
    await appendAudit(tx, { actor, action: 'agent.revoke', target: agentId, detail: null });
  });
}

export interface RotationResult {
  rotationId: string;
  overlapUntil: Date;
}

export async function rotate(
  db: Db,
  config: AppConfig,
  auth: AgentAuthContext,
  rotationId: string,
  newCredential: string,
): Promise<RotationResult> {
  if (!ROTATION_ID_RE.test(rotationId)) throw invalidBody('rotation_id must match rot_<ULID>');
  if (newCredential.length < 16 || newCredential.length > 512) {
    throw invalidBody('new_credential must be 16..512 characters');
  }
  const agentId = auth.agent.id;
  const snapshot = await db.agent.findUnique({ where: { id: agentId } });
  // Retry proof is also computed outside the lock, then compared with live hash.
  const retryHash = snapshot?.credentialHashNext &&
    await verifyCredential(snapshot.credentialHashNext, newCredential) ? snapshot.credentialHashNext : null;
  const newHash = await hashCredential(newCredential);
  return db.$transaction(
    async (tx) => {
      const { agent: row } = await authorizeLockedAgent(tx, auth);
      const now = new Date();
      const overlapUntil = new Date(now.getTime() + OVERLAP_MS);
      if (row.credentialHashNext) {
        if (row.rotationId === rotationId && (row.credentialHashNext === retryHash ||
            // Concurrent identical rotate may have installed pending after our precheck.
            await verifyCredential(row.credentialHashNext, newCredential))) {
          return { rotationId, overlapUntil: row.credentialOverlapUntil! };
        }
        throw new ApiError(409, 'ROTATION_CONFLICT', 'Another rotation is pending for this agent');
      }
      if (row.lastRotationId === rotationId) {
        throw new ApiError(409, 'ROTATION_CONFLICT', 'Rotation already completed');
      }

      const since = new Date(now.getTime() - 86_400_000);
      const created = await countAuditSince(tx, 'agent.rotate', agentId, since);
      if (created >= config.rotateDailyLimit) {
        throw new ApiError(429, 'RATE_LIMITED', 'Rotation daily limit reached');
      }

      await tx.agent.update({
        where: { id: agentId },
        data: { credentialHashNext: newHash, credentialOverlapUntil: overlapUntil, rotationId },
      });
      await appendAudit(tx, {
        actor: AGENT_ACTOR,
        action: 'agent.rotate',
        target: agentId,
        detail: { rotationId },
      });
      return { rotationId, overlapUntil };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

/**
 * Confirms a rotation: copies `next` to the active secret and clears the
 * pending state. Idempotent for a repeat with the same rotation id.
 */
export async function rotateConfirm(
  db: Db,
  auth: AgentAuthContext,
  rotationId: string,
): Promise<void> {
  await db.$transaction(
    async (tx) => {
      const { agent: row, credentialKind: kind } = await authorizeLockedAgent(tx, auth);
      const agentId = row.id;
      if (!row.credentialHashNext && row.lastRotationId === rotationId) return;
      if (!row.credentialHashNext || row.rotationId !== rotationId) {
        throw new ApiError(409, 'ROTATION_CONFLICT', 'No matching pending rotation');
      }
      if (kind !== 'next') {
        throw new ApiError(401, 'BAD_CREDENTIAL', 'rotate_confirm requires the new credential');
      }

      await tx.agent.update({
        where: { id: agentId },
        data: {
          credentialHash: row.credentialHashNext,
          credentialHashNext: null,
          credentialOverlapUntil: null,
          rotationId: null,
          lastRotationId: rotationId,
        },
      });
      await appendAudit(tx, {
        actor: AGENT_ACTOR,
        action: 'agent.rotate_confirm',
        target: agentId,
        detail: { rotationId },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

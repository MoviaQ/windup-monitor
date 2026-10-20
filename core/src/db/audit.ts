import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { newAuditId } from '../lib/ids.js';

/** A Prisma client or an interactive-transaction client — both expose `auditLog`. */
export type AuditWriter = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string | null;
  detail?: Prisma.InputJsonValue | null;
}

/**
 * Appends one audit row. `detail` must be pre-sanitized: never plaintext
 * credentials/tokens/passwords (docs/security.md §3, §7).
 */
export async function appendAudit(db: AuditWriter, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      id: newAuditId(),
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? null,
      detail: entry.detail ?? undefined,
    },
  });
}

/** Counts audit rows for an actor/action since a point in time (rotation cap). */
export async function countAuditSince(db: AuditWriter, action: string, target: string, since: Date): Promise<number> {
  return db.auditLog.count({
    where: { action, target, at: { gte: since } },
  });
}

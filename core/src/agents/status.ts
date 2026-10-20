import type { AgentStatus } from '../generated/prisma/client.js';
import type { AppConfig } from '../config.js';

export type { AgentStatus };

/**
 * Agent status is derived from `last_seen_at` (the column is only a cache),
 * except `revoked` which is terminal. Thresholds: docs/agent-protocol.md §5,
 * DEC-003 defaults (online ≤ 45s, stale ≤ 5min, offline > 5min).
 */
export function computeStatus(
  agent: { status: AgentStatus; lastSeenAt: Date | null },
  config: AppConfig,
  now: Date = new Date(),
): AgentStatus {
  if (agent.status === 'revoked') return 'revoked';
  if (!agent.lastSeenAt) return 'pending';
  const ageSeconds = (now.getTime() - agent.lastSeenAt.getTime()) / 1000;
  if (ageSeconds <= config.agentStaleSeconds) return 'online';
  if (ageSeconds <= config.agentOfflineSeconds) return 'stale';
  return 'offline';
}

import type { AiProvider } from '../generated/prisma/client.js';
import type { Db } from '../db/client.js';
import { newAiUsageId } from '../lib/ids.js';

/**
 * App-side AI usage registry (docs/ai-integration-contract.md §7, §9).
 * Events are recorded exclusively by the application (there is no HTTP
 * endpoint that lets a client add or alter usage), so the panel can never be
 * fed fabricated statistics. Missing metrics stay `null`.
 */

export interface AiUsageEventInput {
  userId: string;
  provider: AiProvider;
  model?: string | null;
  kind?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}

/** Internal recorder for future AI calls. Never exposed over HTTP. */
export async function recordAiUsage(db: Db, input: AiUsageEventInput): Promise<void> {
  await db.aiUsageEvent.create({
    data: {
      id: newAiUsageId(),
      userId: input.userId,
      provider: input.provider,
      model: input.model ?? null,
      kind: input.kind ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costUsd: input.costUsd ?? null,
    },
  });
}

export interface AiUsageEventDto {
  at: string;
  provider: AiProvider;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface AiUsageResponse {
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  since: string | null;
  recent: AiUsageEventDto[];
}

const RECENT_LIMIT = 20;

/**
 * Aggregates this application's usage for one user. Zero events → requests 0
 * with null tokens/cost (never invented numbers). Token/cost totals are null
 * when no event carries that metric at all.
 */
export async function getAiUsage(db: Db, userId: string): Promise<AiUsageResponse> {
  const [aggregate, recent] = await Promise.all([
    db.aiUsageEvent.aggregate({
      where: { userId },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      _min: { occurredAt: true },
    }),
    db.aiUsageEvent.findMany({
      where: { userId },
      orderBy: { occurredAt: 'desc' },
      take: RECENT_LIMIT,
    }),
  ]);

  const withInput = await db.aiUsageEvent.count({ where: { userId, inputTokens: { not: null } } });
  const withOutput = await db.aiUsageEvent.count({ where: { userId, outputTokens: { not: null } } });
  const withCost = await db.aiUsageEvent.count({ where: { userId, costUsd: { not: null } } });

  return {
    requests: aggregate._count._all,
    inputTokens: withInput > 0 ? (aggregate._sum.inputTokens ?? 0) : null,
    outputTokens: withOutput > 0 ? (aggregate._sum.outputTokens ?? 0) : null,
    costUsd: withCost > 0 ? (aggregate._sum.costUsd ?? null) : null,
    since: aggregate._min.occurredAt?.toISOString() ?? null,
    recent: recent.map((event) => ({
      at: event.occurredAt.toISOString(),
      provider: event.provider,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      costUsd: event.costUsd,
    })),
  };
}

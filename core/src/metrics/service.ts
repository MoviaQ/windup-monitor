import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { computeStatus } from '../agents/status.js';

export interface HostMetricsDto {
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  uptimeSeconds: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface AgentSummaryDto {
  id: string;
  hostname: string;
  status: string;
  lastSeenAt: string | null;
  metrics: HostMetricsDto | null;
}

export interface MetricSampleDto {
  sampledAt: string;
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  uptimeSeconds: number;
  networkRxBytes: number;
  networkTxBytes: number;
  late: boolean;
  receivedAt: string;
}

export const METRICS_DEFAULT_LIMIT = 100;
export const METRICS_MAX_LIMIT = 500;

/** Bounded list of agents with their latest host metrics (UI contract). */
export async function listAgentSummaries(db: Db, config: AppConfig, now: Date = new Date()): Promise<AgentSummaryDto[]> {
  const agents = await db.agent.findMany({ orderBy: { name: 'asc' } });

  return Promise.all(
    agents.map(async (agent): Promise<AgentSummaryDto> => {
      const latest = await db.metricSample.findFirst({
        where: { agentId: agent.id },
        orderBy: { seq: 'desc' },
      });

      let metrics: HostMetricsDto | null = null;
      if (latest) {
        const disk = await db.diskSample.aggregate({
          where: { agentId: agent.id, seq: latest.seq },
          _sum: { usedB: true, totalB: true },
        });
        metrics = {
          cpuPercent: latest.cpuPct,
          memoryUsedBytes: Number(latest.memUsedB),
          memoryTotalBytes: Number(latest.memTotalB),
          diskUsedBytes: Number(disk._sum.usedB ?? 0n),
          diskTotalBytes: Number(disk._sum.totalB ?? 0n),
          uptimeSeconds: Number(latest.uptimeS),
          networkRxBytes: Number(latest.netRxB),
          networkTxBytes: Number(latest.netTxB),
        };
      }

      return {
        id: agent.id,
        hostname: agent.name,
        status: computeStatus(agent, config, now),
        lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
        metrics,
      };
    }),
  );
}

/** Ascending, bounded history of metric samples for one agent. */
export async function getAgentMetrics(db: Db, agentId: string, limit: number): Promise<MetricSampleDto[] | null> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
  if (!agent) return null;

  const bounded = Math.min(Math.max(1, Math.trunc(limit)), METRICS_MAX_LIMIT);
  const samples = await db.metricSample.findMany({
    where: { agentId },
    orderBy: { seq: 'desc' },
    take: bounded,
  });
  samples.reverse();

  const seqs = samples.map((sample) => sample.seq);
  const diskAgg = seqs.length
    ? await db.diskSample.groupBy({
        by: ['seq'],
        where: { agentId, seq: { in: seqs } },
        _sum: { usedB: true, totalB: true },
      })
    : [];
  const diskBySeq = new Map(diskAgg.map((row) => [String(row.seq), row._sum]));

  return samples.map((sample) => {
    const disk = diskBySeq.get(String(sample.seq));
    return {
      sampledAt: sample.observedAt.toISOString(),
      cpuPercent: sample.cpuPct,
      memoryUsedBytes: Number(sample.memUsedB),
      memoryTotalBytes: Number(sample.memTotalB),
      diskUsedBytes: Number(disk?.usedB ?? 0n),
      diskTotalBytes: Number(disk?.totalB ?? 0n),
      uptimeSeconds: Number(sample.uptimeS),
      networkRxBytes: Number(sample.netRxB),
      networkTxBytes: Number(sample.netTxB),
      late: sample.late,
      receivedAt: sample.receivedAt.toISOString(),
    };
  });
}

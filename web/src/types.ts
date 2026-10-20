/*
 * Windup Monitor Web — typy kontraktu API (S1).
 * Nazwy statusów kanoniczne z docs/data-model.md §5 — te same stringi w API i UI.
 */

export type AgentStatus = "online" | "stale" | "offline" | "pending" | "revoked";

export interface HostMetrics {
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  uptimeSeconds: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface AgentSummary {
  id: string;
  hostname: string;
  status: AgentStatus;
  lastSeenAt: string | null;
  metrics: HostMetrics | null;
}

export interface MetricSample {
  sampledAt: string;
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  uptimeSeconds?: number | null;
  networkRxBytes?: number | null;
  networkTxBytes?: number | null;
}

export interface PairingToken {
  token: string;
  expiresAt: string;
}

/*
 * Windup Monitor Web — klient API usług (kontrakt S2 Core, iteracja usług).
 * Mutacje przechodzą przez `request` z api/client (sesja w cookie + CSRF),
 * więc nie ma tu własnego wynoszenia tokenów ani nagłówków auth.
 */

import { request } from "./client";

export type MonitoredServiceStatus = "unknown" | "up" | "down" | "paused" | "degraded";

export interface MonitoredService {
  id: string;
  agentId: string;
  agentHostname: string;
  name: string;
  candidateId: string;
  port: number;
  /** Addytywne (generic discovery): "http" albo "tcp". */
  transport?: string;
  path: string;
  expectedStatuses: number[];
  intervalSeconds: number;
  timeoutSeconds: number;
  enabled: boolean;
  /** Addytywne (Core S2): mogą być nieobecne w przejściowych odpowiedziach — patrz fallback w prefill edycji. */
  failureThreshold?: number | null;
  successThreshold?: number | null;
  /** Opcjonalny kontekst nieznanego statusu (Core może dodać później) — UI używa tylko defensywnie. */
  agentStatus?: string | null;
  unknownReason?: string | null;
  status: MonitoredServiceStatus;
  lastCheckedAt: string | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  /** Addytywne (S4): kod ostatniego błędu (np. TIMEOUT), null gdy brak. */
  lastErrorCode?: string | null;
  consecutiveFailures: number;
  upSince: string | null;
  /** Addytywne (S4): wykryty restart procesu właściciela, odróżniony od upSince. */
  lastRestartAt?: string | null;
  processStartedAt: string | null;
  /** Addytywne (S3): CPU/RAM rzeczywistego procesu właściciela; null = brak danych. */
  processCpuPercent?: number | null;
  processMemoryRssBytes?: number | null;
  processMetricsAt?: string | null;
  availabilityPercent: number | null;
  observedSeconds: number;
  unknownSeconds: number;
  configRevision: number;
}

export type CandidateKind = "jellyfin" | "t3-code" | "opencode" | "unknown";

export interface DiscoveredCandidate {
  agentId: string;
  agentHostname: string;
  candidateId: string;
  name: string;
  kind: string;
  port: number;
  transport: string;
  source: string;
  confidence: string;
  /** Addytywne (generic discovery): czy nasłuch można monitorować (kind unknown tego nie wyklucza). */
  monitorable?: boolean;
  /** Addytywne: źródło nazwy (exe|comm|package-json|systemd|container|fallback|fingerprint). */
  nameSource?: string | null;
  processStartedAt: string | null;
  suggestedPath: string | null;
  suggestedStatuses: number[];
  monitored: boolean;
  lastSeenAt: string;
  available: boolean;
  processCpuPercent?: number | null;
  processMemoryRssBytes?: number | null;
  processMetricsAt?: string | null;
}

export interface ServiceHistoryResult {
  checkedAt: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  errorCode: string | null;
}

export interface ServiceIncident {
  id: string;
  openedAt: string;
  resolvedAt: string | null;
  reason: string;
}

export interface ServiceHistory {
  results: ServiceHistoryResult[];
  incidents: ServiceIncident[];
}

export interface CreateServiceInput {
  agentId: string;
  candidateId: string;
  name?: string;
  path?: string;
  expectedStatuses?: number[];
  intervalSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

export interface UpdateServiceInput {
  name?: string;
  path?: string;
  expectedStatuses?: number[];
  intervalSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
  enabled?: boolean;
}

function asServiceArray(payload: unknown): MonitoredService[] {
  if (payload && typeof payload === "object" && Array.isArray((payload as { services?: unknown }).services)) {
    return (payload as { services: MonitoredService[] }).services;
  }
  return [];
}

function asCandidateArray(payload: unknown): DiscoveredCandidate[] {
  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { candidates?: unknown }).candidates)
  ) {
    return (payload as { candidates: DiscoveredCandidate[] }).candidates;
  }
  return [];
}

export async function listServices(): Promise<MonitoredService[]> {
  const payload = await request<{ services: MonitoredService[] }>("/api/v1/services");
  return asServiceArray(payload);
}

export async function listDiscovered(): Promise<DiscoveredCandidate[]> {
  const payload = await request<{ candidates: DiscoveredCandidate[] }>(
    "/api/v1/services/discovered",
  );
  return asCandidateArray(payload);
}

export async function createService(input: CreateServiceInput): Promise<MonitoredService> {
  const payload = await request<{ service: MonitoredService }>("/api/v1/services", {
    method: "POST",
    body: input,
  });
  return payload.service;
}

export async function updateService(
  id: string,
  patch: UpdateServiceInput,
): Promise<MonitoredService> {
  const payload = await request<{ service: MonitoredService }>(
    `/api/v1/services/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
  );
  return payload.service;
}

export async function deleteService(id: string): Promise<void> {
  await request<void>(`/api/v1/services/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getServiceHistory(
  id: string,
  limit = 100,
): Promise<ServiceHistory> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), 500);
  const payload = await request<ServiceHistory>(
    `/api/v1/services/${encodeURIComponent(id)}/history?limit=${bounded}`,
  );
  const results = Array.isArray(payload.results) ? payload.results : [];
  const incidents = Array.isArray(payload.incidents) ? payload.incidents : [];
  return { results, incidents };
}

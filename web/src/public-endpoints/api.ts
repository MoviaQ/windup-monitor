/*
 * Windup Monitor Web — klient API publicznych adresów URL (iteracja public endpoints).
 * Mutacje przechodzą przez `request` z api/client (sesja w cookie + CSRF),
 * tak jak usługi. Kształt DTO: core/src/public-endpoints/CONTRACT.md.
 */

import { request } from "../api/client";

export type PublicEndpointStatus = "unknown" | "up" | "down" | "paused";

export interface PublicEndpoint {
  id: string;
  serviceId: string;
  label: string | null;
  url: string;
  enabled: boolean;
  intervalSeconds: number;
  timeoutSeconds: number;
  status: PublicEndpointStatus;
  lastCheckedAt: string | null;
  statusCode: number | null;
  latencyMs: number | null;
  errorCode: string | null;
}

export interface PublicEndpointResult {
  checkedAt: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  errorCode: string | null;
}

export interface CreatePublicEndpointInput {
  url: string;
  label?: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
}

export interface UpdatePublicEndpointInput {
  url?: string;
  label?: string;
  enabled?: boolean;
  intervalSeconds?: number;
  timeoutSeconds?: number;
}

function asEndpointArray(payload: unknown): PublicEndpoint[] {
  if (payload && typeof payload === "object" && Array.isArray((payload as { endpoints?: unknown }).endpoints)) {
    return (payload as { endpoints: PublicEndpoint[] }).endpoints;
  }
  return [];
}

export async function listPublicEndpoints(serviceId: string): Promise<PublicEndpoint[]> {
  const payload = await request<{ endpoints: PublicEndpoint[] }>(
    `/api/v1/services/${encodeURIComponent(serviceId)}/public-endpoints`,
  );
  return asEndpointArray(payload);
}

export async function createPublicEndpoint(
  serviceId: string,
  input: CreatePublicEndpointInput,
): Promise<PublicEndpoint> {
  const payload = await request<{ endpoint: PublicEndpoint }>(
    `/api/v1/services/${encodeURIComponent(serviceId)}/public-endpoints`,
    { method: "POST", body: input },
  );
  return payload.endpoint;
}

export async function updatePublicEndpoint(
  id: string,
  patch: UpdatePublicEndpointInput,
): Promise<PublicEndpoint> {
  const payload = await request<{ endpoint: PublicEndpoint }>(
    `/api/v1/public-endpoints/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
  );
  return payload.endpoint;
}

export async function deletePublicEndpoint(id: string): Promise<void> {
  await request<void>(`/api/v1/public-endpoints/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getPublicEndpointHistory(id: string, limit = 100): Promise<PublicEndpointResult[]> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), 100);
  const payload = await request<{ results: PublicEndpointResult[] }>(
    `/api/v1/public-endpoints/${encodeURIComponent(id)}/history?limit=${bounded}`,
  );
  return Array.isArray(payload.results) ? payload.results : [];
}

/*
 * Windup Monitor Web — klient API konfiguracji AI.
 * Kontrakt: docs/ai-integration-contract.md (backend równolegle).
 * Wszystkie wywołania przez `request` z api/client (sesja w cookie + CSRF).
 * Brak localStorage na sekrety: klucze API trzymane tylko w stanie
 * formularza i czyszczone po zapisie.
 */

import { request } from "./client";

/** Logiczne ścieżki /api/ai pod istniejącym globalnym prefiksem /api/v1. */
const AI_BASE = "/api/v1/ai";

export type AiProvider = "openrouter" | "openai" | "chatgpt" | "custom";
export type AiExecutionMode = "monitor_only" | "approval_required" | "autonomous";

export interface AiSettings {
  provider: AiProvider | null;
  model: string | null;
  autoFree: boolean;
  executionMode: AiExecutionMode;
  customName: string | null;
  customBaseUrl: string | null;
}

export interface AiConnection {
  provider: string;
  connected: boolean;
  keyHint: string | null;
  lastCheckedAt: string | null;
}

export interface AiCapabilities {
  credentialStorage: boolean;
  chatgpt: boolean;
  chatgptReason: string | null;
}

export interface AiSettingsResponse {
  settings: AiSettings;
  connections: AiConnection[];
  capabilities: AiCapabilities;
}

export type AiSettingsPatch = Partial<AiSettings>;

/** Odczyt bazowego adresu custom: kanoniczny `baseUrl`, alias `customBaseUrl`. */
function readCustomBaseUrl(settings: Partial<AiSettings> & { baseUrl?: unknown }): string | null {
  if (typeof settings.customBaseUrl === "string") return settings.customBaseUrl;
  if (typeof settings.baseUrl === "string") return settings.baseUrl;
  return null;
}

function normalizeSettingsResponse(payload: unknown): AiSettingsResponse {
  const record = (payload ?? {}) as Partial<AiSettingsResponse>;
  const settings = (record.settings ?? {}) as Partial<AiSettings>;
  const executionMode: AiExecutionMode =
    settings.executionMode === "monitor_only" ||
    settings.executionMode === "autonomous" ||
    settings.executionMode === "approval_required"
      ? settings.executionMode
      : "approval_required";
  const provider: AiProvider | null =
    settings.provider === "openrouter" ||
    settings.provider === "openai" ||
    settings.provider === "chatgpt" ||
    settings.provider === "custom"
      ? settings.provider
      : null;
  return {
    settings: {
      provider,
      model: typeof settings.model === "string" ? settings.model : null,
      autoFree: settings.autoFree === true,
      executionMode,
      customName: typeof settings.customName === "string" ? settings.customName : null,
      customBaseUrl: readCustomBaseUrl(settings),
    },
    connections: Array.isArray(record.connections) ? record.connections : [],
    capabilities: {
      credentialStorage: record.capabilities?.credentialStorage === true,
      chatgpt: record.capabilities?.chatgpt === true,
      chatgptReason:
        typeof record.capabilities?.chatgptReason === "string"
          ? record.capabilities.chatgptReason
          : null,
    },
  };
}

export async function getAiSettings(): Promise<AiSettingsResponse> {
  const payload = await request<AiSettingsResponse>(`${AI_BASE}/settings`);
  return normalizeSettingsResponse(payload);
}

export async function updateAiSettings(patch: AiSettingsPatch): Promise<AiSettingsResponse> {
  const payload = await request<AiSettingsResponse>(`${AI_BASE}/settings`, {
    method: "PUT",
    body: patch,
  });
  return normalizeSettingsResponse(payload);
}

export async function saveAiConnection(
  provider: "openrouter" | "openai",
  apiKey: string,
): Promise<AiSettingsResponse> {
  const payload = await request<AiSettingsResponse>(
    `${AI_BASE}/connections/${encodeURIComponent(provider)}`,
    { method: "PUT", body: { apiKey } },
  );
  return normalizeSettingsResponse(payload);
}

export interface CustomConnectionInput {
  baseUrl: string;
  name?: string;
  /** Opcjonalny — lokalne serwery mogą działać bez auth. */
  apiKey?: string;
}

export async function saveCustomConnection(
  input: CustomConnectionInput,
): Promise<AiSettingsResponse> {
  const payload = await request<AiSettingsResponse>(`${AI_BASE}/connections/custom`, {
    method: "PUT",
    body: input,
  });
  return normalizeSettingsResponse(payload);
}

export async function testAiConnection(
  provider: "openrouter" | "openai" | "custom",
): Promise<{ ok: boolean; message: string }> {
  const payload = await request<{ ok?: unknown; message?: unknown }>(
    `${AI_BASE}/connections/${encodeURIComponent(provider)}/test`,
    { method: "POST", body: {} },
  );
  return {
    ok: payload.ok === true,
    message: typeof payload.message === "string" ? payload.message : "",
  };
}

export async function deleteAiConnection(
  provider: "openrouter" | "openai" | "custom",
): Promise<AiSettingsResponse> {
  const payload = await request<AiSettingsResponse>(
    `${AI_BASE}/connections/${encodeURIComponent(provider)}`,
    { method: "DELETE" },
  );
  return normalizeSettingsResponse(payload);
}

export interface AiUsage {
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  since: string | null;
  recent: unknown[];
}

export async function getAiUsage(): Promise<AiUsage> {
  const payload = await request<Partial<AiUsage>>(`${AI_BASE}/usage`);
  return {
    requests:
      typeof payload.requests === "number" && Number.isFinite(payload.requests)
        ? payload.requests
        : 0,
    inputTokens:
      typeof payload.inputTokens === "number" && Number.isFinite(payload.inputTokens)
        ? payload.inputTokens
        : null,
    outputTokens:
      typeof payload.outputTokens === "number" && Number.isFinite(payload.outputTokens)
        ? payload.outputTokens
        : null,
    costUsd:
      typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd)
        ? payload.costUsd
        : null,
    since: typeof payload.since === "string" ? payload.since : null,
    recent: Array.isArray(payload.recent) ? payload.recent : [],
  };
}

export async function startChatGptLogin(): Promise<{ authorizationUrl: string }> {
  const payload = await request<{ authorizationUrl?: unknown }>(`${AI_BASE}/chatgpt/login`, {
    method: "POST",
    body: {},
  });
  if (typeof payload.authorizationUrl !== "string" || payload.authorizationUrl.length === 0) {
    throw new Error("Serwer nie zwrócił adresu logowania ChatGPT.");
  }
  return { authorizationUrl: payload.authorizationUrl };
}

export interface ChatGptStatus {
  connected: boolean;
  pending: boolean;
  message: string | null;
}

export async function getChatGptStatus(): Promise<ChatGptStatus> {
  const payload = await request<Partial<ChatGptStatus>>(`${AI_BASE}/chatgpt/status`);
  return {
    connected: payload.connected === true,
    pending: payload.pending === true,
    message: typeof payload.message === "string" ? payload.message : null,
  };
}

export async function logoutChatGpt(): Promise<AiSettingsResponse> {
  const payload = await request<AiSettingsResponse>(`${AI_BASE}/chatgpt/logout`, {
    method: "POST",
    body: {},
  });
  return normalizeSettingsResponse(payload);
}

/*
 * Windup Monitor Web — klient API (kontrakt S1 implementuje Core).
 * Sesje w cookie (credentials: include). Mutacje dokładają X-CSRF-Token
 * pobrany z GET /api/v1/auth/me po zalogowaniu (+ X-Requested-With).
 */

import type { AgentSummary, MetricSample, PairingToken } from "../types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Normalizuje ścieżkę żądania do nazwy akcji: bez query/fragmentu, bez
 * końcowych `/`, ostatni segment ścieżki (`/api/v1/auth/login/` → `login`).
 */
function actionOf(path: string): string {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/** Generyczny komunikat dla błędów auth — szczegóły tylko w logu serwera. */
function messageFor(status: number, action: string): string {
  if (status === 401 || status === 403) {
    if (action === "login" || action === "bootstrap") {
      return "Nieprawidłowe dane logowania. Spróbuj ponownie.";
    }
    return "Sesja wygasła. Zaloguj się ponownie.";
  }
  if (status === 429) {
    return "Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.";
  }
  if (status >= 500) {
    return "Błąd serwera. Spróbuj ponownie za chwilę.";
  }
  return "Nieoczekiwany błąd. Spróbuj ponownie.";
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Wymuś generyczny komunikat (np. formularze auth). */
  genericError?: string;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, genericError } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (method !== "GET" && method !== "HEAD" && csrfToken) {
      headers["X-CSRF-Token"] = csrfToken;
    }
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "include",
        signal: controller.signal,
      });
    } catch {
      throw new ApiError(0, "Brak połączenia z serwerem. Sprawdź, czy Core działa, i spróbuj ponownie.");
    }
    if (response.status === 204) {
      return undefined as T;
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const record = payload as { message?: unknown; code?: unknown } | null;
      const code = typeof record?.code === "string" ? record.code : null;
      if (genericError) {
        throw new ApiError(response.status, genericError, code);
      }
      const serverMessage = typeof record?.message === "string" ? record.message : null;
      throw new ApiError(response.status, serverMessage ?? messageFor(response.status, actionOf(path)), code);
    }
    return payload as T;
  } finally {
    window.clearTimeout(timer);
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/* Auth */

export async function getAuthStatus(): Promise<{ initialized: boolean }> {
  return request<{ initialized: boolean }>("/api/v1/auth/status");
}

export async function bootstrap(input: { token: string; email: string; password: string }): Promise<void> {
  await request("/api/v1/auth/bootstrap", {
    method: "POST",
    body: input,
    genericError: "Nie udało się utworzyć konta. Sprawdź token i spróbuj ponownie.",
  });
}

export async function login(input: { email: string; password: string }): Promise<void> {
  await request("/api/v1/auth/login", {
    method: "POST",
    body: input,
    genericError: "Nieprawidłowy e-mail lub hasło.",
  });
}

export async function fetchMe(): Promise<{ email: string; csrfToken: string }> {
  const payload = await request<{ user: { email: string }; csrfToken: string }>("/api/v1/auth/me");
  setCsrfToken(payload.csrfToken);
  return { email: payload.user.email, csrfToken: payload.csrfToken };
}

export async function logout(): Promise<void> {
  try {
    await request("/api/v1/auth/logout", { method: "POST" });
  } finally {
    setCsrfToken(null);
  }
}

/* Agenci i metryki */

export async function listAgents(): Promise<AgentSummary[]> {
  const payload = await request<{ agents: AgentSummary[] }>("/api/v1/agents");
  return Array.isArray(payload.agents) ? payload.agents : [];
}

export async function getAgentMetrics(agentId: string): Promise<MetricSample[]> {
  const payload = await request<{ samples: MetricSample[] }>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/metrics`,
  );
  return Array.isArray(payload.samples) ? payload.samples : [];
}

export async function createPairingToken(): Promise<PairingToken> {
  return request<PairingToken>("/api/v1/agents/pairing-tokens", { method: "POST", body: {} });
}

export async function revokeAgent(agentId: string): Promise<void> {
  await request(`/api/v1/agents/${encodeURIComponent(agentId)}/revoke`, { method: "POST", body: {} });
}

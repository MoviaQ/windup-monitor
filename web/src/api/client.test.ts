import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "./client";

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({}), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Zwraca komunikat błędu, który dostaje użytkownik dla danej ścieżki. */
async function messageFor(
  url: string,
  status = 401,
  init?: { method?: string; body?: unknown },
): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => errorResponse(status)),
  );
  let caught: unknown;
  try {
    await request(url, init);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  return (caught as ApiError).message;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request — komunikat błędu auth zależy od znormalizowanej ścieżki", () => {
  it("401 na POST /api/v1/auth/login to błąd logowania, nie wygasła sesja", async () => {
    const message = await messageFor("/api/v1/auth/login", 401, {
      method: "POST",
      body: { email: "a@b.co", password: "x" },
    });
    expect(message).toBe("Nieprawidłowe dane logowania. Spróbuj ponownie.");
  });

  it("normalizuje query i końcowe / przed rozpoznaniem akcji", async () => {
    expect(await messageFor("/api/v1/auth/login/?next=%2Fdashboard", 401)).toBe(
      "Nieprawidłowe dane logowania. Spróbuj ponownie.",
    );
    expect(await messageFor("/api/v1/auth/bootstrap", 403)).toBe(
      "Nieprawidłowe dane logowania. Spróbuj ponownie.",
    );
  });

  it("401 na innych ścieżkach to nadal komunikat wygasłej sesji", async () => {
    expect(await messageFor("/api/v1/auth/me", 401)).toBe("Sesja wygasła. Zaloguj się ponownie.");
    expect(await messageFor("/api/v1/agents/", 401)).toBe("Sesja wygasła. Zaloguj się ponownie.");
    expect(await messageFor("/api/v1/agents/ag_01/metrics?from=x", 401)).toBe(
      "Sesja wygasła. Zaloguj się ponownie.",
    );
  });

  it("poza auth zachowuje komunikaty statusowe (429/5xx)", async () => {
    expect(await messageFor("/api/v1/auth/login", 429, { method: "POST", body: {} })).toBe(
      "Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.",
    );
    expect(await messageFor("/api/v1/agents", 503)).toBe("Błąd serwera. Spróbuj ponownie za chwilę.");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import {
  createService,
  deleteService,
  getServiceHistory,
  listDiscovered,
  listServices,
  updateService,
} from "./services";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("services api", () => {
  it("listServices zwraca tablicę usług", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ services: [{ id: "svc_1", status: "up" }] })),
    );
    await expect(listServices()).resolves.toEqual([{ id: "svc_1", status: "up" }]);
  });

  it("listDiscovered zwraca kandydatów", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ candidates: [{ candidateId: "jellyfin-8096" }] })),
    );
    await expect(listDiscovered()).resolves.toEqual([{ candidateId: "jellyfin-8096" }]);
  });

  it("createService wysyła POST z CSRF (sesja w cookie, bez wycieku auth w nagłówkach)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ service: { id: "svc_1" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const created = await createService({ agentId: "ag_1", candidateId: "jellyfin-8096" });
    expect(created).toEqual({ id: "svc_1" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("updateService wysyła PATCH, deleteService DELETE (204 → void)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      expect(url).toContain("/api/v1/services/svc_1");
      return jsonResponse({ service: { id: "svc_1", enabled: false } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(updateService("svc_1", { enabled: false })).resolves.toEqual({
      id: "svc_1",
      enabled: false,
    });
    await expect(deleteService("svc_1")).resolves.toBeUndefined();
  });

  it("getServiceHistory ogranicza limit do 500 i zwraca wyniki + incydenty", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ results: [{ checkedAt: "2026-10-19T10:00:00Z", ok: true }], incidents: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const history = await getServiceHistory("svc_1", 9999);
    expect(history.results).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("limit=500");
  });

  it("401 z API usług mapuje się na ApiError (wołający wylogowuje)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "UNAUTHENTICATED" }, 401)),
    );
    await expect(listServices()).rejects.toBeInstanceOf(ApiError);
  });
});

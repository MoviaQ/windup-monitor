import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";

const AGENT = {
  id: "ag_01",
  hostname: "nas-01",
  status: "online",
  lastSeenAt: new Date(Date.now() - 20_000).toISOString(),
  metrics: {
    cpuPercent: 23.4,
    memoryUsedBytes: 2 * 1024 * 1024 * 1024,
    memoryTotalBytes: 8 * 1024 * 1024 * 1024,
    diskUsedBytes: 40 * 1024 * 1024 * 1024,
    diskTotalBytes: 100 * 1024 * 1024 * 1024,
    uptimeSeconds: 90000,
    networkRxBytes: 123456789,
    networkTxBytes: 987654321,
  },
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DashboardPage", () => {
  it("pokazuje pusty stan parowania bez fikcyjnych hostów", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/agents") {
          return jsonResponse({ agents: [] });
        }
        return jsonResponse({}, 404);
      }),
    );
    render(<DashboardPage onSessionExpired={vi.fn()} />);

    expect(await screen.findByText("Brak sparowanych agentów")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Wygeneruj token parowania/ })).toBeInTheDocument();
    // Zero fikcyjnych hostów.
    expect(screen.queryByText(/demo|przykładowy|sample/i)).not.toBeInTheDocument();
  });

  it("generuje one-time token z datą ważności i instrukcją", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/agents") {
          return jsonResponse({ agents: [] });
        }
        if (url === "/api/v1/agents/pairing-tokens") {
          return jsonResponse({ token: "one-time-token-abc", expiresAt: "2026-10-19T13:00:00Z" });
        }
        return jsonResponse({}, 404);
      }),
    );
    render(<DashboardPage onSessionExpired={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Wygeneruj token parowania/ }));
    expect(await screen.findByText("one-time-token-abc")).toBeInTheDocument();
    expect(screen.getByText(/Token jednorazowy, ważny do/)).toBeInTheDocument();
    expect(screen.getByText(/Credential agenta zobaczy wyłącznie agent/)).toBeInTheDocument();
  });

  it("wyświetla agenta: status tekstem, interwał odświeżania i metryki", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/agents") {
          return jsonResponse({ agents: [AGENT] });
        }
        if (url === "/api/v1/agents/ag_01/metrics") {
          return jsonResponse({
            samples: [
              {
                sampledAt: "2026-10-19T12:00:00Z",
                cpuPercent: 10,
                memoryUsedBytes: 100,
                memoryTotalBytes: 200,
                diskUsedBytes: 10,
                diskTotalBytes: 100,
              },
              {
                sampledAt: "2026-10-19T12:00:15Z",
                cpuPercent: 25,
                memoryUsedBytes: 110,
                memoryTotalBytes: 200,
                diskUsedBytes: 10,
                diskTotalBytes: 100,
              },
            ],
          });
        }
        return jsonResponse({}, 404);
      }),
    );
    render(<DashboardPage onSessionExpired={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "nas-01" })).toBeInTheDocument();
    // Status tekstem w dwóch miejscach: element listy i panel detalu.
    expect(screen.getAllByText("Online")).toHaveLength(2);
    // Stały interwał zamiast licznika wieku danych ("X s temu" / "przed chwilą").
    expect(screen.getByText("Dane odświeżają się co 15 sekund")).toBeInTheDocument();
    expect(screen.queryByText(/\d+ s temu|przed chwilą/)).not.toBeInTheDocument();
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /Historia obciążenia CPU/ })).toBeInTheDocument();
    // Brak widocznej tabeli alternatywnej — opis jest tylko dla czytników ekranu.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("przy statusie stale mówi wprost o nieaktualności danych, bez twierdzenia o odświeżaniu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/agents") {
          return jsonResponse({ agents: [{ ...AGENT, status: "stale" }] });
        }
        if (url === "/api/v1/agents/ag_01/metrics") {
          return jsonResponse({ samples: [] });
        }
        return jsonResponse({}, 404);
      }),
    );
    render(<DashboardPage onSessionExpired={vi.fn()} />);

    expect(await screen.findByText(/Dane mogą być nieaktualne/)).toBeInTheDocument();
    expect(screen.queryByText(/Dane odświeżają się/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Automatyczne odświeżanie/)).not.toBeInTheDocument();
    // Ostatni znany odczyt jako timestamp, nie tykający licznik.
    expect(screen.getByText(/ostatni odczyt:/)).toBeInTheDocument();
  });

  it("przy 401 wylogowuje (sesja wygasła)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "unauthorized" }, 401)));
    const onSessionExpired = vi.fn();
    render(<DashboardPage onSessionExpired={onSessionExpired} />);

    await vi.waitFor(() => expect(onSessionExpired).toHaveBeenCalled());
  });

  it("offline: banner read-only i zablokowane akcje", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ agents: [] })));
    render(<DashboardPage onSessionExpired={vi.fn()} />);

    expect(await screen.findByText(/tylko do odczytu/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Wygeneruj token parowania/ })).toBeDisabled();
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });
});

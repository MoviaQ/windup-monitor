import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ServicesPage,
  canMonitorHttp,
  formatProcessCpu,
  formatProcessMemory,
  isSafePathInput,
  parseStatusesInput,
  recognitionText,
  thresholdOrDefault,
  unknownHint,
} from "./ServicesPage";

function service(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "svc_1",
    agentId: "ag_1",
    agentHostname: "host-a",
    name: "Jellyfin",
    candidateId: "jellyfin-8096",
    port: 8096,
    path: "/Health",
    expectedStatuses: [200],
    intervalSeconds: 30,
    timeoutSeconds: 5,
    enabled: true,
    status: "up",
    lastCheckedAt: "2026-10-19T10:00:30Z",
    lastStatusCode: 200,
    lastLatencyMs: 4.2,
    consecutiveFailures: 0,
    upSince: "2026-10-19T10:00:00Z",
    processStartedAt: "2026-10-19T08:00:00Z",
    processCpuPercent: 12.5,
    processMemoryRssBytes: 84 * 1024 * 1024,
    processMetricsAt: "2026-10-19T10:00:30Z",
    availabilityPercent: 100,
    observedSeconds: 60,
    unknownSeconds: 0,
    configRevision: 1,
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: "ag_1",
    agentHostname: "host-a",
    candidateId: "jellyfin-8096",
    name: "Jellyfin",
    kind: "jellyfin",
    port: 8096,
    transport: "http",
    source: "docker-proxy",
    confidence: "medium",
    processStartedAt: null,
    suggestedPath: "/Health",
    suggestedStatuses: [200],
    monitored: true,
    lastSeenAt: "2026-10-19T10:00:00Z",
    available: true,
    processCpuPercent: 12.5,
    processMemoryRssBytes: 84 * 1024 * 1024,
    processMetricsAt: "2026-10-19T10:00:00Z",
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function publicEndpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pe_1",
    serviceId: "svc_1",
    label: "Jellyfin (publiczny)",
    url: "https://filmy.moviak.quest/Health",
    enabled: true,
    intervalSeconds: 60,
    timeoutSeconds: 8,
    status: "up",
    lastCheckedAt: "2026-10-19T10:00:00Z",
    statusCode: 200,
    latencyMs: 2000,
    errorCode: null,
    ...overrides,
  };
}

function stubApi(options: {
  services?: Array<Record<string, unknown>>;
  candidates?: Array<Record<string, unknown>>;
  onFetch?: (url: string, init?: RequestInit) => Response | undefined;
  expired?: boolean;
}): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (options.expired && url.startsWith("/api/v1/services")) {
        return new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      const override = options.onFetch?.(url, init);
      if (override) return override;
      const json = (payload: unknown, status = 200): Response =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url === "/api/v1/services") return json({ services: options.services ?? [] });
      if (url === "/api/v1/services/discovered") {
        return json({ candidates: options.candidates ?? [] });
      }
      return json({}, 404);
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ServicesPage", () => {
  it('pokazuje zakladki Monitorowane i Wykryte; ukrywa nierozpoznane i nie-HTTP', async () => {
    stubApi({
      services: [service()],
      candidates: [
        candidate(),
        candidate({
          agentId: "ag_1",
          candidateId: "unknown-9999",
          name: "Nierozpoznana usługa",
          kind: "unknown",
          port: 9999,
          transport: "tcp",
          suggestedPath: null,
          suggestedStatuses: [],
          monitored: false,
        }),
      ],
    });
    render(<ServicesPage onSessionExpired={() => {}} />);

    expect(await screen.findByRole("tab", { name: /Monitorowane/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Wykryte na serwerach (1)" })).toBeInTheDocument();
    expect(await screen.findByText("Jellyfin")).toBeInTheDocument();
    expect(screen.getByText("Działa")).toBeInTheDocument();
    expect(screen.getByText(/Dane odświeżają się co 15 sekund/)).toBeInTheDocument();
    expect(screen.getByText("12.5%")).toBeInTheDocument();
    expect(screen.getByText("84.0 MiB")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Wykryte na serwerach/ }));
    expect(screen.queryByText("Nierozpoznana usługa")).not.toBeInTheDocument();
    expect(screen.queryByText(/monitoring HTTP jest niedostępny/)).not.toBeInTheDocument();
  });

  it('wlacza monitoring znanej uslugi jednym kliknieciem (confirm z domyslna sciezka)', async () => {
    const { calls } = stubApi({
      services: [],
      candidates: [candidate({ monitored: false, candidateId: "jellyfin-8096" })],
      onFetch: (url, init) => {
        if (url === "/api/v1/services" && init?.method === "POST") {
          return new Response(JSON.stringify({ service: service({ id: "svc_new" }) }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={() => {}} />);

    await user.click(await screen.findByRole("tab", { name: /Wykryte na serwerach/ }));
    const enableButtons = await screen.findAllByRole("button", { name: "Włącz monitoring" });
    await user.click(enableButtons[0]);
    // Confirm pokazuje domyślną ścieżkę Jellyfin i kody.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Ścieżka HTTP (względna)")).toHaveValue("/Health");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Włącz monitoring" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/v1/services" && c.init?.method === "POST")).toBe(true);
    });
  });

  it('pokazuje osobno czas uslugi i czas procesu (dwa rozne uptime) w Szczegolach', async () => {
    stubApi({ services: [service()], candidates: [] });
    render(<ServicesPage onSessionExpired={() => {}} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Szczegóły" }));
    expect(await screen.findByText(/Działa nieprzerwanie od/)).toBeInTheDocument();
    expect(screen.getByText(/Proces uruchomiono/)).toBeInTheDocument();
  });

  it('pokazuje brak pomiarow zamiast falszywego 100% przy braku drugiej probki', async () => {
    stubApi({
      services: [service({ availabilityPercent: null, status: "unknown", lastCheckedAt: null })],
      candidates: [],
    });
    render(<ServicesPage onSessionExpired={() => {}} />);
    expect(await screen.findByText("Za mało pomiarów")).toBeInTheDocument();
    expect(screen.queryByText(/100/)).not.toBeInTheDocument();
    expect(await screen.findByText(/Pierwszy pomiar w drodze/)).toBeInTheDocument();
  });

  it('401 wylogowuje (onSessionExpired), a pauza/edycja odrzuca bledne dane lokalnie', async () => {
    const onSessionExpired = vi.fn();
    stubApi({ services: [], candidates: [], expired: true });
    render(<ServicesPage onSessionExpired={onSessionExpired} />);
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalled());
  });

  it('pokazuje tylko rozpoznane, dostepne HTTP i liczy je zamiast wszystkich nasluchow', async () => {
    stubApi({
      services: [],
      candidates: [
        candidate({ monitored: false }),
        candidate({
          candidateId: "t3-code-3773",
          name: "T3 Code",
          kind: "t3-code",
          port: 3773,
          confidence: "high",
          monitored: false,
        }),
        candidate({
          candidateId: "unknown-9999",
          name: "Nierozpoznana usługa",
          kind: "unknown",
          port: 9999,
          transport: "tcp",
          suggestedPath: null,
          monitored: false,
        }),
        candidate({
          candidateId: "t3-code-5000",
          name: "T3 Code",
          kind: "t3-code",
          port: 5000,
          transport: "tcp",
          suggestedPath: null,
          monitored: false,
        }),
      ],
    });
    render(<ServicesPage onSessionExpired={() => {}} />);
    expect(await screen.findByRole("tab", { name: "Wykryte na serwerach (2)" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Wykryte na serwerach/ }));
    expect(screen.getAllByRole("button", { name: "Włącz monitoring" })).toHaveLength(2);
    expect(screen.queryByText("Nierozpoznana usługa")).not.toBeInTheDocument();
  });

  it('pokazuje i wlacza generyczny nasluch TCP z jawnym monitorable (kind unknown nie ukrywa)', async () => {
    const { calls } = stubApi({
      services: [],
      candidates: [
        candidate({
          candidateId: "generic-5432",
          name: "Moja baza",
          kind: "unknown",
          port: 5432,
          transport: "tcp",
          source: "proc",
          confidence: "low",
          monitorable: true,
          nameSource: "package-json",
          suggestedPath: null,
          suggestedStatuses: [],
          monitored: false,
        }),
      ],
      onFetch: (url, init) => {
        if (url === "/api/v1/services" && init?.method === "POST") {
          return new Response(JSON.stringify({ service: service({ id: "svc_tcp", transport: "tcp" }) }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={() => {}} />);

    expect(await screen.findByRole("tab", { name: "Wykryte na serwerach (1)" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Wykryte na serwerach/ }));
    expect(await screen.findByText("Moja baza")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Włącz monitoring TCP/ }));
    const dialog = await screen.findByRole("dialog");
    // Brak pol HTTP dla celu TCP.
    expect(within(dialog).queryByLabelText(/Ścieżka HTTP/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Włącz monitoring/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/v1/services" && c.init?.method === "POST");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
      expect(body.path).toBeUndefined();
      expect(body.expectedStatuses).toBeUndefined();
    });
  });

  it('pokazuje status "Pogorszenie" i osobny wpis o wykrytym restarcie', async () => {
    stubApi({
      services: [
        service({
          status: "degraded",
          consecutiveFailures: 1,
          lastErrorCode: "TIMEOUT",
          upSince: null,
          lastRestartAt: "2026-10-19T11:17:13Z",
        }),
      ],
      candidates: [],
    });
    render(<ServicesPage onSessionExpired={() => {}} />);
    expect(await screen.findByText("Pogorszenie")).toBeInTheDocument();
    expect(screen.getAllByText(/Ostatni pomiar nieudany/).length).toBeGreaterThan(0);
    // Dokładne daty (restart/proces) są pod „Szczegóły", nie na zwiniętej karcie.
    expect(screen.queryByText(/Wykryto restart procesu/)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Szczegóły" }));
    expect(await screen.findByText(/Wykryto restart procesu/)).toBeInTheDocument();
  });

  it('przy braku kandydatow pokazuje jasny komunikat zamiast technicznej listy', async () => {
    stubApi({
      services: [],
      candidates: [
        candidate({
          candidateId: "unknown-9999",
          name: "Nierozpoznana usługa",
          kind: "unknown",
          port: 9999,
          transport: "tcp",
          suggestedPath: null,
          monitored: false,
        }),
      ],
    });
    render(<ServicesPage onSessionExpired={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Wykryte na serwerach/ }));
    expect(
      screen.getByText("Nie znaleziono usług obsługiwanych przez monitoring"),
    ).toBeInTheDocument();
  });

  it('pokazuje Brak danych dla null i wartosc powyzej 100% bez clampowania', async () => {
    stubApi({
      services: [
        service({ processCpuPercent: null, processMemoryRssBytes: null }),
        service({
          id: "svc_2",
          name: "OpenCode",
          processCpuPercent: 137.5,
          processMemoryRssBytes: 2048 * 1024 * 1024,
        }),
      ],
      candidates: [],
    });
    render(<ServicesPage onSessionExpired={() => {}} />);
    expect(await screen.findByText("137.5%")).toBeInTheDocument();
    expect(screen.getByText("2048.0 MiB")).toBeInTheDocument();
    expect(screen.getAllByText("Brak danych").length).toBeGreaterThanOrEqual(2);
  });

  it('walidacja edycji: zla sciezka i kody blokuja zapis', async () => {
    stubApi({ services: [service()], candidates: [] });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Edytuj" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const pathInput = screen.getByLabelText("Ścieżka HTTP (względna)");
    await user.clear(pathInput);
    await user.type(pathInput, "http://evil.test/x");
    expect(screen.getByText(/musi zaczynać się pojedynczym/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    expect(screen.getByText("Ścieżka musi zaczynać się pojedynczym „/”.")).toBeInTheDocument();
  });

  it("edit rename zachowuje niestandardowe progi N5/M3 (bez resetu do 3/2)", async () => {
    let patchedBody: unknown = null;
    stubApi({
      services: [
        service({ id: "svc_nm", name: "Jellyfin", failureThreshold: 5, successThreshold: 3 }),
      ],
      candidates: [],
      onFetch: (url, init) => {
        if (url === "/api/v1/services/svc_nm" && init?.method === "PATCH") {
          patchedBody = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
          return new Response(
            JSON.stringify({
              service: service({
                id: "svc_nm",
                name: "Jellyfin (dom)",
                failureThreshold: 5,
                successThreshold: 3,
              }),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Edytuj" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/Próg awarii N/)).toHaveValue("5");
    expect(within(dialog).getByLabelText(/Próg powrotu M/)).toHaveValue("3");
    const nameInput = within(dialog).getByLabelText("Nazwa usługi");
    await user.clear(nameInput);
    await user.type(nameInput, "Jellyfin (dom)");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => {
      expect(patchedBody).toMatchObject({
        name: "Jellyfin (dom)",
        failureThreshold: 5,
        successThreshold: 3,
      });
    });
  });

  it("prefill progow wraca do 3/2 gdy DTO nie ma pol (transitional)", async () => {
    stubApi({ services: [service({ id: "svc_old" })], candidates: [] });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Edytuj" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/Próg awarii N/)).toHaveValue("3");
    expect(within(dialog).getByLabelText(/Próg powrotu M/)).toHaveValue("2");
  });

  it("błąd historii (500) nie znika sekcji publicznych URL-i", async () => {
    const { calls } = stubApi({
      services: [service()],
      candidates: [],
      onFetch: (url) => {
        if (url.startsWith("/api/v1/services/svc_1/history")) {
          return jsonResponse({ code: "INTERNAL" }, 500);
        }
        if (url.startsWith("/api/v1/services/svc_1/public-endpoints")) {
          return jsonResponse({ endpoints: [publicEndpoint()] });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={() => {}} />);

    // Podsumowanie publiczne jest już na zwiniętej karcie i nie czeka na historię.
    expect(await screen.findByText("Adres publiczny: odpowiada")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Szczegóły" }));

    expect(await screen.findByText("Nie udało się pobrać historii pomiarów.")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: /Publiczne adresy URL/ })).toBeInTheDocument();
    expect(screen.getByText("Jellyfin (publiczny)")).toBeInTheDocument();
    expect(
      calls.filter((c) => c.url.startsWith("/api/v1/services/svc_1/public-endpoints")),
    ).toHaveLength(1);
  });

  it("publiczne URL-e: 401 kończy sesję zamiast udawać pusty stan", async () => {
    const onSessionExpired = vi.fn();
    stubApi({
      services: [service()],
      candidates: [],
      onFetch: (url) => {
        if (url.startsWith("/api/v1/services/svc_1/public-endpoints")) {
          return jsonResponse({ code: "UNAUTHENTICATED" }, 401);
        }
        if (url.startsWith("/api/v1/services/svc_1/history")) {
          return jsonResponse({ results: [], incidents: [] });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={onSessionExpired} />);

    await user.click(await screen.findByRole("button", { name: "Szczegóły" }));
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    // Brak fałszywego „Brak dodanych adresów" i brak sekcji udającej pustą listę.
    expect(screen.queryByText("Brak dodanych adresów")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Publiczne adresy URL/ })).not.toBeInTheDocument();
  });

  it("pusty wynik [] to normalny stan, a ponowne rozwinięcie nie dubluje requestów", async () => {
    const { calls } = stubApi({
      services: [service()],
      candidates: [],
      onFetch: (url) => {
        if (url.startsWith("/api/v1/services/svc_1/history")) {
          return jsonResponse({ results: [], incidents: [] });
        }
        if (url.startsWith("/api/v1/services/svc_1/public-endpoints")) {
          return jsonResponse({ endpoints: [] });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "Szczegóły" }));
    expect(await screen.findByText("Brak dodanych adresów")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ukryj szczegóły" }));
    await user.click(screen.getByRole("button", { name: "Szczegóły" }));
    expect(await screen.findByText("Brak dodanych adresów")).toBeInTheDocument();
    expect(
      calls.filter((c) => c.url.startsWith("/api/v1/services/svc_1/public-endpoints")),
    ).toHaveLength(1);
  });

  it("status publicznego URL widoczny na ZWINIĘTEJ karcie, techniczne dane pod „Szczegóły”", async () => {
    stubApi({
      services: [service()],
      candidates: [],
      onFetch: (url) => {
        if (url.startsWith("/api/v1/services/svc_1/public-endpoints")) {
          return jsonResponse({ endpoints: [publicEndpoint()] });
        }
        if (url.startsWith("/api/v1/services/svc_1/history")) {
          return jsonResponse({ results: [], incidents: [] });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={() => {}} />);

    // Publiczny status bez żadnego rozwijania.
    expect(await screen.findByText("Adres publiczny: odpowiada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ukryj szczegóły" })).not.toBeInTheDocument();

    // Port/ścieżka/oczekiwane kody i dokładne daty są schowane pod „Szczegóły".
    expect(screen.queryByText(/port 8096/)).not.toBeInTheDocument();
    expect(screen.queryByText("Oczekiwane kody HTTP")).not.toBeInTheDocument();
    expect(screen.queryByText(/Działa nieprzerwanie od/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Szczegóły" }));
    expect(await screen.findByText("Oczekiwane kody HTTP")).toBeInTheDocument();
    expect(screen.getByText("8096 na hoście host-a")).toBeInTheDocument();
    expect(screen.getByText(/Działa nieprzerwanie od/)).toBeInTheDocument();
    // Sekcja CRuD dalej dostępna po rozwinięciu.
    expect(await screen.findByRole("region", { name: /Publiczne adresy URL/ })).toBeInTheDocument();
  });

  it("wiele adresów: awaria jednego nie chowa się za agregatem ani za drugim", async () => {
    stubApi({
      services: [service()],
      candidates: [],
      onFetch: (url) => {
        if (url.startsWith("/api/v1/services/svc_1/public-endpoints")) {
          return jsonResponse({
            endpoints: [
              publicEndpoint({ id: "pe_a", label: "Filmy", url: "https://filmy.example.com/" }),
              publicEndpoint({
                id: "pe_b",
                label: "Backup",
                url: "https://backup.example.com/",
                status: "down",
                statusCode: null,
                latencyMs: null,
                errorCode: "TIMEOUT",
              }),
            ],
          });
        }
        if (url.startsWith("/api/v1/services/svc_1/history")) {
          return jsonResponse({ results: [], incidents: [] });
        }
        return undefined;
      },
    });
    render(<ServicesPage onSessionExpired={() => {}} />);

    expect(await screen.findByText("Adres publiczny: nie odpowiada")).toBeInTheDocument();
    expect(screen.getByText("Filmy: odpowiada")).toBeInTheDocument();
    expect(screen.getByText("Backup: nie odpowiada")).toBeInTheDocument();
    expect(screen.queryByText("Adres publiczny: odpowiada")).not.toBeInTheDocument();
  });

  it("CRuD publicznego URL odświeża podsumowanie, bez dublowania requestów", async () => {
    let added = false;
    const { calls } = stubApi({
      services: [service()],
      candidates: [],
      onFetch: (url, init) => {
        if (url.startsWith("/api/v1/services/svc_1/public-endpoints")) {
          if (init?.method === "POST") {
            added = true;
            return jsonResponse({ endpoint: publicEndpoint() }, 201);
          }
          return jsonResponse({ endpoints: added ? [publicEndpoint()] : [] });
        }
        if (url.startsWith("/api/v1/services/svc_1/history")) {
          return jsonResponse({ results: [], incidents: [] });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<ServicesPage onSessionExpired={() => {}} />);

    const listCalls = () =>
      calls.filter(
        (c) =>
          c.url.startsWith("/api/v1/services/svc_1/public-endpoints") &&
          (!c.init?.method || c.init.method === "GET"),
      ).length;

    // Start bez adresów: subtelny komunikat, pusta lista to `[]`, nie błąd.
    expect(await screen.findByText("Adres publiczny: nie dodano")).toBeInTheDocument();
    expect(listCalls()).toBe(1);

    await user.click(screen.getByRole("button", { name: "Szczegóły" }));
    await user.click(await screen.findByRole("button", { name: /Dodaj publiczny URL/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Publiczny adres URL/), "https://filmy.example.com/");
    await user.click(within(dialog).getByRole("button", { name: "Dodaj adres" }));

    // Stan po CRuD widoczny od razu na zwiniętej karcie (reload po mutacji).
    expect(await screen.findByText("Adres publiczny: odpowiada")).toBeInTheDocument();
    expect(listCalls()).toBe(2);

    // Ponowne rozwinięcie nie dokład requestów.
    await user.click(screen.getByRole("button", { name: "Ukryj szczegóły" }));
    await user.click(screen.getByRole("button", { name: "Szczegóły" }));
    expect(await screen.findByRole("region", { name: /Publiczne adresy URL/ })).toBeInTheDocument();
    expect(listCalls()).toBe(2);
  });

  it("błąd pobrania publicznych adresów: neutralny stan, nie zielone „odpowiada”", async () => {
    stubApi({
      services: [service()],
      candidates: [],
      onFetch: (url) => {
        if (url.startsWith("/api/v1/services/svc_1/public-endpoints")) {
          return jsonResponse({ code: "INTERNAL" }, 500);
        }
        if (url.startsWith("/api/v1/services/svc_1/history")) {
          return jsonResponse({ results: [], incidents: [] });
        }
        return undefined;
      },
    });
    render(<ServicesPage onSessionExpired={() => {}} />);

    expect(await screen.findByText("Adres publiczny: stan nieznany")).toBeInTheDocument();
    expect(screen.queryByText(/Adres publiczny: odpowiada/)).not.toBeInTheDocument();
    expect(screen.queryByText("Brak dodanych adresów")).not.toBeInTheDocument();
  });
});

describe("walidatory uslug", () => {
  it("isSafePathInput odrzuca hosty i podejrzane znaki", () => {
    expect(isSafePathInput("/Health")).toBe(true);
    expect(isSafePathInput("/")).toBe(true);
    expect(isSafePathInput("//evil")).toBe(false);
    expect(isSafePathInput("http://evil.test/")).toBe(false);
    expect(isSafePathInput("/a@b")).toBe(false);
    expect(isSafePathInput("/a b")).toBe(false);
  });

  it("parseStatusesInput akceptuje 200 i 200, 401", () => {
    expect(parseStatusesInput("200")).toEqual([200]);
    expect(parseStatusesInput("401, 200")).toEqual([200, 401]);
    expect(parseStatusesInput("")).toBeNull();
    expect(parseStatusesInput("99")).toBeNull();
    expect(parseStatusesInput("abc")).toBeNull();
  });

  it("canMonitorHttp blokuje TCP (nie udaje HTTP)", () => {
    expect(canMonitorHttp(candidate({ transport: "http" }) as never)).toBe(true);
    expect(canMonitorHttp(candidate({ transport: "tcp" }) as never)).toBe(false);
  });

  it("thresholdOrDefault trzyma N/M z DTO, odrzuca braki i spoza 1-100", () => {
    expect(thresholdOrDefault(5, 3)).toBe(5);
    expect(thresholdOrDefault(undefined, 3)).toBe(3);
    expect(thresholdOrDefault(null, 2)).toBe(2);
    expect(thresholdOrDefault(0, 3)).toBe(3);
    expect(thresholdOrDefault(101, 3)).toBe(3);
    expect(thresholdOrDefault(2.5, 3)).toBe(3);
  });
});

describe("unknownHint", () => {
  const base = service({ status: "unknown", lastCheckedAt: "2026-10-19T10:00:00Z" });

  it("domyslny tekst bez pol backendu", () => {
    expect(unknownHint(base as never)).toContain("możliwe, że agent jest rozłączony");
  });

  it("uzywa agentStatus offline po polsku", () => {
    expect(unknownHint({ ...base, agentStatus: "offline" } as never)).toContain("agent rozłączony");
  });

  it("unknownReason ma pierwszenstwo nad agentStatus", () => {
    expect(
      unknownHint({ ...base, agentStatus: "offline", unknownReason: "Scheduler czeka" } as never),
    ).toBe("Scheduler czeka");
  });

  it("ignoruje nieznany i zdrowy agentStatus", () => {
    expect(unknownHint({ ...base, agentStatus: "cos" } as never)).toContain("możliwe");
    expect(unknownHint({ ...base, agentStatus: "online" } as never)).toContain("możliwe");
  });
});

describe("process metrics labels", () => {
  it("formatuje CPU/RAM i nie udaje zera przy braku danych", () => {
    expect(formatProcessCpu(null)).toBe("Brak danych");
    expect(formatProcessCpu(0)).toBe("0%");
    expect(formatProcessCpu(137.54)).toBe("137.5%");
    expect(formatProcessMemory(null)).toBe("Brak danych");
    expect(formatProcessMemory(84 * 1024 * 1024)).toBe("84.0 MiB");
  });

  it("uzywa dwoch zrozumialych etykiet zamiast zrzutu source", () => {
    expect(recognitionText(candidate({ confidence: "high" }) as never)).toBe(
      "Rozpoznano po procesie i porcie — Jellyfin, HTTP, port 8096 na hoście host-a.",
    );
    expect(recognitionText(candidate({ confidence: "medium" }) as never)).toBe(
      "Rozpoznanie częściowe — Jellyfin, HTTP, port 8096 na hoście host-a.",
    );
  });
});

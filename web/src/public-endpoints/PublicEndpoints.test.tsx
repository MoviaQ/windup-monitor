import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  PublicEndpointsSection,
  PublicStatusSummary,
  aggregatePublicStatus,
  formatPublicLatency,
  publicEndpointShortName,
  publicEndpointStatusText,
  reachabilityNote,
  validatePublicUrlInput,
} from "./PublicEndpoints";
import type { PublicEndpoint } from "./api";

// PublicEndpointsSection operuje na pełnym PublicEndpoint z api; testy
// pomocnicze akceptują okrojony kształt (te same pola statusu).

function endpoint(overrides: Partial<PublicEndpoint> = {}): PublicEndpoint {
  return {
    id: "ep1",
    serviceId: "svc1",
    label: null,
    url: "https://filmy.moviak.quest/Health",
    enabled: true,
    intervalSeconds: 60,
    timeoutSeconds: 8,
    status: "unknown",
    lastCheckedAt: null,
    statusCode: null,
    latencyMs: null,
    errorCode: null,
    ...overrides,
  };
}

describe("validatePublicUrlInput", () => {
  it("akceptuje domenę bez schematu i pełny https", () => {
    expect(validatePublicUrlInput("filmy.moviak.quest")).toBeNull();
    expect(validatePublicUrlInput("https://example.com/health")).toBeNull();
  });

  it("odrzuca http, porty, userinfo i puste z użytecznym komunikatem", () => {
    expect(validatePublicUrlInput("")).toMatch(/Podaj adres/);
    expect(validatePublicUrlInput("http://example.com/")).toMatch(/HTTPS|https/);
    expect(validatePublicUrlInput("https://example.com:8443/")).toMatch(/443/);
    expect(validatePublicUrlInput("https://u:p@example.com/")).toMatch(/logowania/);
    expect(validatePublicUrlInput("no to url")).toMatch(/spacji|Nieprawid/);
  });
});

describe("status copy", () => {
  it("mówi o odpowiedzi, nigdy o dostępności z całego internetu", () => {
    expect(publicEndpointStatusText(endpoint({ status: "up" }))).toBe("Publiczny adres odpowiada");
    expect(publicEndpointStatusText(endpoint({ status: "down" }))).toBe("Brak odpowiedzi");
    expect(publicEndpointStatusText(endpoint({ status: "unknown" }))).toBe("Jeszcze nie sprawdzono");
    expect(publicEndpointStatusText(endpoint({ status: "paused" }))).toBe("Sprawdzanie wstrzymane");
    const text = publicEndpointStatusText(endpoint({ status: "up" }));
    expect(text).not.toMatch(/całego internetu|publicznie dostępny/i);
  });

  it("klasyfikuje 3xx jako przekierowanie i 401 jako odpowiedź", () => {
    expect(reachabilityNote(endpoint({ statusCode: 302 }))).toMatch(/Przekierowanie/);
    expect(reachabilityNote(endpoint({ statusCode: 401 }))).toMatch(/odpowiada/);
    expect(reachabilityNote(endpoint({ statusCode: 200 }))).toBeNull();
  });

  it("nie pokazuje przekierowania ani 401 jako finalnego 'odpowiada zdrowo'", () => {
    expect(publicEndpointStatusText(endpoint({ status: "up", statusCode: 302, errorCode: "REDIRECT" })))
      .toMatch(/Przekierowanie/);
    expect(publicEndpointStatusText(endpoint({ status: "up", statusCode: 401, errorCode: "AUTH_REQUIRED" })))
      .toMatch(/wymaga logowania/);
    expect(publicEndpointStatusText(endpoint({ status: "down", errorCode: "TIMEOUT" })))
      .toBe("Brak odpowiedzi");
  });

  it("formatuje latency bez sekundowej precyzji wieku danych", () => {
    expect(formatPublicLatency(null)).toBe("—");
    expect(formatPublicLatency(3.456)).toBe("3.5 ms");
    expect(formatPublicLatency(123.4)).toBe("123 ms");
  });
});

describe("podsumowanie statusu na karcie (bez rozwijania)", () => {
  it("agregat: najgorszy stan wygrywa — awaria nie chowa się za drugim adresem", () => {
    const both = aggregatePublicStatus([
      endpoint({ id: "a", label: "Filmy", status: "up", statusCode: 200 }),
      endpoint({ id: "b", label: "Backup", status: "down", statusCode: null, errorCode: "TIMEOUT" }),
    ]);
    expect(both?.text).toBe("Adres publiczny: nie odpowiada");
    expect(both?.tone).toBe("status-badge--offline");

    const allUp = aggregatePublicStatus([
      endpoint({ id: "a", status: "up", statusCode: 200 }),
      endpoint({ id: "b", status: "up", statusCode: 200 }),
    ]);
    expect(allUp?.text).toBe("Adres publiczny: odpowiada");
    expect(allUp?.tone).toBe("status-badge--online");

    expect(aggregatePublicStatus([])).toBeNull();
  });

  it("wstrzymanie jest stanem osobnym, nie „up” i nie awarią", () => {
    const paused = aggregatePublicStatus([endpoint({ status: "paused", enabled: false })]);
    expect(paused?.text).toBe("Adres publiczny: sprawdzanie wstrzymane");
    expect(paused?.icon).toBe("pause");

    const mixed = aggregatePublicStatus([
      endpoint({ id: "a", status: "up", statusCode: 200 }),
      endpoint({ id: "b", status: "paused", enabled: false }),
    ]);
    expect(mixed?.text).toBe("Adres publiczny: odpowiada (część wstrzymana)");
  });

  it("3xx i 401/403 to jasne etykiety uwagi, nigdy zielone zdrowie", () => {
    const redirect = aggregatePublicStatus([endpoint({ status: "up", statusCode: 302, errorCode: "REDIRECT" })]);
    expect(redirect?.text).toBe("Adres publiczny: przekierowanie");
    expect(redirect?.tone).toBe("status-badge--stale");

    const auth = aggregatePublicStatus([
      endpoint({ status: "up", statusCode: 401, errorCode: "AUTH_REQUIRED" }),
    ]);
    expect(auth?.text).toBe("Adres publiczny: wymaga logowania");
    expect(auth?.tone).toBe("status-badge--stale");

    const unknown = aggregatePublicStatus([endpoint({ status: "unknown" })]);
    expect(unknown?.text).toBe("Adres publiczny: jeszcze nie sprawdzono");
    expect(unknown?.tone).toBe("status-badge--neutral");
  });

  it("render: brak danych neutralnie, brak adresów subtelnie, bez fałszywej zieleni", () => {
    const { rerender } = render(<PublicStatusSummary summary={undefined} />);
    expect(screen.getByText("Adres publiczny: sprawdzanie…")).toBeInTheDocument();

    rerender(
      <PublicStatusSummary summary={{ endpoints: null, state: "error", error: "off" }} />,
    );
    expect(screen.getByText("Adres publiczny: stan nieznany")).toBeInTheDocument();
    expect(screen.queryByText(/odpowiada/)).not.toBeInTheDocument();

    rerender(
      <PublicStatusSummary summary={{ endpoints: [], state: "idle", error: null }} />,
    );
    expect(screen.getByText("Adres publiczny: nie dodano")).toBeInTheDocument();

    rerender(
      <PublicStatusSummary
        summary={{
          endpoints: [
            endpoint({ id: "a", label: "Filmy", status: "up", statusCode: 200 }),
            endpoint({ id: "b", label: "Backup", status: "down", statusCode: null }),
          ],
          state: "idle",
          error: null,
        }}
      />,
    );
    expect(screen.getByText("Adres publiczny: nie odpowiada")).toBeInTheDocument();
    expect(screen.getByText("Filmy: odpowiada")).toBeInTheDocument();
    expect(screen.getByText("Backup: nie odpowiada")).toBeInTheDocument();
  });

  it("krótka nazwa adresu: etykieta, inaczej host (bez sekretów i zapytań)", () => {
    expect(publicEndpointShortName(endpoint({ label: "Jellyfin (publiczny)" }))).toBe("Jellyfin (publiczny)");
    expect(publicEndpointShortName(endpoint({ label: null }))).toBe("filmy.moviak.quest");
    expect(
      publicEndpointShortName(endpoint({ label: null, url: "https://filmy.moviak.quest/p?token=secret" })),
    ).toBe("filmy.moviak.quest");
  });
});

describe("PublicEndpointsSection", () => {
  const baseProps = {
    serviceId: "svc1",
    serviceName: "Jellyfin",
    readOnly: false,
    readOnlyHint: "",
    onChanged: vi.fn(),
    onSessionExpired: vi.fn(),
  };

  it("renderuje etykietę jako tekst (XSS-safe) i link z noopener", () => {
    const evil = endpoint({ label: "<img src=x onerror=alert(1)>", url: "https://example.com/" });
    render(<PublicEndpointsSection {...baseProps} endpoints={[evil]} />);
    const section = screen.getByLabelText(/Publiczne adresy URL/);
    expect(section.innerHTML).not.toContain("<img");
    expect(within(section).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    const link = within(section).getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
  });

  it("pokazuje stan pusty, limit i wstrzymanie bez roszczeń o vantage", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PublicEndpointsSection {...baseProps} endpoints={[]} />);
    expect(screen.getByText(/niezależny od lokalnego health/i)).toBeInTheDocument();

    rerender(
      <PublicEndpointsSection
        {...baseProps}
        endpoints={[endpoint({ status: "paused", enabled: false })]}
      />,
    );
    expect(screen.getByText("Sprawdzanie wstrzymane")).toBeInTheDocument();
    expect(screen.queryByText(/całego internetu/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: /dodaj publiczny url/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const input = screen.getByLabelText(/publiczny adres url/i);
    await user.type(input, "http://example.com/");
    expect(await screen.findByText(/Zwykły HTTP nie jest obsługiwany/)).toBeInTheDocument();
  });

  it("edycja pokazuje ostrzeżenie o czyszczeniu wyniku", async () => {
    const user = userEvent.setup();
    render(
      <PublicEndpointsSection
        {...baseProps}
        endpoints={[endpoint({ url: "https://old.example.com/" })]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edytuj" }));
    expect(await screen.findByText(/stare pomiary nigdy nie opisują nowego celu/i)).toBeInTheDocument();
  });
});

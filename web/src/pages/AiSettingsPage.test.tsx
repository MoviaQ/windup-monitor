import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSettingsPage } from "./AiSettingsPage";

const SETTINGS_BASE = {
  settings: {
    provider: "openrouter",
    model: "openrouter/free",
    autoFree: true,
    executionMode: "approval_required",
    customName: null,
    customBaseUrl: null,
  },
  connections: [
    { provider: "openrouter", connected: true, keyHint: "…abcd", lastCheckedAt: null },
    { provider: "openai", connected: false, keyHint: null, lastCheckedAt: null },
    { provider: "chatgpt", connected: false, keyHint: null, lastCheckedAt: null },
    { provider: "custom", connected: false, keyHint: null, lastCheckedAt: null },
  ],
  capabilities: { credentialStorage: true, chatgpt: true, chatgptReason: null },
};

const USAGE_EMPTY = {
  requests: 0,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  since: null,
  recent: [],
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Bazowy stub: ustawienia + puste zużycie + niepołączony ChatGPT. */
function stubBase(overrides?: {
  settings?: unknown;
  usage?: unknown;
  onCall?: (url: string, init?: RequestInit) => Response | null;
}): ReturnType<typeof vi.fn> {
  return stubFetch((url, init) => {
    const extra = overrides?.onCall?.(url, init);
    if (extra) return extra;
    if (url === "/api/v1/ai/settings" && (!init?.method || init.method === "GET")) {
      return json(overrides?.settings ?? SETTINGS_BASE);
    }
    if (url === "/api/v1/ai/settings" && init?.method === "PUT") {
      // Domyślna symulacja zapisu: scal patch z bieżącymi ustawieniami.
      const base = (overrides?.settings ?? SETTINGS_BASE) as typeof SETTINGS_BASE;
      const patch = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
      return json({ ...base, settings: { ...base.settings, ...patch } });
    }
    if (url === "/api/v1/ai/usage") return json(overrides?.usage ?? USAGE_EMPTY);
    if (url === "/api/v1/ai/chatgpt/status") {
      return json({ connected: false, pending: false, message: null });
    }
    return json({}, 404);
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AiSettingsPage", () => {
  it("pokazuje stan ładowania, potem panel i pusty stan zużycia (bez fikcyjnych statystyk)", async () => {
    const gate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/ai/settings") return gate.promise;
        if (url === "/api/v1/ai/usage") return json(USAGE_EMPTY);
        return json({}, 404);
      }),
    );
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);

    expect(screen.getByLabelText("Ładowanie konfiguracji AI")).toBeInTheDocument();

    gate.resolve(json(SETTINGS_BASE));
    // Najpierw treść stanu końcowego (pusty stan zużycia), potem nagłówek.
    expect(await screen.findByText("Brak zużycia do pokazania")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Konfiguracja AI" })).toBeInTheDocument();
    // Pusty stan: brak jakichkolwiek liczb zużycia.
    expect(screen.queryByText(/12345/)).not.toBeInTheDocument();
  });

  it("pokazuje błąd z przyciskiem Ponów przy niepowodzeniu ładowania", async () => {
    stubFetch(() => json({ message: "boom" }, 500));
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Ponów" })).toBeInTheDocument();
  });

  it("checkbox autoFree wyłącza ręczny model, a zapis klucza czyści pole", async () => {
    const user = userEvent.setup();
    const fetchMock = stubBase({
      onCall: (url, init) => {
        if (url === "/api/v1/ai/settings" && init?.method === "PUT") return json(SETTINGS_BASE);
        if (url === "/api/v1/ai/connections/openrouter" && init?.method === "PUT") {
          return json(SETTINGS_BASE);
        }
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    // autoFree zaznaczony => ręczny model OpenRouter disabled.
    expect(screen.getByLabelText("Automatycznie wybieraj darmowy model")).toBeChecked();
    expect(screen.getByLabelText("Model OpenRouter")).toBeDisabled();

    // Zapis klucza: PUT z apiKey, potem wyczyszczenie pola password.
    const openrouterCard = screen.getByLabelText("OpenRouter: połączono").closest("article");
    expect(openrouterCard).not.toBeNull();
    const card = within(openrouterCard as HTMLElement);
    const keyInput = card.getByLabelText("Klucz API OpenRouter") as HTMLInputElement;
    expect(keyInput).toHaveAttribute("type", "password");
    await user.type(keyInput, "sk-or-test-key");
    await user.click(card.getByRole("button", { name: "Zastąp klucz" }));
    expect(await card.findByText(/Zapisany klucz/)).toBeInTheDocument();
    expect(keyInput.value).toBe("");
    const putCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/v1/ai/connections/openrouter" &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect((putCall?.[1] as RequestInit)?.body).toContain("sk-or-test-key");
  });

  it("wyłączenie autoFree odblokowuje model i zapisuje preferencję", async () => {
    const user = userEvent.setup();
    const disabled = {
      ...SETTINGS_BASE,
      settings: { ...SETTINGS_BASE.settings, autoFree: false, model: "my-model" },
    };
    stubBase({
      onCall: (url, init) => {
        if (url === "/api/v1/ai/settings" && init?.method === "PUT") return json(disabled);
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    await user.click(screen.getByLabelText("Automatycznie wybieraj darmowy model"));
    expect(
      await screen.findByText("Wyłączono automatyczny wybór darmowego modelu."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Model OpenRouter")).not.toBeDisabled();
  });

  it("test połączenia pokazuje wynik, a rozłączenie wysyła DELETE", async () => {
    const user = userEvent.setup();
    const disconnected = {
      ...SETTINGS_BASE,
      connections: SETTINGS_BASE.connections.map((c) =>
        c.provider === "openrouter" ? { ...c, connected: false, keyHint: null } : c,
      ),
    };
    const fetchMock = stubBase({
      onCall: (url, init) => {
        if (url === "/api/v1/ai/connections/openrouter/test") {
          return json({ ok: true, message: "Klucz działa." });
        }
        if (url === "/api/v1/ai/connections/openrouter" && init?.method === "DELETE") {
          return json(disconnected);
        }
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    const openrouterCard = screen.getByLabelText("OpenRouter: połączono").closest("article");
    expect(openrouterCard).not.toBeNull();
    const card = within(openrouterCard as HTMLElement);

    await user.click(card.getByRole("button", { name: "Testuj połączenie" }));
    expect(await card.findByText("Klucz działa.")).toBeInTheDocument();

    await user.click(card.getByRole("button", { name: "Rozłącz" }));
    expect(await screen.findByLabelText("OpenRouter: nie połączono")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url === "/api/v1/ai/connections/openrouter" &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("tryby pracy zapisują preferencję z opisem o braku napraw", async () => {
    const user = userEvent.setup();
    const autonomous = {
      ...SETTINGS_BASE,
      settings: { ...SETTINGS_BASE.settings, executionMode: "autonomous" },
    };
    stubBase({
      onCall: (url, init) => {
        if (url === "/api/v1/ai/settings" && init?.method === "PUT") return json(autonomous);
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    // Domyślny tryb approval_required.
    expect(screen.getByRole("radio", { name: /Działania po zatwierdzeniu/ })).toBeChecked();
    expect(
      screen.getByText(/zapisują dziś wyłącznie preferencje pod przyszłe funkcje/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Automatyczne naprawy/ }));
    expect(await screen.findByText("Zapisano tryb pracy: Automatyczne naprawy.")).toBeInTheDocument();
  });

  it("wyłączone ChatGPT pokazuje powód i blokuje logowanie", async () => {
    const user = userEvent.setup();
    const noChatGpt = {
      ...SETTINGS_BASE,
      capabilities: {
        credentialStorage: true,
        chatgpt: false,
        chatgptReason: "Brak konfiguracji OAuth po stronie serwera.",
      },
    };
    stubBase({ settings: noChatGpt });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    // Karta ChatGPT pokazuje się dopiero po wyborze tego dostawcy.
    await user.click(screen.getByRole("radio", { name: /ChatGPT/ }));
    expect(await screen.findByText(/Brak konfiguracji OAuth/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zaloguj przez ChatGPT" })).toBeDisabled();
  });

  it("logowanie ChatGPT otwiera URL i pokazuje stan pending bez udawania sukcesu", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    stubBase({
      onCall: (url, init) => {
        if (url === "/api/v1/ai/chatgpt/status") {
          return json({ connected: false, pending: true, message: "Oczekuje na dokończenie" });
        }
        if (url === "/api/v1/ai/chatgpt/login") {
          return json({ authorizationUrl: "https://example.com/oauth/start" });
        }
        if (url === "/api/v1/ai/settings" && init?.method === "PUT") return json(SETTINGS_BASE);
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    await user.click(screen.getByRole("radio", { name: /ChatGPT/ }));
    await user.click(screen.getByRole("button", { name: "Zaloguj przez ChatGPT" }));
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/oauth/start",
      "_blank",
      expect.stringContaining("noopener"),
    );
    expect(await screen.findByText(/Oczekuje na dokończenie/)).toBeInTheDocument();
    expect(screen.queryByLabelText("ChatGPT: połączono")).not.toBeInTheDocument();
  });

  it("zużycie z danymi pokazuje liczby, a null jako pauzę", async () => {
    const usage = {
      requests: 7,
      inputTokens: 1200,
      outputTokens: null,
      costUsd: null,
      since: "2026-10-01T00:00:00Z",
      recent: [],
    };
    stubBase({ usage });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    const usageSection = screen.getByLabelText("Zużycie agenta").closest("section");
    expect(usageSection).not.toBeNull();
    const section = within(usageSection as HTMLElement);
    expect(await section.findByText("7")).toBeInTheDocument();
    expect(section.getByText("1200")).toBeInTheDocument();
    // Nullable tokeny/koszt bez danych: pauza, nigdy zera ani fikcyjne statystyki.
    expect(section.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Tylko ta aplikacja/)).toBeInTheDocument();
  });

  it("własne API: zapis z base URL, test i rozłączenie; klucz opcjonalny", async () => {    const user = userEvent.setup();
    const fetchMock = stubBase({
      onCall: (url, init) => {
        if (url === "/api/v1/ai/connections/custom" && init?.method === "PUT") {
          return json({
            ...SETTINGS_BASE,
            settings: {
              ...SETTINGS_BASE.settings,
              customName: "Lokalny",
              customBaseUrl: "http://localhost:11434/v1",
            },
            connections: SETTINGS_BASE.connections.map((c) =>
              c.provider === "custom" ? { ...c, connected: true } : c,
            ),
          });
        }
        if (url === "/api/v1/ai/settings" && init?.method === "PUT") {
          return json({
            ...SETTINGS_BASE,
            settings: {
              ...SETTINGS_BASE.settings,
              customName: "Lokalny",
              customBaseUrl: "http://localhost:11434/v1",
            },
            connections: SETTINGS_BASE.connections.map((c) =>
              c.provider === "custom" ? { ...c, connected: true } : c,
            ),
          });
        }
        if (url === "/api/v1/ai/connections/custom/test") {
          return json({ ok: true, message: "Serwer odpowiada." });
        }
        if (url === "/api/v1/ai/connections/custom" && init?.method === "DELETE") {
          return json(SETTINGS_BASE);
        }
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    // Jeden widoczny formularz: kartę custom otwiera wybór dostawcy.
    await user.click(screen.getByRole("radio", { name: /Własne API/ }));

    const customCard = screen.getByLabelText("Własne API: nie połączono").closest("article");
    expect(customCard).not.toBeNull();
    const card = within(customCard as HTMLElement);

    // Zgodność tylko z API OpenAI — jasno w opisie, bez obietnic innych formatów.
    expect(card.getByText(/zgodny z API OpenAI/)).toBeInTheDocument();

    // Zły adres blokuje zapis z czytelnym błędem, bez wywołania sieci.
    await user.type(card.getByLabelText("Bazowy adres API"), "ftp://zly-adres");
    await user.click(card.getByRole("button", { name: "Zapisz połączenie" }));
    expect(await card.findByText("Adres musi zaczynać się od http:// lub https://.")).toBeInTheDocument();

    const callsBefore = fetchMock.mock.calls.length;
    await user.clear(card.getByLabelText("Bazowy adres API"));
    await user.type(card.getByLabelText("Bazowy adres API"), "http://localhost:11434/v1");
    await user.type(card.getByLabelText("Nazwa połączenia (opcjonalna)"), "Lokalny");
    // Klucz pusty — lokalne serwery bez auth.
    await user.click(card.getByRole("button", { name: "Zapisz połączenie" }));
    expect(await screen.findByLabelText("Własne API: połączono")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
    const putCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/v1/ai/connections/custom" &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    const body = String((putCall?.[1] as RequestInit)?.body ?? "");
    expect(body).toContain("http://localhost:11434/v1");
    expect(body).toContain('"name":"Lokalny"');
    // Brak klucza w body = bez zmian (nie kasuje zapisanego klucza).
    expect(body).not.toContain("apiKey");

    const connectedCard = screen.getByLabelText("Własne API: połączono").closest("article");
    const connected = within(connectedCard as HTMLElement);
    await user.click(connected.getByRole("button", { name: "Testuj połączenie" }));
    expect(await connected.findByText("Serwer odpowiada.")).toBeInTheDocument();

    await user.click(connected.getByRole("button", { name: "Rozłącz" }));
    expect(await screen.findByLabelText("Własne API: nie połączono")).toBeInTheDocument();
  });

  it("pierwsze ustawianie custom z modelem: jeden PUT wybiera provider+model (bez 400)", async () => {
    const user = userEvent.setup();
    const fresh = {
      ...SETTINGS_BASE,
      settings: {
        ...SETTINGS_BASE.settings,
        provider: null,
        model: null,
      },
      connections: SETTINGS_BASE.connections.map((c) => ({ ...c, connected: false, keyHint: null })),
    };
    const fetchMock = stubBase({
      settings: fresh,
      onCall: (url, init) => {
        if (url === "/api/v1/ai/connections/custom" && init?.method === "PUT") {
          return json({
            ...fresh,
            settings: { ...fresh.settings, customName: "", customBaseUrl: "http://srv:11434/v1" },
          });
        }
        if (url === "/api/v1/ai/settings" && init?.method === "PUT") {
          return json({
            ...fresh,
            settings: {
              ...fresh.settings,
              provider: "custom",
              model: "local-model",
              customName: "",
              customBaseUrl: "http://srv:11434/v1",
            },
            connections: fresh.connections.map((c) =>
              c.provider === "custom" ? { ...c, connected: true } : c,
            ),
          });
        }
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    // Jeden widoczny formularz: kartę custom otwiera wybór dostawcy.
    await user.click(screen.getByRole("radio", { name: /Własne API/ }));

    const customCard = screen.getByLabelText("Własne API: nie połączono").closest("article");
    const card = within(customCard as HTMLElement);
    await user.type(card.getByLabelText("Bazowy adres API"), "http://srv:11434/v1");
    await user.type(card.getByLabelText("Model"), "local-model");
    await user.click(card.getByRole("button", { name: "Zapisz połączenie" }));

    expect(await screen.findByLabelText("Własne API: połączono")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Własne API/ })).toBeChecked();
    const settingsPuts = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/v1/ai/settings" &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    // Dokładnie jeden PUT settings — z providerem i modelem razem, nie sam model.
    expect(settingsPuts).toHaveLength(1);
    expect(String((settingsPuts[0][1] as RequestInit)?.body ?? "")).toContain(
      '"provider":"custom"',
    );
    expect(String((settingsPuts[0][1] as RequestInit)?.body ?? "")).toContain(
      '"model":"local-model"',
    );
  });

  it("edycja custom przy obcym providerze nie rusza jego modelu (brak PUT settings)", async () => {
    const user = userEvent.setup();
    const openaiActive = {
      ...SETTINGS_BASE,
      settings: { ...SETTINGS_BASE.settings, provider: "openai", model: "gpt-4o-mini" },
    };
    const fetchMock = stubBase({
      settings: openaiActive,
      onCall: (url, init) => {
        if (url === "/api/v1/ai/connections/custom" && init?.method === "PUT") {
          return json({
            ...openaiActive,
            settings: { ...openaiActive.settings, customBaseUrl: "http://srv:11434/v1" },
            connections: openaiActive.connections.map((c) =>
              c.provider === "custom" ? { ...c, connected: true } : c,
            ),
          });
        }
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    // Jeden widoczny formularz: kartę custom otwiera wybór dostawcy.
    await user.click(screen.getByRole("radio", { name: /Własne API/ }));

    const customCard = screen.getByLabelText("Własne API: nie połączono").closest("article");
    const card = within(customCard as HTMLElement);
    await user.type(card.getByLabelText("Bazowy adres API"), "http://srv:11434/v1");
    await user.click(card.getByRole("button", { name: "Zapisz połączenie" }));

    expect(await screen.findByLabelText("Własne API: połączono")).toBeInTheDocument();
    // Model obcego providera nietknięty: zero PUT settings; zapisany dostawca
    // bez zmian, podglądany formularz custom czeka na treść.
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url === "/api/v1/ai/settings" &&
          (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toBe(false);
    expect(screen.getByText("Zapisany dostawca: OpenAI — ten formularz (Własne API) nie jest jeszcze aktywny.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Własne API/ })).toBeChecked();
  });

  it("rozłączenie custom czyści URL/nazwę i selekcję gdy backend tak odpowie", async () => {
    const user = userEvent.setup();
    const customActive = {
      ...SETTINGS_BASE,
      settings: {
        ...SETTINGS_BASE.settings,
        provider: "custom",
        model: "local-model",
        customName: "Lokalny",
        customBaseUrl: "http://srv:11434/v1",
      },
      connections: SETTINGS_BASE.connections.map((c) =>
        c.provider === "custom" ? { ...c, connected: true } : c,
      ),
    };
    const cleared = {
      ...SETTINGS_BASE,
      settings: {
        ...SETTINGS_BASE.settings,
        provider: null,
        model: null,
        customName: null,
        customBaseUrl: null,
      },
      connections: SETTINGS_BASE.connections.map((c) => ({ ...c, connected: false, keyHint: null })),
    };
    stubBase({
      settings: customActive,
      onCall: (url, init) => {
        if (url === "/api/v1/ai/connections/custom" && init?.method === "DELETE") {
          return json(cleared);
        }
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    const customCard = screen.getByLabelText("Własne API: połączono").closest("article");
    const card = within(customCard as HTMLElement);
    await user.click(card.getByRole("button", { name: "Rozłącz" }));

    // Selekcja spójnie wyczyszczona: prompt braku wyboru i domyślny widok.
    expect(
      await screen.findByText("Nie wybrano dostawcy — wybierz jedną z opcji powyżej."),
    ).toBeInTheDocument();
    // Otwarty ponownie formularz custom pokazuje wyczyszczone pola z serwera.
    await user.click(screen.getByRole("radio", { name: /Własne API/ }));
    expect(await screen.findByLabelText("Własne API: nie połączono")).toBeInTheDocument();
    expect(screen.getByLabelText("Bazowy adres API")).toHaveValue("");
    expect(screen.getByLabelText("Nazwa połączenia (opcjonalna)")).toHaveValue("");
  });

  it("odczytuje kanoniczny baseUrl z odpowiedzi (alias customBaseUrl opcjonalny)", async () => {
    const canonical = {
      ...SETTINGS_BASE,
      settings: {
        provider: "custom",
        model: "local-model",
        autoFree: false,
        executionMode: "approval_required",
        customName: "Lokalny",
        baseUrl: "http://localhost:11434/v1",
      },
    };
    stubBase({ settings: canonical });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    expect(screen.getByLabelText("Bazowy adres API")).toHaveValue("http://localhost:11434/v1");
    expect(screen.getByLabelText("Nazwa połączenia (opcjonalna)")).toHaveValue("Lokalny");
  });

  it("zmiana dostawcy na openrouter przy autoFree dołącza model free (kontrakt §3.4)", async () => {
    const user = userEvent.setup();
    const withOpenrouter = {
      ...SETTINGS_BASE,
      settings: {
        ...SETTINGS_BASE.settings,
        provider: "openai",
        model: "gpt-4o-mini",
        autoFree: true,
      },
    };
    const fetchMock = stubBase({
      settings: withOpenrouter,
      onCall: (url, init) => {
        if (url === "/api/v1/ai/settings" && init?.method === "PUT") {
          return json({
            ...withOpenrouter,
            settings: { ...withOpenrouter.settings, provider: "openrouter", model: "openrouter/free" },
          });
        }
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    await user.click(screen.getByRole("radio", { name: /OpenRouter/ }));
    expect(await screen.findByText("Zapisano dostawcę AI.")).toBeInTheDocument();
    const putCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/v1/ai/settings" &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    const body = String((putCall?.[1] as RequestInit)?.body ?? "");
    expect(body).toContain('"provider":"openrouter"');
    expect(body).toContain('"model":"openrouter/free"');
  });

  it("pierwsze kliknięcie custom otwiera formularz bez błędu i bez PUT", async () => {
    const user = userEvent.setup();
    const fetchMock = stubBase();
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    // Sam wybór custom to tylko widok: formularz widoczny, zero PUT settings,
    // zero banera „Najpierw zapisz bazowy adres API”.
    await user.click(screen.getByRole("radio", { name: /Własne API/ }));
    expect(await screen.findByLabelText("Własne API: nie połączono")).toBeInTheDocument();
    expect(screen.queryByText(/potem wybierz tego dostawcę/)).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url === "/api/v1/ai/settings" &&
          (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toBe(false);
    // Tylko jedna karta: pozostałe formularze schowane.
    expect(screen.queryByLabelText(/OpenRouter:/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Model OpenAI")).not.toBeInTheDocument();
    // Zapisany dostawca bez zmian — widać rozjazd widoku z konfiguracją.
    expect(screen.getByText(/Zapisany dostawca: OpenRouter/)).toBeInTheDocument();
  });

  it("wybór pokazuje wyłącznie jeden formularz, a przełączanie nie przenosi sekretów", async () => {
    const user = userEvent.setup();
    stubBase();
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    // Start: tylko karta OpenRouter (provider zapisany = podglądany).
    expect(screen.getByLabelText("OpenRouter: połączono")).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI:/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/ChatGPT:/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Własne API:/)).not.toBeInTheDocument();

    // Wpisany (niezapisany) sekret w karcie OpenRouter.
    const openrouterCard = screen.getByLabelText("OpenRouter: połączono").closest("article");
    const orCard = within(openrouterCard as HTMLElement);
    const orKey = orCard.getByLabelText("Klucz API OpenRouter") as HTMLInputElement;
    expect(orKey).toHaveAttribute("type", "password");
    await user.type(orKey, "sk-or-typed-secret");

    // Przełączenie na OpenAI: jedna karta, sekret nie wyciekł do obcego pola.
    await user.click(screen.getByRole("radio", { name: /OpenAI \(klucz API\)/ }));
    expect(await screen.findByLabelText("OpenAI: nie połączono")).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenRouter:/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Klucz API OpenAI")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Klucz API OpenAI")).toHaveValue("");

    // Powrót: odmontowana karta nie zachowała wpisanego sekretu.
    await user.click(screen.getByRole("radio", { name: /OpenRouter/ }));
    const openrouterCard2 = await screen.findByLabelText("OpenRouter: połączono");
    const orCard2 = within(openrouterCard2.closest("article") as HTMLElement);
    expect(orCard2.getByLabelText("Klucz API OpenRouter")).toHaveValue("");
  });

  it("niekompletny wybór aktywuje się przyciskiem dopiero po uzupełnieniu modelu", async () => {
    const user = userEvent.setup();
    const fresh = {
      ...SETTINGS_BASE,
      settings: { ...SETTINGS_BASE.settings, provider: null, model: null },
      connections: SETTINGS_BASE.connections.map((c) => ({ ...c, connected: false, keyHint: null })),
    };
    const fetchMock = stubBase({
      settings: fresh,
      onCall: (url, init) => {
        if (url === "/api/v1/ai/settings" && init?.method === "PUT") {
          const patch = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          return json({ ...fresh, settings: { ...fresh.settings, ...patch } });
        }
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    // Brak zapisanej konfiguracji: prompt + domyślny widok.
    expect(
      screen.getByText("Nie wybrano dostawcy — wybierz jedną z opcji powyżej."),
    ).toBeInTheDocument();

    // Klik OpenAI bez modelu: sam widok, przycisk zablokowany, zero PUT.
    await user.click(screen.getByRole("radio", { name: /OpenAI \(klucz API\)/ }));
    expect(await screen.findByLabelText("OpenAI: nie połączono")).toBeInTheDocument();
    const activate = screen.getByRole("button", { name: "Użyj tego dostawcy" });
    expect(activate).toBeDisabled();
    expect(screen.getByText(/Wpisz model w formularzu powyżej/)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url === "/api/v1/ai/settings" &&
          (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toBe(false);

    // Po wpisaniu modelu aktywacja przechodzi z providerem i modelem razem.
    await user.type(screen.getByLabelText("Model OpenAI"), "gpt-4o-mini");
    expect(activate).toBeEnabled();
    await user.click(activate);
    expect(await screen.findByText("Zapisano dostawcę AI.")).toBeInTheDocument();
    const putCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/v1/ai/settings" &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    const body = String((putCall?.[1] as RequestInit)?.body ?? "");
    expect(body).toContain('"provider":"openai"');
    expect(body).toContain('"model":"gpt-4o-mini"');
  });

  it("brak credentialStorage: ostrzeżenie i zablokowany zapis klucza", async () => {
    const noStorage = {
      ...SETTINGS_BASE,
      capabilities: { credentialStorage: false, chatgpt: false, chatgptReason: "x" },
    };
    stubBase({ settings: noStorage });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    expect(await screen.findByText(/Przechowywanie kluczy jest niedostępne/)).toBeInTheDocument();
    const openrouterCard = screen.getByLabelText("OpenRouter: połączono").closest("article");
    const card = within(openrouterCard as HTMLElement);
    expect(card.getByRole("button", { name: "Zastąp klucz" })).toBeDisabled();
  });

  it("autoFree przy innym providerze nie nadpisuje ręcznego modelu", async () => {
    const user = userEvent.setup();
    const openaiManual = {
      ...SETTINGS_BASE,
      settings: { ...SETTINGS_BASE.settings, provider: "openai", model: "gpt-4o-mini", autoFree: false },
    };
    const fetchMock = stubBase({
      settings: openaiManual,
      onCall: (url, init) => {
        if (url === "/api/v1/ai/settings" && init?.method === "PUT") {
          return json({
            ...openaiManual,
            settings: { ...openaiManual.settings, autoFree: true },
          });
        }
        return null;
      },
    });
    render(<AiSettingsPage onSessionExpired={vi.fn()} />);
    await screen.findByRole("heading", { name: "Konfiguracja AI" });

    await user.click(screen.getByLabelText("Automatycznie wybieraj darmowy model"));
    expect(
      await screen.findByText("Włączono automatyczny wybór darmowego modelu."),
    ).toBeInTheDocument();
    const putCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/v1/ai/settings" &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    const body = String((putCall?.[1] as RequestInit)?.body ?? "");
    expect(body).toContain('"autoFree":true');
    expect(body).not.toContain("openrouter/free");
    // Ręczny model OpenAI nadal edytowalny (autoFree dotyczy tylko OpenRoutera).
    expect(screen.getByLabelText("Model OpenAI")).not.toBeDisabled();
  });
});

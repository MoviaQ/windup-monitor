/* Windup Monitor Web — panel konfiguracji AI: podpięcie dostawcy bez funkcji agenta.
 * Zapisuje wyłącznie preferencje (dostawca, model, tryb pracy) pod przyszłe
 * funkcje; niczego nie naprawia ani nie uruchamia automatycznie.
 */

import { useCallback, useEffect, useState } from "react";
import {
  deleteAiConnection,
  getAiSettings,
  getAiUsage,
  getChatGptStatus,
  logoutChatGpt,
  saveAiConnection,
  saveCustomConnection,
  startChatGptLogin,
  testAiConnection,
  updateAiSettings,
  type AiConnection,
  type AiExecutionMode,
  type AiProvider,
  type AiSettingsResponse,
  type AiUsage,
  type ChatGptStatus,
} from "../api/ai";
import { isUnauthorized } from "../api/client";
import { Banner } from "../components/Banner";
import { Icon } from "../components/Icon";
import { TextField } from "../components/TextField";
import { formatDateTime } from "../utils/format";

const FREE_MODEL_ID = "openrouter/free";

const PROVIDER_OPTIONS = [
  { value: "openrouter", label: "OpenRouter (klucz API)", shortLabel: "OpenRouter" },
  { value: "openai", label: "OpenAI (klucz API)", shortLabel: "OpenAI" },
  { value: "chatgpt", label: "ChatGPT (abonament, logowanie)", shortLabel: "ChatGPT" },
  { value: "custom", label: "Własne API (zgodne z OpenAI)", shortLabel: "Własne API" },
] satisfies Array<{ value: AiProvider; label: string; shortLabel: string }>;

function providerShortLabel(provider: AiProvider | null): string {
  return PROVIDER_OPTIONS.find((option) => option.value === provider)?.shortLabel ?? "brak";
}

const EXECUTION_MODES: Array<{
  value: AiExecutionMode;
  title: string;
  description: string;
}> = [
  {
    value: "monitor_only",
    title: "Analiza i sugestie",
    description: "Tylko podgląd i propozycje — bez żadnych działań.",
  },
  {
    value: "approval_required",
    title: "Działania po zatwierdzeniu",
    description: "Domyślny. Przyszłe działania wymagałyby Twojej zgody.",
  },
  {
    value: "autonomous",
    title: "Automatyczne naprawy",
    description: "Przyszła opcja samodzielnych działań — dziś tylko zapis preferencji.",
  },
];

function connectionFor(connections: AiConnection[], provider: string): AiConnection | null {
  return connections.find((c) => c.provider === provider) ?? null;
}

/** Nullable metryka: liczba albo pauza — nigdy fikcyjne statystyki. */
function nullableMetric(value: number | null, format: (v: number) => string): string {
  return value === null ? "—" : format(value);
}

function KeyConnectionCard({
  provider,
  title,
  description,
  connection,
  modelLabel,
  modelValue,
  modelDisabled,
  modelHint,
  onModelChange,
  onChanged,
  onSessionExpired,
  storageAvailable,
}: {
  provider: "openrouter" | "openai";
  title: string;
  description: string;
  connection: AiConnection | null;
  modelLabel: string;
  modelValue: string;
  modelDisabled: boolean;
  modelHint: string;
  onModelChange: (value: string) => void;
  onChanged: (next: AiSettingsResponse) => void;
  onSessionExpired: () => void;
  /** Kontrakt §1/§6: bez AI_CREDENTIAL_KEY zapis klucza się nie powiedzie. */
  storageAvailable: boolean;
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const connected = connection?.connected === true;

  function handleAuthError(err: unknown): void {
    if (isUnauthorized(err)) {
      onSessionExpired();
      return;
    }
    setError(err instanceof Error ? err.message : "Nie udało się wykonać operacji.");
  }

  async function handleSave(): Promise<void> {
    if (!apiKey) {
      setError("Wklej klucz API, aby go zapisać.");
      return;
    }
    setBusy("save");
    setError(null);
    setTestResult(null);
    try {
      const next = await saveAiConnection(provider, apiKey);
      setApiKey("");
      onChanged(next);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleTest(): Promise<void> {
    setBusy("test");
    setError(null);
    setTestResult(null);
    try {
      const result = await testAiConnection(provider);
      setTestResult(result);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect(): Promise<void> {
    setBusy("disconnect");
    setError(null);
    setTestResult(null);
    try {
      const next = await deleteAiConnection(provider);
      setApiKey("");
      onChanged(next);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setBusy(null);
    }
  }

  const keyId = `ai-${provider}-key`;
  const modelId = `ai-${provider}-model`;

  return (
    <article className="card ai-card" aria-labelledby={`${keyId}-title`}>
      <div className="svc-card-head">
        <div>
          <h3 id={`${keyId}-title`} className="section-title">{title}</h3>
          <p className="age-text">{description}</p>
        </div>
        <span
          className={`status-badge ${connected ? "status-badge--online" : "status-badge--neutral"}`}
          role="status"
          aria-label={`${title}: ${connected ? "połączono" : "nie połączono"}`}
        >
          <Icon name={connected ? "check" : "help"} />
          {connected ? "Połączono" : "Nie połączono"}
        </span>
      </div>

      {connected ? (
        <p className="age-text">
          Zapisany klucz{connection?.keyHint ? `: ${connection.keyHint}` : ""}.
          {connection?.lastCheckedAt
            ? ` Ostatnio sprawdzono: ${formatDateTime(connection.lastCheckedAt)}.`
            : ""}
          {" "}Klucz nie jest pokazywany w całości — podanie nowego zastąpi obecny.
        </p>
      ) : (
        <p className="age-text">Wklej klucz API dostawcy. Klucz nie jest przechowywany w przeglądarce.</p>
      )}

      {error ? <Banner tone="error">{error}</Banner> : null}
      {testResult ? (
        <Banner tone={testResult.ok ? "info" : "error"} role="status">
          {testResult.message || (testResult.ok ? "Połączenie działa." : "Test połączenia nie powiódł się.")}
        </Banner>
      ) : null}

      <div className="field">
        <label htmlFor={keyId}>Klucz API {title}</label>
        <input
          id={keyId}
          type="password"
          value={apiKey}
          autoComplete="off"
          placeholder={connected ? "Nowy klucz (zastąpi zapisany)" : "wklej klucz API"}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <span id={`${keyId}-hint`} className="field-hint">
          Po zapisie pole jest czyszczone; klucz trafia wyłącznie na serwer.
        </span>
      </div>

      <TextField
        id={modelId}
        label={modelLabel}
        value={modelValue}
        onChange={onModelChange}
        hint={modelHint}
        disabled={modelDisabled}
      />
      {modelDisabled ? (
        <p className="age-text" role="status">
          Ręczny wybór modelu jest wyłączony — włączony jest automatyczny wybór darmowego modelu
          (<span className="mono">{FREE_MODEL_ID}</span>).
        </p>
      ) : null}

      <div className="svc-actions">
        <button
          type="button"
          className="btn btn--filled"
          disabled={busy !== null || apiKey.length === 0 || !storageAvailable}
          title={!storageAvailable ? "Przechowywanie kluczy niedostępne (konfiguracja serwera)." : undefined}
          onClick={() => void handleSave()}
        >
          {busy === "save" ? "Zapisywanie…" : connected ? "Zastąp klucz" : "Zapisz klucz"}
        </button>
        <button
          type="button"
          className="btn btn--outlined"
          disabled={busy !== null || !connected}
          title={connected ? "Sprawdź zapisane połączenie" : "Najpierw zapisz klucz"}
          onClick={() => void handleTest()}
        >
          {busy === "test" ? "Testowanie…" : "Testuj połączenie"}
        </button>
        {connected ? (
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy !== null}
            onClick={() => void handleDisconnect()}
          >
            {busy === "disconnect" ? "Rozłączanie…" : "Rozłącz"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function CustomApiCard({
  connection,
  customName,
  customBaseUrl,
  modelValue,
  modelRequired,
  activeProvider,
  onModelChange,
  onChanged,
  onSessionExpired,
}: {
  connection: AiConnection | null;
  customName: string;
  customBaseUrl: string;
  modelValue: string;
  /** Aktywny provider wymaga niepustego modelu (kontrakt §3.3) — guard przed 400. */
  modelRequired: boolean;
  /** Kto jest aktywnym dostawcą — decyduje, czy zapis rusza model. */
  activeProvider: AiProvider | null;
  onModelChange: (value: string) => void;
  onChanged: (next: AiSettingsResponse) => void;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(customName);
  const [baseUrl, setBaseUrl] = useState(customBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const connected = connection?.connected === true;

  // Odśwież pola po zapisach z serwera (np. rozłączenie czyści stan).
  useEffect(() => {
    setName(customName);
    setBaseUrl(customBaseUrl);
  }, [customName, customBaseUrl]);

  function handleAuthError(err: unknown): void {
    if (isUnauthorized(err)) {
      onSessionExpired();
      return;
    }
    setError(err instanceof Error ? err.message : "Nie udało się wykonać operacji.");
  }

  function validBaseUrl(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 512) return false;
    if (/\s/.test(trimmed)) return false;
    return trimmed.startsWith("http://") || trimmed.startsWith("https://");
  }

  async function handleSave(): Promise<void> {
    if (!validBaseUrl(baseUrl)) {
      setError("Podaj bazowy adres API (http:// lub https://, bez spacji).");
      return;
    }
    // Drugi zapis (model) wymaga niepustego modelu dla tego providera —
    // nie wysyłamy skazanej na 400 pary żądań.
    if (modelRequired && modelValue.trim().length === 0) {
      setError("Podaj model udostępniany przez ten serwer, potem zapisz połączenie.");
      return;
    }
    setBusy("save");
    setError(null);
    setTestResult(null);
    try {
      const trimmedKey = apiKey.trim();
      const trimmedModel = modelValue.trim();
      const afterConnection = await saveCustomConnection({
        baseUrl: baseUrl.trim(),
        // Kontrakt §4: name zawsze wysyłane — '' czyści nazwę; brak klucza
        // (pole nieobecne) zostawia zapisany klucz bez zmian, nigdy go nie kasuje.
        name: name.trim(),
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
      });
      setApiKey("");
      if (activeProvider === "custom") {
        // Model należy do aktywnego custom: zapis w drugim kroku (niepusty — guard wyżej).
        const withModel = await updateAiSettings({ model: trimmedModel });
        onChanged(withModel);
      } else if (activeProvider === null && trimmedModel.length > 0) {
        // Pierwsze ustawianie z modelem: wybór custom + model w jednym PUT
        // (sam {model} przy provider null dałby 400 „Model requires AI provider”).
        const withModel = await updateAiSettings({ provider: "custom", model: trimmedModel });
        onChanged(withModel);
      } else {
        // Obcy aktywny provider albo brak modelu: jego modelu nie ruszamy.
        onChanged(afterConnection);
      }
    } catch (err) {
      handleAuthError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleTest(): Promise<void> {
    setBusy("test");
    setError(null);
    setTestResult(null);
    try {
      const result = await testAiConnection("custom");
      setTestResult(result);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect(): Promise<void> {
    setBusy("disconnect");
    setError(null);
    setTestResult(null);
    try {
      const next = await deleteAiConnection("custom");
      setApiKey("");
      onChanged(next);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card ai-card" aria-labelledby="ai-custom-title">
      <div className="svc-card-head">
        <div>
          <h3 id="ai-custom-title" className="section-title">Własne API</h3>
          <p className="age-text">
            Dowolny serwer zgodny z API OpenAI (endpoint czatu). Inne natywne formaty nie są obsługiwane.
          </p>
        </div>
        <span
          className={`status-badge ${connected ? "status-badge--online" : "status-badge--neutral"}`}
          role="status"
          aria-label={`Własne API: ${connected ? "połączono" : "nie połączono"}`}
        >
          <Icon name={connected ? "check" : "help"} />
          {connected ? "Połączono" : "Nie połączono"}
        </span>
      </div>

      {error ? <Banner tone="error">{error}</Banner> : null}
      {testResult ? (
        <Banner tone={testResult.ok ? "info" : "error"} role="status">
          {testResult.message || (testResult.ok ? "Połączenie działa." : "Test połączenia nie powiódł się.")}
        </Banner>
      ) : null}

      <TextField
        id="ai-custom-name"
        label="Nazwa połączenia (opcjonalna)"
        value={name}
        onChange={setName}
        hint="Np. Lokalny serwer. Tylko podpis dla Ciebie."
      />
      <TextField
        id="ai-custom-base-url"
        label="Bazowy adres API"
        value={baseUrl}
        onChange={setBaseUrl}
        error={
          baseUrl && !validBaseUrl(baseUrl)
            ? "Adres musi zaczynać się od http:// lub https://."
            : undefined
        }
        hint="Np. http://localhost:11434/v1 — bez końcowego /chat."
      />
      <TextField
        id="ai-custom-model"
        label="Model"
        value={modelValue}
        onChange={onModelChange}
        hint="Identyfikator modelu udostępnianego przez ten serwer."
      />
      <div className="field">
        <label htmlFor="ai-custom-key">Klucz API (opcjonalny)</label>
        <input
          id="ai-custom-key"
          type="password"
          value={apiKey}
          autoComplete="off"
          placeholder={connected ? "Nowy klucz (zastąpi zapisany)" : "pusty dla serwerów bez auth"}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <span id="ai-custom-key-hint" className="field-hint">
          Lokalne serwery często działają bez klucza — wtedy zostaw puste. Po zapisie pole jest czyszczone.
        </span>
      </div>

      <div className="svc-actions">
        <button
          type="button"
          className="btn btn--filled"
          disabled={busy !== null}
          onClick={() => void handleSave()}
        >
          {busy === "save" ? "Zapisywanie…" : connected ? "Zapisz zmiany" : "Zapisz połączenie"}
        </button>
        <button
          type="button"
          className="btn btn--outlined"
          disabled={busy !== null || !connected}
          title={connected ? "Sprawdź zapisane połączenie" : "Najpierw zapisz połączenie"}
          onClick={() => void handleTest()}
        >
          {busy === "test" ? "Testowanie…" : "Testuj połączenie"}
        </button>
        {connected ? (
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy !== null}
            onClick={() => void handleDisconnect()}
          >
            {busy === "disconnect" ? "Rozłączanie…" : "Rozłącz"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ChatGptCard({
  connection,
  chatgptEnabled,
  chatgptReason,
  onChanged,
  onSessionExpired,
}: {
  connection: AiConnection | null;
  chatgptEnabled: boolean;
  chatgptReason: string | null;
  onChanged: (next: AiSettingsResponse) => void;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [busy, setBusy] = useState<"login" | "logout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = connection?.connected === true;

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      setStatus(await getChatGptStatus());
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : "Nie udało się sprawdzić statusu ChatGPT.");
    } finally {
      setStatusLoading(false);
    }
  }, [onSessionExpired]);

  useEffect(() => {
    if (chatgptEnabled) {
      void refreshStatus();
    }
  }, [chatgptEnabled, refreshStatus]);

  async function handleLogin(): Promise<void> {
    setBusy("login");
    setError(null);
    try {
      const { authorizationUrl } = await startChatGptLogin();
      window.open(authorizationUrl, "_blank", "noopener,noreferrer");
      // Po otwarciu strony dostawcy odśwież status — nie zakładamy sukcesu.
      await refreshStatus();
      const fresh = await getAiSettings();
      onChanged(fresh);
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : "Nie udało się rozpocząć logowania ChatGPT.");
    } finally {
      setBusy(null);
    }
  }

  async function handleLogout(): Promise<void> {
    setBusy("logout");
    setError(null);
    try {
      const next = await logoutChatGpt();
      setStatus(null);
      onChanged(next);
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : "Nie udało się wylogować ChatGPT.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card ai-card" aria-labelledby="ai-chatgpt-title">
      <div className="svc-card-head">
        <div>
          <h3 id="ai-chatgpt-title" className="section-title">ChatGPT (abonament)</h3>
          <p className="age-text">Logowanie kontem ChatGPT przez stronę dostawcy — bez wklejania klucza.</p>
        </div>
        <span
          className={`status-badge ${connected ? "status-badge--online" : "status-badge--neutral"}`}
          role="status"
          aria-label={`ChatGPT: ${connected ? "połączono" : "nie połączono"}`}
        >
          <Icon name={connected ? "check" : "help"} />
          {connected ? "Połączono" : "Nie połączono"}
        </span>
      </div>

      {!chatgptEnabled ? (
        <Banner tone="warn" role="status">
          Logowanie ChatGPT jest obecnie niedostępne
          {chatgptReason ? `: ${chatgptReason}` : "."}
        </Banner>
      ) : null}
      {error ? <Banner tone="error">{error}</Banner> : null}
      {status?.pending ? (
        <Banner tone="info" role="status">
          Logowanie w toku{status.message ? ` — ${status.message}` : ". Dokończ je na stronie dostawcy."}
        </Banner>
      ) : null}
      {!status?.pending && status?.message ? (
        <p className="age-text" role="status">{status.message}</p>
      ) : null}

      <div className="svc-actions">
        <button
          type="button"
          className="btn btn--filled"
          disabled={busy !== null || !chatgptEnabled}
          title={
            !chatgptEnabled
              ? (chatgptReason ?? "Logowanie ChatGPT jest obecnie niedostępne.")
              : "Otwórz stronę logowania dostawcy w nowej karcie"
          }
          onClick={() => void handleLogin()}
        >
          {busy === "login" ? "Otwieranie…" : "Zaloguj przez ChatGPT"}
        </button>        <button
          type="button"
          className="btn btn--outlined"
          disabled={statusLoading || !chatgptEnabled}
          onClick={() => void refreshStatus()}
        >
          {statusLoading ? "Sprawdzanie…" : "Odśwież status"}
        </button>
        {connected ? (
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy !== null}
            onClick={() => void handleLogout()}
          >
            {busy === "logout" ? "Wylogowywanie…" : "Wyloguj"}
          </button>
        ) : null}
      </div>
      <p className="age-text">
        Po zakończeniu logowania na stronie dostawcy wróć tutaj i odśwież status.
      </p>
    </article>
  );
}

export function AiSettingsPage({
  onSessionExpired,
}: {
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [data, setData] = useState<AiSettingsResponse | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Roboczy wybór widoku — który formularz jest pokazany. `null` = podążaj za
   * zapisanym dostawcą. Rozdzielony od `settings.provider`, żeby pierwsze
   * kliknięcie niekompletnej opcji (np. custom bez baseUrl) otwierało sam
   * formularz bez PUT i bez błędu; zapis aktywuje dostawcę dopiero, gdy
   * scalony stan przejdzie walidację backendu.
   */
  const [viewProvider, setViewProvider] = useState<AiProvider | null>(null);

  const loadAll = useCallback(
    async (initial: boolean) => {
      if (initial) {
        setLoading(true);
      }
      try {
        const [settings, usageData] = await Promise.all([getAiSettings(), getAiUsage()]);
        setData(settings);
        setUsage(usageData);
        setError(null);
        setUsageError(null);
        if (initial) {
          setLoading(false);
        }
      } catch (err) {
        if (isUnauthorized(err)) {
          onSessionExpired();
          return;
        }
        const message = err instanceof Error ? err.message : "Nie udało się pobrać ustawień AI.";
        if (initial) {
          setError(message);
          setLoading(false);
        } else {
          setUsageError(message);
        }
      }
    },
    [onSessionExpired],
  );

  useEffect(() => {
    void loadAll(true);
  }, [loadAll]);

  async function patchSettings(
    patch: Parameters<typeof updateAiSettings>[0],
    okMessage: string,
  ): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await updateAiSettings(patch);
      setData(next);
      setNotice(okMessage);
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionExpired();
        return;
      }
      setSaveError(err instanceof Error ? err.message : "Nie udało się zapisać ustawień AI.");
    } finally {
      setSaving(false);
    }
  }

  function handleProviderChange(provider: AiProvider): void {
    // Natychmiastowy podgląd + wyczyszczenie komunikatów poprzedniego widoku.
    // Błędy i wpisane sekrety formularzy giną wraz z odmontowaniem kart
    // (karty montowane są z `key`, więc przełączanie nie przenosi sekretów).
    setViewProvider(provider);
    setNotice(null);
    setSaveError(null);
    const current = data?.settings;
    if (!current) {
      return;
    }
    // Kontrakt §3.4: openrouter + autoFree rozstrzyga model na openrouter/free —
    // sama zmiana providera z obcym modelem dałaby 400, więc dołączamy model.
    if (provider === "openrouter" && current.autoFree) {
      void patchSettings({ provider, model: FREE_MODEL_ID }, "Zapisano dostawcę AI.");
      return;
    }
    // Kontrakt §3: chatgpt nie wymaga modelu — wybór zawsze kompletny.
    if (provider === "chatgpt") {
      void patchSettings({ provider }, "Zapisano dostawcę AI.");
      return;
    }
    // Kontrakt §3.5/§3.3: custom aktywuje się wyłącznie zapisem w karcie
    // (baseUrl, potem provider+model razem) — radio to sam wybór widoku,
    // bez PUT i bez błędu. Niekompletny wybór openrouter/openai (pusty model)
    // też nie wysyła PUT, żeby nie nadpisać aktywnej konfiguracji.
    if (provider === "custom") {
      return;
    }
    const draftModel = (current.model ?? "").trim();
    if (draftModel.length === 0) {
      return;
    }
    // Szkic modelu jedzie razem z providerem — backend scala PUT atomowo,
    // więc nie gubimy wpisanego modelu ani nie czyścimy go odpowiedzią.
    void patchSettings({ provider, model: draftModel }, "Zapisano dostawcę AI.");
  }

  function handleActivateVisible(provider: AiProvider): void {
    // Jawne uaktywnienie podglądanego formularza (przycisk „Użyj tego
    // dostawcy”). Dla custom wysyła provider+model razem — nigdy samego
    // providera skazanego na 400; przycisk jest wyłączony, dopóki wybór
    // niekompletny.
    const current = data?.settings;
    if (!current) {
      return;
    }
    if (provider === "custom") {
      const baseUrl = current.customBaseUrl?.trim() ?? "";
      const draftModel = (current.model ?? "").trim();
      if (baseUrl.length === 0 || draftModel.length === 0) {
        return;
      }
      void patchSettings({ provider: "custom", model: draftModel }, "Zapisano dostawcę AI.");
      return;
    }
    handleProviderChange(provider);
  }

  if (loading) {
    return (
      <div className="main-content-inner">
        <h1 className="page-title">Konfiguracja AI</h1>
        <div className="card" aria-label="Ładowanie konfiguracji AI">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="main-content-inner">
        <h1 className="page-title">Konfiguracja AI</h1>
        <div className="card">
          <Banner
            tone="error"
            actions={
              <button type="button" className="btn btn--text" onClick={() => void loadAll(true)}>
                Ponów
              </button>
            }
          >
            {error ?? "Nie udało się pobrać ustawień AI."}
          </Banner>
        </div>
      </div>
    );
  }

  const { settings, connections, capabilities } = data;
  const activeProvider: AiProvider | null = settings.provider;
  /**
   * Roboczy widok: pokazywana jest wyłącznie karta tego dostawcy. `null` =
   * podążaj za zapisanym; sensowny default przy braku konfiguracji to
   * OpenRouter. Zapis i reload wracają do stanu z serwera.
   */
  const visibleProvider: AiProvider = viewProvider ?? activeProvider ?? "openrouter";
  const modelText = settings.model ?? "";
  const draftModel = modelText.trim();
  /** Czy podglądany (nieaktywny) formularz da się uaktywnić jednym PUT. */
  const visibleActivatable =
    visibleProvider === "chatgpt" ||
    (visibleProvider === "openrouter" && settings.autoFree) ||
    (visibleProvider === "custom"
      ? (settings.customBaseUrl?.trim() ?? "").length > 0 && draftModel.length > 0
      : draftModel.length > 0);
  const costFormat = new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });

  return (
    <div className="main-content-inner">
      <div className="svc-header">
        <h1 className="page-title">Konfiguracja AI</h1>
        <span className="age-text">Podpięcie dostawcy AI — bez funkcji agenta, nic tu nie naprawia automatycznie</span>
      </div>

      {notice ? <Banner tone="info" role="status">{notice}</Banner> : null}
      {saveError ? <Banner tone="error">{saveError}</Banner> : null}
      {!capabilities.credentialStorage ? (
        <Banner tone="warn" role="status">
          Przechowywanie kluczy jest niedostępne (brak konfiguracji serwera
          AI_CREDENTIAL_KEY) — zapis kluczy się nie powiedzie, ale odczyt
          ustawień i zapis trybów pracy działają.
        </Banner>
      ) : null}
      {usageError ? (
        <Banner
          tone="warn"
          role="status"
          actions={
            <button type="button" className="btn btn--text" onClick={() => void loadAll(false)}>
              Odśwież
            </button>
          }
        >
          Nie udało się odświeżyć danych — poniżej ostatnie znane. {usageError}
        </Banner>
      ) : null}

      <section className="card ai-card" aria-labelledby="ai-provider-title">
        <h2 id="ai-provider-title" className="section-title">Dostawca</h2>
        <p className="age-text">
          Wybierz, skąd aplikacja ma brać model AI. Wybór od razu pokazuje
          formularz tego dostawcy; zapis samego wyboru niczego nie uruchamia.
        </p>
        <div className="ai-radio-group" role="radiogroup" aria-label="Dostawca AI">
          {PROVIDER_OPTIONS.map((option) => (
            <label key={option.value} className="ai-radio">
              <input
                type="radio"
                name="ai-provider"
                value={option.value}
                checked={visibleProvider === option.value}
                disabled={saving}
                onChange={() => handleProviderChange(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
        {activeProvider === null ? (
          <p className="age-text" role="status">Nie wybrano dostawcy — wybierz jedną z opcji powyżej.</p>
        ) : null}
      </section>

      <section aria-label="Połączenie dostawcy" className="ai-connection">
        {visibleProvider === "openrouter" ? (
          <KeyConnectionCard
            key="openrouter"
            provider="openrouter"
            title="OpenRouter"
            description="Klucz API OpenRouter. Opcjonalnie z automatycznym wyborem darmowego modelu."
            connection={connectionFor(connections, "openrouter")}
            modelLabel="Model OpenRouter"
            modelValue={settings.provider === "openrouter" && settings.autoFree ? FREE_MODEL_ID : modelText}
            modelDisabled={settings.provider === "openrouter" && settings.autoFree}
            modelHint="Identyfikator modelu, np. openrouter/free. Zapisuje się przy wyborze dostawcy i edycji."
            onModelChange={(value) => {
              setData({
                ...data,
                settings: { ...settings, model: value },
              });
            }}
            onChanged={setData}
            onSessionExpired={onSessionExpired}
            storageAvailable={capabilities.credentialStorage}
          />
        ) : null}
        {visibleProvider === "openai" ? (
          <KeyConnectionCard
            key="openai"
            provider="openai"
            title="OpenAI"
            description="Klucz API OpenAI z własnego konta."
            connection={connectionFor(connections, "openai")}
            modelLabel="Model OpenAI"
            modelValue={modelText}
            modelDisabled={false}
            modelHint="Identyfikator modelu, np. gpt-4o-mini. Zapisuje się przy wyborze dostawcy i edycji."
            onModelChange={(value) => {
              setData({
                ...data,
                settings: { ...settings, model: value },
              });
            }}
            onChanged={setData}
            onSessionExpired={onSessionExpired}
            storageAvailable={capabilities.credentialStorage}
          />
        ) : null}
        {visibleProvider === "chatgpt" ? (
          <ChatGptCard
            key="chatgpt"
            connection={connectionFor(connections, "chatgpt")}
            chatgptEnabled={capabilities.chatgpt}
            chatgptReason={capabilities.chatgptReason}
            onChanged={setData}
            onSessionExpired={onSessionExpired}
          />
        ) : null}
        {visibleProvider === "custom" ? (
          <CustomApiCard
            key="custom"
            connection={connectionFor(connections, "custom")}
            customName={settings.customName ?? ""}
            customBaseUrl={settings.customBaseUrl ?? ""}
            modelValue={modelText}
            modelRequired={
              activeProvider === "custom" ||
              activeProvider === "openai" ||
              (activeProvider === "openrouter" && !settings.autoFree)
            }
            activeProvider={activeProvider}
            onModelChange={(value) => {
              setData({
                ...data,
                settings: { ...settings, model: value },
              });
            }}
            onChanged={setData}
            onSessionExpired={onSessionExpired}
          />
        ) : null}

        {visibleProvider !== activeProvider ? (
          <div className="card ai-card" aria-label="Aktywacja dostawcy">
            <p className="age-text" role="status">
              Zapisany dostawca: {providerShortLabel(activeProvider)} — ten formularz
              ({providerShortLabel(visibleProvider)}) nie jest jeszcze aktywny.
            </p>
            {!visibleActivatable ? (
              <p className="age-text">
                {visibleProvider === "custom"
                  ? "Najpierw zapisz bazowy adres API i wpisz model w formularzu powyżej."
                  : "Wpisz model w formularzu powyżej, aby uaktywnić tego dostawcę."}
              </p>
            ) : null}
            <div className="svc-actions">
              <button
                type="button"
                className="btn btn--filled"
                disabled={saving || !visibleActivatable}
                title={
                  visibleActivatable
                    ? `Przełącz zapisanego dostawcę na ${providerShortLabel(visibleProvider)}`
                    : "Uzupełnij formularz powyżej, aby uaktywnić tego dostawcę"
                }
                onClick={() => handleActivateVisible(visibleProvider)}
              >
                {saving ? "Zapisywanie…" : "Użyj tego dostawcy"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="card ai-card" aria-labelledby="ai-autofree-title">
          <h3 id="ai-autofree-title" className="section-title">Darmowy model OpenRouter</h3>
          <label className="ai-check" htmlFor="ai-autofree">
            <input
              id="ai-autofree"
              type="checkbox"
              checked={settings.autoFree}
              disabled={saving}
              onChange={(event) => {
                const autoFree = event.target.checked;
                // Kontrakt §3.4: autoFree wpływa na model tylko przy providerze
                // openrouter; przy innych zapisujemy samą flagę (model ręczny).
                const patch =
                  autoFree && settings.provider === "openrouter"
                    ? { autoFree, model: FREE_MODEL_ID }
                    : { autoFree };
                void patchSettings(
                  patch,
                  autoFree
                    ? "Włączono automatyczny wybór darmowego modelu."
                    : "Wyłączono automatyczny wybór darmowego modelu.",
                );
              }}
            />
            Automatycznie wybieraj darmowy model
          </label>
          <p className="age-text">
            Gdy opcja jest zaznaczona, aplikacja używa darmowego modelu
            (<span className="mono">{FREE_MODEL_ID}</span>), a ręczne pole modelu jest wyłączone.
            Bezpłatne modele mogą mieć limity dostawcy.
          </p>
        </div>
      </section>

      {visibleProvider === activeProvider &&
      (activeProvider === "openrouter" || activeProvider === "openai" || activeProvider === "custom") &&
      !(activeProvider === "openrouter" && settings.autoFree) ? (
        <div className="svc-actions">
          <button
            type="button"
            className="btn btn--tonal"
            disabled={saving}
            onClick={() =>
              void patchSettings({ model: modelText || null }, "Zapisano model AI.")
            }
          >
            {saving ? "Zapisywanie…" : "Zapisz model"}
          </button>
        </div>
      ) : null}

      <section className="card ai-card" aria-labelledby="ai-mode-title">
        <h2 id="ai-mode-title" className="section-title">Tryb pracy</h2>
        <p className="age-text">
          Te ustawienia zapisują dziś wyłącznie preferencje pod przyszłe funkcje.
          Aplikacja na razie niczego nie analizuje ani nie naprawia automatycznie.
        </p>
        <div className="ai-radio-group" role="radiogroup" aria-label="Tryb pracy AI">
          {EXECUTION_MODES.map((mode) => (
            <label key={mode.value} className="ai-radio ai-radio--block">
              <input
                type="radio"
                name="ai-execution-mode"
                value={mode.value}
                checked={settings.executionMode === mode.value}
                disabled={saving}
                onChange={() => {
                  void patchSettings(
                    { executionMode: mode.value },
                    `Zapisano tryb pracy: ${mode.title}.`,
                  );
                }}
              />
              <span>
                <strong>{mode.title}</strong>
                <span className="age-text"> — {mode.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="card ai-card" aria-labelledby="ai-usage-title">
        <div className="svc-card-head">
          <div>
            <h2 id="ai-usage-title" className="section-title">Zużycie agenta</h2>
            <p className="age-text">
              Tylko ta aplikacja (wind-up monitor)
              {usage?.since ? ` · od ${formatDateTime(usage.since)}` : " · brak danych o okresie"}.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--outlined"
            onClick={() => void loadAll(false)}
          >
            <Icon name="refresh" /> Odśwież
          </button>
        </div>
        {!usage || usage.requests === 0 ? (
          <div className="empty-state">
            <Icon name="help" label="Ikona znaku zapytania" />
            <h3 className="section-title">Brak zużycia do pokazania</h3>
            <p className="age-text">
              Gdy aplikacja zacznie korzystać z AI, pojawią się tu liczba zapytań,
              tokeny i koszt. Na razie nie ma żadnych danych.
            </p>
          </div>
        ) : (
          <dl className="svc-meta ai-usage-grid">
            <div>
              <dt>Zapytania</dt>
              <dd className="metric-value">{usage.requests}</dd>
            </div>
            <div>
              <dt>Tokeny wejściowe</dt>
              <dd className="metric-value">
                {nullableMetric(usage.inputTokens, (v) => String(Math.round(v)))}
              </dd>
            </div>
            <div>
              <dt>Tokeny wyjściowe</dt>
              <dd className="metric-value">
                {nullableMetric(usage.outputTokens, (v) => String(Math.round(v)))}
              </dd>
            </div>
            <div>
              <dt>Koszt (USD)</dt>
              <dd className="metric-value">
                {nullableMetric(usage.costUsd, (v) => costFormat.format(v))}
              </dd>
            </div>
          </dl>
        )}
      </section>
    </div>
  );
}

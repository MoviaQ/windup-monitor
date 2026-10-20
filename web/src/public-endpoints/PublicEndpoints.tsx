/**
 * wind-up monitor — sekcja „Publiczne adresy URL" w szczegółach usługi.
 *
 * Jeden blok w rozwiniętych szczegółach karty usługi (ten sam grid, brak
 * nowego nav/sidebar) + krótkie podsumowanie statusu widoczne na karcie
 * BEZ rozwijania (`PublicStatusSummary`). Statusy mówią wyłącznie o odpowiedzi
 * widzianej z serwera wind-up monitor — nigdy „publicznie dostępny z całego
 * internetu".
 *
 * Copy (kontrakt Core):
 * - up → „Publiczny adres odpowiada", down → „Brak odpowiedzi",
 *   unknown → „Jeszcze nie sprawdzono", paused → „Sprawdzanie wstrzymane",
 *   3xx przy braku follow → „Przekierowanie".
 * - tooltip: „Sprawdzane z serwera wind-up monitor, bez zewnętrznego punktu pomiarowego".
 * - 401/403 liczą się jako odpowiedź serwera (link odpowiada, choć wymaga logowania).
 */
import { useState } from "react";
import {
  createPublicEndpoint,
  deletePublicEndpoint,
  updatePublicEndpoint,
  type PublicEndpoint,
} from "./api";
import { isUnauthorized } from "../api/client";
import { Banner } from "../components/Banner";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { TextField } from "../components/TextField";
import "./public-endpoints.css";

export const PUBLIC_ENDPOINT_PROBE_TOOLTIP =
  "Sprawdzane z serwera wind-up monitor, bez zewnętrznego punktu pomiarowego";

export function publicEndpointStatusText(endpoint: PublicEndpoint): string {
  if (!endpoint.enabled || endpoint.status === "paused") return "Sprawdzanie wstrzymane";
  if (endpoint.status === "up") {
    if (endpoint.statusCode !== null && endpoint.statusCode >= 300 && endpoint.statusCode < 400) {
      return `Przekierowanie (HTTP ${endpoint.statusCode})`;
    }
    if (endpoint.errorCode === "AUTH_REQUIRED") return "Publiczny adres odpowiada (wymaga logowania)";
    return "Publiczny adres odpowiada";
  }
  if (endpoint.status === "down") return "Brak odpowiedzi";
  return "Jeszcze nie sprawdzono";
}

export function publicEndpointTone(endpoint: PublicEndpoint): string {
  if (!endpoint.enabled || endpoint.status === "paused") return "status-badge--stale";
  if (endpoint.status === "up") {
    if (endpoint.errorCode === "REDIRECT" || endpoint.errorCode === "AUTH_REQUIRED") {
      return "status-badge--stale";
    }
    return "status-badge--online";
  }
  if (endpoint.status === "down") return "status-badge--offline";
  return "status-badge--neutral";
}

/** Ikona statusu: przekierowanie/logowanie to „uwaga", nie zielone „OK". */
export function publicEndpointIcon(endpoint: PublicEndpoint): "check" | "error" | "help" | "pause" | "warn" {
  if (!endpoint.enabled || endpoint.status === "paused") return "pause";
  if (endpoint.status === "up") {
    if (endpoint.errorCode === "REDIRECT" || endpoint.errorCode === "AUTH_REQUIRED") return "warn";
    return "check";
  }
  if (endpoint.status === "down") return "error";
  return "help";
}

/** Klasyfikacja odpowiedzi do etykiety: 3xx (brak follow) to przekierowanie, nie awaria. */
export function reachabilityNote(endpoint: PublicEndpoint): string | null {
  if (endpoint.statusCode !== null && endpoint.statusCode >= 300 && endpoint.statusCode < 400) {
    return `Przekierowanie (HTTP ${endpoint.statusCode}) — adres odpowiada, sonda nie podąża dalej.`;
  }
  if (endpoint.statusCode === 401 || endpoint.statusCode === 403) {
    return `HTTP ${endpoint.statusCode} — serwer odpowiada (wymaga logowania).`;
  }
  return null;
}

export function formatPublicLatency(ms: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

/* ---------- Podsumowanie na karcie (widoczne bez rozwijania) ---------- */

/**
 * Stan pobrania listy publicznych adresów usługi. Własny, niezależny od
 * stanu historii pomiarów (MED: awaria jednego nie zasłania drugiego).
 * `endpoints: null` = jeszcze nie ładowano albo nie udało się pobrać —
 * nigdy nie udajemy pustej listy (pusta lista to `[]`).
 */
export interface PublicSummaryState {
  endpoints: PublicEndpoint[] | null;
  state: "idle" | "loading" | "error";
  error: string | null;
}

export interface PublicStatusBadge {
  text: string;
  tone: string;
  icon: "check" | "error" | "help" | "pause" | "warn";
}

/** Krótka nazwa adresu do podsumowania: etykieta użytkownika, host albo URL. */
export function publicEndpointShortName(endpoint: PublicEndpoint): string {
  const label = (endpoint.label ?? "").trim();
  if (label.length > 0) return label;
  try {
    const host = new URL(endpoint.url).hostname;
    if (host) return host;
  } catch {
    // Potłuczony URL pokazujemy wprost — bez rzutu w renderze.
  }
  return endpoint.url;
}

/** Adres wyłączony przez użytkownika to stan wstrzymania, nie awaria. */
function isEndpointPaused(endpoint: PublicEndpoint): boolean {
  return !endpoint.enabled || endpoint.status === "paused";
}

/** 3xx (sonda nie podąża dalej) — przekierowanie, nie zielone „OK". */
function isEndpointRedirect(endpoint: PublicEndpoint): boolean {
  return (
    (endpoint.statusCode !== null && endpoint.statusCode >= 300 && endpoint.statusCode < 400) ||
    endpoint.errorCode === "REDIRECT"
  );
}

/** 401/403 — serwer odpowiada, ale wymaga logowania (nie fake health). */
function isEndpointAuth(endpoint: PublicEndpoint): boolean {
  return (
    endpoint.errorCode === "AUTH_REQUIRED" ||
    endpoint.statusCode === 401 ||
    endpoint.statusCode === 403
  );
}

/** Status jednego adresu — krótko, bez rzutu kolorem (ikona + tekst). */
export function publicEndpointBadge(endpoint: PublicEndpoint): PublicStatusBadge {
  if (isEndpointPaused(endpoint)) {
    return { text: "sprawdzanie wstrzymane", tone: "status-badge--stale", icon: "pause" };
  }
  if (endpoint.status === "down") {
    return { text: "nie odpowiada", tone: "status-badge--offline", icon: "error" };
  }
  if (endpoint.status === "unknown") {
    return { text: "jeszcze nie sprawdzono", tone: "status-badge--neutral", icon: "help" };
  }
  if (isEndpointAuth(endpoint)) {
    return { text: "wymaga logowania", tone: "status-badge--stale", icon: "warn" };
  }
  if (isEndpointRedirect(endpoint)) {
    return { text: "przekierowanie", tone: "status-badge--stale", icon: "warn" };
  }
  return { text: "odpowiada", tone: "status-badge--online", icon: "check" };
}

/**
 * Agregat dla całej usługi: NAJGORSZY stan wygrywa, więc awaria jednego
 * adresu nigdy nie chowa się za drugim. Wstrzymanie jest stanem osobnym
 * (nie liczy się ani jako działające, ani jako awaria).
 */
export function aggregatePublicStatus(endpoints: PublicEndpoint[]): PublicStatusBadge | null {
  if (endpoints.length === 0) return null;
  const prefix = "Adres publiczny";
  const hasUp = endpoints.some((e) => !isEndpointPaused(e) && e.status === "up");
  if (endpoints.some((e) => !isEndpointPaused(e) && e.status === "down")) {
    return { text: `${prefix}: nie odpowiada`, tone: "status-badge--offline", icon: "error" };
  }
  if (endpoints.some((e) => !isEndpointPaused(e) && e.status === "unknown")) {
    return { text: `${prefix}: jeszcze nie sprawdzono`, tone: "status-badge--neutral", icon: "help" };
  }
  const anyPaused = endpoints.some(isEndpointPaused);
  if (anyPaused && hasUp) {
    return { text: `${prefix}: odpowiada (część wstrzymana)`, tone: "status-badge--online", icon: "check" };
  }
  if (anyPaused) {
    return { text: `${prefix}: sprawdzanie wstrzymane`, tone: "status-badge--stale", icon: "pause" };
  }
  if (endpoints.some(isEndpointAuth)) {
    return { text: `${prefix}: wymaga logowania`, tone: "status-badge--stale", icon: "warn" };
  }
  if (endpoints.some(isEndpointRedirect)) {
    return { text: `${prefix}: przekierowanie`, tone: "status-badge--stale", icon: "warn" };
  }
  return { text: `${prefix}: odpowiada`, tone: "status-badge--online", icon: "check" };
}

function SummaryBadge({ badge }: { badge: PublicStatusBadge }): React.JSX.Element {
  return (
    <span className={`status-badge ${badge.tone}`} title={PUBLIC_ENDPOINT_PROBE_TOOLTIP}>
      <Icon name={badge.icon} />
      {badge.text}
    </span>
  );
}

/**
 * Status publicznego URL na karcie usługi — zawsze widoczny, także przy
 * zwiniętej karcie (bez rozwijania szczegółów i bez czekania na historię).
 * Stany: ładowanie/błąd neutralnie (nigdy na zielono), brak adresów →
 * subtelne „nie dodano", awaria nie chowa się za agregatem.
 */
export function PublicStatusSummary({
  summary,
}: {
  summary?: PublicSummaryState | null;
}): React.JSX.Element {
  if (!summary || summary.endpoints === null) {
    if (summary?.state === "error") {
      return <SummaryBadge badge={{ text: "Adres publiczny: stan nieznany", tone: "status-badge--neutral", icon: "help" }} />;
    }
    // Jeszcze nie ładowano albo trwa ładowanie — neutralnie, bez koloru zdrowia.
    return <SummaryBadge badge={{ text: "Adres publiczny: sprawdzanie…", tone: "status-badge--neutral", icon: "help" }} />;
  }
  const aggregate = aggregatePublicStatus(summary.endpoints);
  if (!aggregate) {
    return <span className="age-text">Adres publiczny: nie dodano</span>;
  }
  return (
    <span className="pe-summary-badges">
      <SummaryBadge badge={aggregate} />
      {/* Przy kilku adresach pokazujemy każdy z osobna — awaria jednego jest widoczna. */}
      {summary.endpoints.length > 1
        ? summary.endpoints.map((endpoint) => {
            const badge = publicEndpointBadge(endpoint);
            return (
              <SummaryBadge
                key={endpoint.id}
                badge={{ ...badge, text: `${publicEndpointShortName(endpoint)}: ${badge.text}` }}
              />
            );
          })
        : null}
    </span>
  );
}

/** Walidacja po stronie UI (ostateczna w Core): https, brak spacji, sensowna długość. */
export function validatePublicUrlInput(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return "Podaj adres URL, np. https://status.example.com/health";
  if (value.length > 2048) return "Adres URL może mieć maksymalnie 2048 znaków.";
  if (/[\s<>]/.test(value)) return "Adres URL nie może zawierać spacji ani znaków < >.";
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return "Nieprawidłowy adres URL. Przykład: https://status.example.com/health";
  }
  if (parsed.protocol.toLowerCase() === "http:") {
    return "Zwykły HTTP nie jest obsługiwany — użyj adresu https://.";
  }
  if (parsed.protocol.toLowerCase() !== "https:") {
    return "Dozwolony jest tylko adres https://.";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "Adres URL nie może zawierać danych logowania.";
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    return "Dozwolony jest tylko domyślny port 443.";
  }
  return null;
}

function EndpointForm({
  url,
  label,
  onUrl,
  onLabel,
  urlError,
  prefix,
}: {
  url: string;
  label: string;
  onUrl: (v: string) => void;
  onLabel: (v: string) => void;
  urlError: string | null;
  prefix: string;
}): React.JSX.Element {
  return (
    <div className="pe-form">
      <TextField
        id={`${prefix}-url`}
        label="Publiczny adres URL (https)"
        value={url}
        onChange={onUrl}
        error={urlError ?? undefined}
        hint="Np. filmy.moviak.quest albo https://status.example.com/health — samo dopiszemy https://. Tylko port 443."
      />
      <TextField
        id={`${prefix}-label`}
        label="Etykieta (opcjonalna)"
        value={label}
        onChange={onLabel}
        error={label.length > 80 ? "Etykieta może mieć maksymalnie 80 znaków." : undefined}
        hint="Np. Jellyfin (publiczny). Maks. 80 znaków."
      />
    </div>
  );
}

export function PublicEndpointsSection({
  serviceId,
  serviceName,
  endpoints,
  readOnly,
  readOnlyHint,
  onChanged,
  onSessionExpired,
}: {
  serviceId: string;
  serviceName: string;
  endpoints: PublicEndpoint[];
  readOnly: boolean;
  readOnlyHint: string;
  onChanged: () => void;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PublicEndpoint | null>(null);
  const [removing, setRemoving] = useState<PublicEndpoint | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const urlError = touched ? validatePublicUrlInput(url) : null;
  const labelError = label.length > 80 ? "Etykieta może mieć maksymalnie 80 znaków." : null;

  function fail(err: unknown, fallback: string): void {
    if (isUnauthorized(err)) {
      onSessionExpired();
      return;
    }
    setError(err instanceof Error ? err.message : fallback);
  }

  async function handleAdd(): Promise<void> {
    setTouched(true);
    const problem = validatePublicUrlInput(url);
    if (problem || labelError) return;
    setBusy(true);
    setError(null);
    try {
      await createPublicEndpoint(serviceId, {
        url: url.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setAdding(false);
      setUrl("");
      setLabel("");
      setTouched(false);
      onChanged();
    } catch (err) {
      fail(err, "Nie udało się dodać adresu.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(endpoint: PublicEndpoint): Promise<void> {
    setRowBusy(endpoint.id);
    setRowError(null);
    try {
      await updatePublicEndpoint(endpoint.id, { enabled: !endpoint.enabled });
      onChanged();
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionExpired();
        return;
      }
      setRowError(err instanceof Error ? err.message : "Nie udało się zmienić stanu adresu.");
    } finally {
      setRowBusy(null);
    }
  }

  async function handleEditSave(): Promise<void> {
    if (!editing) return;
    setTouched(true);
    const problem = validatePublicUrlInput(url);
    if (problem || labelError) return;
    setBusy(true);
    setError(null);
    try {
      await updatePublicEndpoint(editing.id, {
        url: url.trim(),
        label: label.trim(),
      });
      setEditing(null);
      onChanged();
    } catch (err) {
      fail(err, "Nie udało się zapisać zmian.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(): Promise<void> {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await deletePublicEndpoint(removing.id);
      setRemoving(null);
      onChanged();
    } catch (err) {
      fail(err, "Nie udało się usunąć adresu.");
    } finally {
      setBusy(false);
    }
  }

  function openEdit(endpoint: PublicEndpoint): void {
    setEditing(endpoint);
    setUrl(endpoint.url);
    setLabel(endpoint.label ?? "");
    setTouched(false);
    setError(null);
  }

  return (
    <section className="pe-section" aria-label={`Publiczne adresy URL usługi ${serviceName}`}>
      <div className="pe-head">
        <h4 className="section-title">Publiczne adresy URL</h4>
        <span className="age-text" tabIndex={0} title={PUBLIC_ENDPOINT_PROBE_TOOLTIP}>
          {endpoints.length === 0 ? "Brak dodanych adresów" : `${endpoints.length} z 5`}
        </span>
      </div>
      {rowError ? <Banner tone="error">{rowError}</Banner> : null}
      {endpoints.length === 0 ? (
        <p className="age-text">
          Osobny status HTTPS mierzony z serwera wind-up monitor — niezależny od lokalnego health.
        </p>
      ) : (
        <ul className="pe-list">
          {endpoints.map((endpoint) => {
            const note = reachabilityNote(endpoint);
            return (
              <li key={endpoint.id} className="pe-row">
                <div className="pe-row-main">
                  <a
                    href={endpoint.url}
                    target="_blank"
                    rel="noopener"
                    className="pe-link"
                  >
                    {endpoint.label || endpoint.url}
                  </a>
                  {endpoint.label ? <span className="age-text mono">{endpoint.url}</span> : null}
                  <span className="age-text" tabIndex={0} title={PUBLIC_ENDPOINT_PROBE_TOOLTIP}>
                    {formatPublicLatency(endpoint.latencyMs)}
                    {endpoint.statusCode !== null ? ` · HTTP ${endpoint.statusCode}` : ""}
                    {endpoint.errorCode && endpoint.status === "down" ? ` · ${endpoint.errorCode}` : ""}
                  </span>
                  {note ? <span className="age-text">{note}</span> : null}
                </div>
                <div className="pe-row-side">
                  <span className={`status-badge ${publicEndpointTone(endpoint)}`} title={PUBLIC_ENDPOINT_PROBE_TOOLTIP}>
                    <Icon name={publicEndpointIcon(endpoint)} />
                    {publicEndpointStatusText(endpoint)}
                  </span>
                  <div className="pe-row-actions">
                    <button
                      type="button"
                      className="btn btn--outlined"
                      disabled={readOnly || rowBusy === endpoint.id}
                      title={readOnly ? readOnlyHint : undefined}
                      onClick={() => void handleToggle(endpoint)}
                    >
                      <Icon name={endpoint.enabled ? "pause" : "play"} />
                      {endpoint.enabled ? "Wstrzymaj" : "Wznów"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--outlined"
                      disabled={readOnly || rowBusy === endpoint.id}
                      title={readOnly ? readOnlyHint : undefined}
                      onClick={() => openEdit(endpoint)}
                    >
                      Edytuj
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={readOnly || rowBusy === endpoint.id}
                      title={readOnly ? readOnlyHint : undefined}
                      onClick={() => setRemoving(endpoint)}
                    >
                      Usuń
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="svc-actions">
        <button
          type="button"
          className="btn btn--tonal"
          disabled={readOnly || endpoints.length >= 5}
          title={readOnly ? readOnlyHint : endpoints.length >= 5 ? "Limit 5 adresów na usługę." : undefined}
          onClick={() => {
            setUrl("");
            setLabel("");
            setTouched(false);
            setError(null);
            setAdding(true);
          }}
        >
          <Icon name="add" /> Dodaj publiczny URL
        </button>
      </div>

      {adding ? (
        <Dialog
          title={`Dodaj publiczny URL — ${serviceName}`}
          onClose={() => {
            if (!busy) setAdding(false);
          }}
          actions={
            <button type="button" className="btn btn--filled" disabled={busy} onClick={() => void handleAdd()}>
              {busy ? "Dodawanie…" : "Dodaj adres"}
            </button>
          }
        >
          {error ? <Banner tone="error">{error}</Banner> : null}
          <EndpointForm
            url={url}
            label={label}
            onUrl={(v) => {
              setUrl(v);
              setTouched(true);
            }}
            onLabel={setLabel}
            urlError={urlError}
            prefix="pe-add"
          />
        </Dialog>
      ) : null}

      {editing ? (
        <Dialog
          title="Edytuj publiczny URL"
          onClose={() => {
            if (!busy) setEditing(null);
          }}
          actions={
            <button type="button" className="btn btn--filled" disabled={busy} onClick={() => void handleEditSave()}>
              {busy ? "Zapisywanie…" : "Zapisz"}
            </button>
          }
        >
          {error ? <Banner tone="error">{error}</Banner> : null}
          <p className="age-text">Zmiana adresu czyści poprzedni wynik — stare pomiary nigdy nie opisują nowego celu.</p>
          <EndpointForm
            url={url}
            label={label}
            onUrl={(v) => {
              setUrl(v);
              setTouched(true);
            }}
            onLabel={setLabel}
            urlError={urlError}
            prefix="pe-edit"
          />
        </Dialog>
      ) : null}

      {removing ? (
        <Dialog
          title="Usunąć publiczny URL?"
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
          actions={
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void handleRemove()}>
              {busy ? "Usuwanie…" : "Usuń adres"}
            </button>
          }
        >
          {error ? <Banner tone="error">{error}</Banner> : null}
          <p>
            Adres {removing.label || removing.url} przestanie być sprawdzany. Tej operacji nie można cofnąć.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

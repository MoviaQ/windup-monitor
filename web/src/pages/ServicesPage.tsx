/* Windup Monitor Web — ekran Usługi (S2): monitorowane cele HTTP + wykryte nasłuchy. */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  createService,
  deleteService,
  getServiceHistory,
  listDiscovered,
  listServices,
  updateService,
  type DiscoveredCandidate,
  type MonitoredService,
  type ServiceHistory,
} from "../api/services";
import { isUnauthorized } from "../api/client";
import { useOnline, usePageVisible } from "../hooks/hooks";
import { Banner } from "../components/Banner";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { TextField } from "../components/TextField";
import { listPublicEndpoints } from "../public-endpoints/api";
import {
  PublicEndpointsSection,
  PublicStatusSummary,
  type PublicSummaryState,
} from "../public-endpoints/PublicEndpoints";
import { formatDateTime } from "../utils/format";

const SERVICES_POLL_MS = 15_000;
/** Interwał odświeżania UI usług — tekst podaje skonfigurowany interwał, nie wiek danych. */
const POLL_SECONDS = Math.round(SERVICES_POLL_MS / 1000);
const HISTORY_LIMIT = 100;
/**
 * Podsumowanie publicznych URL-i odświeżamy nie częściej niż co 45 s na usługę
 * (sondy i tak mają interwał ≥ 15 s), a i tak tylko przy widocznej karcie —
 * dzięki temu zwinięta karta nie generuje zbędnego N+1 co 15 s.
 */
const PUBLIC_REFRESH_MS = 45_000;
/** Równoległe pobranie list publicznych — bound, bo karty ładują się naraz. */
const PUBLIC_FETCH_CONCURRENCY = 4;

/** Prosty limit równoległości: kolejka + N workerów, kolejność bez znaczenia. */
async function mapLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await run(item);
    }
  });
  await Promise.all(workers);
}

/** Wejście podsumowania publicznego na karcie + wiek ostatniego odczytu. */
type PublicSummaryEntry = PublicSummaryState & { loadedAt: number };

type Tab = "monitored" | "discovered";

export const SERVICE_STATUS_LABEL: Record<MonitoredService["status"], string> = {
  up: "Działa",
  degraded: "Pogorszenie",
  down: "Nie odpowiada",
  unknown: "Brak pomiarów",
  paused: "Wstrzymano",
};

function statusTone(status: MonitoredService["status"]): string {
  if (status === "up") return "status-badge--online";
  if (status === "degraded") return "status-badge--stale";
  if (status === "down") return "status-badge--offline";
  if (status === "paused") return "status-badge--stale";
  return "status-badge--neutral";
}

function statusIcon(status: MonitoredService["status"]): "check" | "error" | "warn" | "help" | "pause" {
  if (status === "up") return "check";
  if (status === "degraded") return "warn";
  if (status === "down") return "error";
  if (status === "paused") return "pause";
  return "help";
}

export function ServiceStatusBadge({ status }: { status: MonitoredService["status"] }): React.JSX.Element {
  const title =
    status === "unknown"
      ? "Brak pomiarów — usługa nie ma jeszcze próbek albo brak połączenia z agentem. Przerwa liczy się jako nieznana, nie jako awaria."
      : status === "degraded"
        ? "Ostatni pomiar był nieudany, ale próg potwierdzonej awarii jeszcze nie został osiągnięty."
        : undefined;
  return (
    <span className={`status-badge ${statusTone(status)}`} title={title}>
      <Icon name={statusIcon(status)} />
      {SERVICE_STATUS_LABEL[status]}
    </span>
  );
}

function kindLabel(kind: string): string {
  if (kind === "jellyfin") return "Jellyfin";
  if (kind === "t3-code") return "T3 Code";
  if (kind === "opencode") return "OpenCode";
  return "Usługa lokalna";
}

/** Ludzki opis źródła nazwy — zrozumiała etykieta, nie zrzut pól technicznych. */
const NAME_SOURCE_LABEL: Record<string, string> = {
  exe: "nazwa pliku wykonywalnego",
  comm: "nazwa procesu",
  "package-json": "nazwa z package.json",
  systemd: "nazwa jednostki systemd",
  container: "nazwa kontenera",
  fallback: "nazwa domyślna (nie udało się ustalić)",
  fingerprint: "rozpoznanie po odpowiedzi usługi",
};

function nameEvidenceCandidate(candidate: DiscoveredCandidate): string | null {
  const source = candidate.nameSource ?? "";
  return NAME_SOURCE_LABEL[source] ?? null;
}

/**
 * Generic contract: only `monitorable` decides whether a listener can be
 * enabled — `kind: "unknown"` never means "not monitorable". Legacy agents
 * omit the field; then infer the old behaviour (HTTP with an explicit hint).
 */
export function isMonitorable(candidate: DiscoveredCandidate): boolean {
  if (typeof candidate.monitorable === "boolean") return candidate.monitorable;
  return (
    candidate.transport === "http" &&
    (candidate.suggestedPath != null || candidate.kind !== "unknown")
  );
}

/** Znany nasłuch HTTP można włączyć jednym kliknięciem; TCP — jako connect. */
export function canMonitorHttp(candidate: DiscoveredCandidate): boolean {
  return isMonitorable(candidate) && candidate.transport === "http";
}

export function canMonitorTcp(candidate: DiscoveredCandidate): boolean {
  return isMonitorable(candidate) && candidate.transport === "tcp";
}

/** Ludzki opis wykrycia — zrozumiałe etykiety, bez zrzutu pól technicznych. */
export function recognitionText(candidate: DiscoveredCandidate): string {
  const where = `port ${candidate.port} na hoście ${candidate.agentHostname || candidate.agentId}`;
  const evidence =
    candidate.confidence === "high"
      ? "Rozpoznano po procesie i porcie"
      : "Rozpoznanie częściowe";
  const transport = candidate.transport === "tcp" ? "Połączenie TCP" : "HTTP";
  return `${evidence} — ${kindLabel(candidate.kind)}, ${transport}, ${where}.`;
}

/** Tooltip z pochodzeniem nazwy: źródło i poziom pewności słowami, nie raw dump. */
export function recognitionTooltip(candidate: DiscoveredCandidate): string {
  const confidence =
    candidate.confidence === "high"
      ? "wysoka pewność"
      : candidate.confidence === "medium"
        ? "średnia pewność"
        : "niska pewność";
  const evidence = nameEvidenceCandidate(candidate);
  const probe = candidate.transport === "tcp" ? "TCP (connect)" : "HTTP";
  const base = `Źródło rozpoznania: ${confidence}. Sposób sprawdzania: ${probe}.`;
  return evidence ? `${base} Nazwa ustalona z: ${evidence}.` : base;
}

const PROCESS_CPU_TOOLTIP =
  "100% = jeden rdzeń. Wartości powyżej 100% oznaczają użycie wielu rdzeni.";

/** CPU procesu: procent jednego rdzenia, bez sztucznego clampowania do 100. */
export function formatProcessCpu(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Brak danych";
  return `${Math.round(value * 10) / 10}%`;
}

/** RSS procesu w MiB; null oznacza brak danych, nigdy zero. */
export function formatProcessMemory(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "Brak danych";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function presetFor(kind: string): { path: string; statuses: number[] } {
  if (kind === "jellyfin") return { path: "/Health", statuses: [200] };
  if (kind === "opencode") return { path: "/", statuses: [401] };
  return { path: "/", statuses: [200] };
}

export function isSafePathInput(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("://")) return false;
  if (path.includes("@") || path.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex -- celowo jak walidator Core (odrzuca sterujace).
  if (/[\s\u0000-\u001f\u007f]/.test(path)) return false;
  return true;
}

export function parseStatusesInput(raw: string): number[] | null {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 10) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const code = Number.parseInt(part, 10);
    if (!Number.isInteger(code) || code < 100 || code > 599) return null;
    if (!values.includes(code)) values.push(code);
  }
  return values.sort((a, b) => a - b);
}

function formatLatency(ms: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

function formatAvailability(service: MonitoredService): string {
  if (service.availabilityPercent === null || service.availabilityPercent === undefined) {
    return "Za mało pomiarów";
  }
  const pct = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(
    service.availabilityPercent,
  );
  return `${pct} %`;
}

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_SUCCESS_THRESHOLD = 2;

/**
 * Prefill progu z DTO. Defensywny fallback dla przejściowych odpowiedzi
 * bez pól (Core dodaje je addytywnie) oraz dla wartości spoza 1–100.
 */
export function thresholdOrDefault(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : fallback;
}

const AGENT_STATE_PL: Record<string, string> = {
  stale: "nieaktualny",
  offline: "rozłączony",
  pending: "oczekujący",
  revoked: "odwołany",
};

/**
 * Tekst dla statusu unknown. Gdy backend poda addytywne pola agentStatus /
 * unknownReason, UI używa ich (po ludzku, bez surowego dumpu); inaczej
 * dotychczasowy ogólny tekst. Nieznane wartości ignoruje.
 */
export function unknownHint(service: MonitoredService): string {
  const reason = typeof service.unknownReason === "string" ? service.unknownReason.trim() : "";
  if (reason.length > 0) {
    return reason.slice(0, 200);
  }
  const agent = typeof service.agentStatus === "string" ? service.agentStatus : "";
  const label = AGENT_STATE_PL[agent];
  if (label) {
    return `Brak pomiarów — agent ${label}. Przerwa liczy się jako nieznana, nie jako awaria.`;
  }
  return "Brak pomiarów — możliwe, że agent jest rozłączony. Przerwa liczy się jako nieznana, nie jako awaria.";
}

/**
 * Podstawowa dostępność na zwiniętej karcie: sam wynik (bez rozbicia
 * „zmierzono/nieznane" — te szczegóły są w Szczegółach).
 */
function AvailabilitySummary({ service }: { service: MonitoredService }): React.JSX.Element {
  if (service.availabilityPercent === null || service.availabilityPercent === undefined) {
    return (
      <span
        className="age-text"
        tabIndex={0}
        title="Dostępność w zmierzonym czasie — potrzeba co najmniej dwóch próbek z tego samego celu."
      >
        Za mało pomiarów
      </span>
    );
  }
  return (
    <span
      className="age-text"
      tabIndex={0}
      title="Dostępność w zmierzonym czasie (ostatnie 24 h lub od zmiany celu). Przerwy bez pomiarów nie są liczone ani jako dostępność, ani jako awaria."
    >
      {formatAvailability(service)}
    </span>
  );
}

/** Szczegół dostępności (Szczegóły karty): wynik + pokrycie pomiarami. */
function AvailabilityNote({ service }: { service: MonitoredService }): React.JSX.Element {
  if (service.availabilityPercent === null || service.availabilityPercent === undefined) {
    return (
      <span
        className="age-text"
        tabIndex={0}
        title="Dostępność w zmierzonym czasie — potrzeba co najmniej dwóch próbek z tego samego celu."
      >
        Za mało pomiarów
      </span>
    );
  }
  const observedMin = Math.round(service.observedSeconds / 60);
  const unknownMin = Math.round(service.unknownSeconds / 60);
  return (
    <span
      className="age-text"
      tabIndex={0}
      title="Dostępność w zmierzonym czasie (ostatnie 24 h lub od zmiany celu). Przerwy bez pomiarów nie są liczone ani jako dostępność, ani jako awaria."
    >
      {formatAvailability(service)} · zmierzono ~{observedMin} min, nieznane ~{unknownMin} min
    </span>
  );
}

function LatencyChart({ history }: { history: ServiceHistory }): React.JSX.Element {
  const summaryId = useId();
  const points = useMemo(() => {
    const ordered = [...history.results]
      .filter((r) => Number.isFinite(Date.parse(r.checkedAt)) && Number.isFinite(r.latencyMs))
      .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt))
      .slice(-48);
    return ordered;
  }, [history.results]);
  if (points.length < 2) {
    return <p className="age-text">Za mało pomiarów do wykresu opóźnień.</p>;
  }
  const width = 480;
  const height = 120;
  const pad = 8;
  const max = Math.max(1, ...points.map((p) => p.latencyMs));
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const path = points
    .map((p, i) => {
      const x = pad + i * step;
      const y = height - pad - (Math.min(p.latencyMs, max) / max) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points[points.length - 1];
  const summary =
    `Opóźnienia odpowiedzi: od ${formatDateTime(points[0].checkedAt)} ` +
    `do ${formatDateTime(last.checkedAt)}. Ostatnie: ${formatLatency(last.latencyMs)}.`;
  return (
    <div>
      <svg
        className="history-chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Historia opóźnień odpowiedzi"
        aria-describedby={summaryId}
      >
        <path d={path} fill="none" stroke="var(--md-sys-color-primary)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => {
          const x = pad + i * step;
          const y = height - pad - (Math.min(p.latencyMs, max) / max) * (height - pad * 2);
          return (
            <circle
              key={`${p.checkedAt}-${i}`}
              cx={x}
              cy={y}
              r={p.ok ? 3 : 5}
              fill={p.ok ? "var(--md-sys-color-primary)" : "var(--md-sys-color-error)"}
            >
              <title>{`${formatDateTime(p.checkedAt)} · ${p.ok ? "OK" : "błąd"} ${p.statusCode ?? p.errorCode ?? ""}`.trim()}</title>
            </circle>
          );
        })}
      </svg>
      <p id={summaryId} className="visually-hidden">{summary}</p>
    </div>
  );
}

function RecentTimeline({ history }: { history: ServiceHistory }): React.JSX.Element {
  const recent = [...history.results]
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))
    .slice(0, 30);
  if (recent.length === 0) return <p className="age-text">Brak pomiarów w historii.</p>;
  return (
    <div>
      <div className="svc-timeline" role="list" aria-label="Ostatnie pomiary">
        {recent.map((r, i) => (
          <span
            key={`${r.checkedAt}-${i}`}
            role="listitem"
            tabIndex={0}
            className={`svc-dot ${r.ok ? "svc-dot--ok" : "svc-dot--fail"}`}
            title={`${formatDateTime(r.checkedAt)} · ${r.ok ? "OK" : "błąd"}${r.statusCode ? ` · HTTP ${r.statusCode}` : ""}${r.errorCode && !r.ok ? ` · ${r.errorCode}` : ""}`}
            aria-label={`${formatDateTime(r.checkedAt)} · ${r.ok ? "pomiar udany" : "pomiar nieudany"}`}
          />
        ))}
      </div>
      {history.incidents.length > 0 ? (
        <ul className="svc-incidents">
          {history.incidents.slice(0, 5).map((incident) => (
            <li key={incident.id}>
              <Icon name={incident.resolvedAt ? "check" : "warn"} /> Awaria: otwarta{" "}
              {formatDateTime(incident.openedAt)}
              {incident.resolvedAt ? `, rozwiązana ${formatDateTime(incident.resolvedAt)}` : ", nadal otwarta"}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface ServiceFormValues {
  name: string;
  path: string;
  statuses: string;
  intervalSeconds: string;
  timeoutSeconds: string;
  failureThreshold: string;
  successThreshold: string;
}

const DEFAULT_FORM: ServiceFormValues = {
  name: "",
  path: "",
  statuses: "",
  intervalSeconds: "30",
  timeoutSeconds: "5",
  failureThreshold: "3",
  successThreshold: "2",
};

function ServiceForm({
  values,
  onChange,
  prefix,
  transport = "http",
}: {
  values: ServiceFormValues;
  onChange: (next: ServiceFormValues) => void;
  prefix: string;
  transport?: "http" | "tcp";
}): React.JSX.Element {
  const statusesParsed = parseStatusesInput(values.statuses);
  const interval = Number.parseInt(values.intervalSeconds, 10);
  const timeout = Number.parseInt(values.timeoutSeconds, 10);
  const failures = Number.parseInt(values.failureThreshold, 10);
  const successes = Number.parseInt(values.successThreshold, 10);
  return (
    <div className="svc-form">
      <TextField
        id={`${prefix}-name`}
        label="Nazwa usługi"
        value={values.name}
        onChange={(v) => onChange({ ...values, name: v })}
        hint="Przyjazna nazwa, np. Jellyfin (dom)."
      />
      {transport === "http" ? (
        <>
          <TextField
            id={`${prefix}-path`}
            label="Ścieżka HTTP (względna)"
            value={values.path}
            onChange={(v) => onChange({ ...values, path: v })}
            error={
              values.path && !isSafePathInput(values.path)
                ? "Ścieżka musi zaczynać się pojedynczym „/”, bez hosta, spacji i „@”."
                : undefined
            }
            hint="Np. /Health — tylko ścieżka względna, nigdy adres URL."
          />
          <TextField
            id={`${prefix}-statuses`}
            label="Oczekiwane kody HTTP (po przecinku)"
            value={values.statuses}
            onChange={(v) => onChange({ ...values, statuses: v })}
            error={values.statuses && statusesParsed === null ? "Podaj 1–10 kodów 100–599, np. 200." : undefined}
            hint="Np. 200 albo 200, 401."
          />
        </>
      ) : (
        <p className="age-text">
          Sprawdzane będzie samo połączenie TCP (connect) na porcie usługi — bez ścieżki,
          bez kodów HTTP i bez odczytu treści.
        </p>
      )}
      <details className="svc-advanced">
        <summary>Ustawienia zaawansowane (interwał, progi)</summary>
        <TextField
          id={`${prefix}-interval`}
          label="Interwał pomiaru (s, 15–3600)"
          value={values.intervalSeconds}
          onChange={(v) => onChange({ ...values, intervalSeconds: v })}
          error={
            values.intervalSeconds && (!Number.isInteger(interval) || interval < 15 || interval > 3600)
              ? "Interwał musi być liczbą całkowitą 15–3600."
              : undefined
          }
        />
        <TextField
          id={`${prefix}-timeout`}
          label="Limit czasu próby (s, 1–10, mniej niż interwał)"
          value={values.timeoutSeconds}
          onChange={(v) => onChange({ ...values, timeoutSeconds: v })}
          error={
            values.timeoutSeconds &&
            (!Number.isInteger(timeout) || timeout < 1 || timeout > 10 || (Number.isInteger(interval) && timeout >= interval))
              ? "Limit musi być 1–10 s i mniejszy niż interwał."
              : undefined
          }
        />
        <TextField
          id={`${prefix}-failures`}
          label="Próg awarii N (1–100)"
          value={values.failureThreshold}
          onChange={(v) => onChange({ ...values, failureThreshold: v })}
          error={
            values.failureThreshold && (!Number.isInteger(failures) || failures < 1 || failures > 100)
              ? "Próg N musi być liczbą 1–100."
              : undefined
          }
          hint="Ile kolejnych niepowodzeń otwiera awarię (domyślnie 3)."
        />
        <TextField
          id={`${prefix}-successes`}
          label="Próg powrotu M (1–100)"
          value={values.successThreshold}
          onChange={(v) => onChange({ ...values, successThreshold: v })}
          error={
            values.successThreshold && (!Number.isInteger(successes) || successes < 1 || successes > 100)
              ? "Próg M musi być liczbą 1–100."
              : undefined
          }
          hint="Ile kolejnych sukcesów zamyka awarię (domyślnie 2)."
        />
      </details>
    </div>
  );
}

function formToCreateInput(
  values: ServiceFormValues,
  agentId: string,
  candidateId: string,
  transport: "http" | "tcp" = "http",
): {
  ok: boolean;
  input?: Parameters<typeof createService>[0];
  error?: string;
} {
  const interval = Number.parseInt(values.intervalSeconds, 10);
  const timeout = Number.parseInt(values.timeoutSeconds, 10);
  const failures = Number.parseInt(values.failureThreshold, 10);
  const successes = Number.parseInt(values.successThreshold, 10);
  if (!values.name.trim()) return { ok: false, error: "Podaj nazwę usługi." };
  const http = transport === "http";
  const statuses = http ? parseStatusesInput(values.statuses) : [];
  if (http && !isSafePathInput(values.path)) {
    return { ok: false, error: "Ścieżka musi zaczynać się pojedynczym „/”." };
  }
  if (http && statuses === null) return { ok: false, error: "Oczekiwane kody: 1–10 kodów 100–599." };
  if (!Number.isInteger(interval) || interval < 15 || interval > 3600) {
    return { ok: false, error: "Interwał musi być liczbą całkowitą 15–3600." };
  }
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10 || timeout >= interval) {
    return { ok: false, error: "Limit czasu musi być 1–10 s i mniejszy niż interwał." };
  }
  if (!Number.isInteger(failures) || failures < 1 || failures > 100) {
    return { ok: false, error: "Próg awarii N musi być liczbą 1–100." };
  }
  if (!Number.isInteger(successes) || successes < 1 || successes > 100) {
    return { ok: false, error: "Próg powrotu M musi być liczbą 1–100." };
  }
  return {
    ok: true,
    input: {
      agentId,
      candidateId,
      name: values.name.trim(),
      // TCP carries no HTTP path/status semantics; Core stores empty ones.
      ...(http ? { path: values.path, expectedStatuses: statuses ?? [] } : {}),
      intervalSeconds: interval,
      timeoutSeconds: timeout,
      failureThreshold: failures,
      successThreshold: successes,
    },
  };
}

function ServiceCard({
  service,
  publicSummary,
  readOnly,
  readOnlyHint,
  busy,
  onTogglePause,
  onEdit,
  onRemove,
  onReloadPublic,
  onSessionExpired,
}: {
  service: MonitoredService;
  /** Podsumowanie publicznych URL-i ładowane przez stronę (bez rozwijania karty). */
  publicSummary?: PublicSummaryEntry | null;
  readOnly: boolean;
  readOnlyHint: string;
  busy: boolean;
  onTogglePause: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onReloadPublic: () => void;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<ServiceHistory | null>(null);
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "error">("idle");

  async function loadHistory(): Promise<void> {
    setHistoryState("loading");
    try {
      const data = await getServiceHistory(service.id, HISTORY_LIMIT);
      setHistory(data);
      setHistoryState("idle");
    } catch {
      setHistoryState("error");
    }
  }

  function toggleExpanded(): void {
    const next = !expanded;
    setExpanded(next);
    if (next && !history && historyState !== "loading") {
      void loadHistory();
    }
    // Publiczne URL-e strona pobiera od razu przy montażu karty (stan w
    // ServicesPage), więc rozwinięcie NIE wywołuje drugiego requesta — bez
    // dublowania i bez czekania na „Szczegóły" na status publiczny.
  }

  const firstProbe = service.status === "unknown" && service.lastCheckedAt === null && service.enabled;
  const lastCode = service.lastStatusCode !== null && service.lastStatusCode !== undefined
    ? `HTTP ${service.lastStatusCode}`
    : null;

  const isTcp = service.transport === "tcp";
  const lastError = typeof service.lastErrorCode === "string" && service.lastErrorCode
    ? service.lastErrorCode
    : null;

  return (
    <article className="card svc-card" aria-labelledby={`svc-${service.id}-title`}>
      <div className="svc-card-head">
        <div>
          <h3 id={`svc-${service.id}-title`} className="section-title">
            {service.name}
          </h3>
          <p className="age-text">{service.agentHostname || service.agentId}</p>
        </div>
        <ServiceStatusBadge status={service.status} />
      </div>

      {/* Status publicznego URL widoczny od razu — bez rozwijania karty. */}
      <div className="svc-public">
        <PublicStatusSummary summary={publicSummary} />
      </div>

      <dl className="svc-meta">
        <div>
          <dt>Dostępność (24 h)</dt>
          <dd><AvailabilitySummary service={service} /></dd>
        </div>
        <div>
          <dt>CPU procesu</dt>
          <dd className="metric-value" title={PROCESS_CPU_TOOLTIP}>
            {formatProcessCpu(service.processCpuPercent)}
          </dd>
        </div>
        <div>
          <dt>RAM procesu</dt>
          <dd className="metric-value">{formatProcessMemory(service.processMemoryRssBytes)}</dd>
        </div>
      </dl>

      {firstProbe ? (
        <p className="age-text" role="status">
          Pierwszy pomiar w drodze — pojawi się po najbliższym cyklu agenta (do ~30 s).
        </p>
      ) : null}
      {service.status === "unknown" && !firstProbe && service.enabled ? (
        <p className="age-text">
          {unknownHint(service)}
        </p>
      ) : null}
      {service.status === "degraded" ? (
        <p className="age-text">
          Ostatni pomiar nieudany{lastError ? ` (${lastError})` : ""} — nieudane próby z rzędu:{" "}
          {service.consecutiveFailures}. Próg potwierdzonej awarii nie został jeszcze osiągnięty;
          usługa nie jest pokazywana jako działająca.
        </p>
      ) : null}
      {service.status === "down" ? (
        <p className="age-text">
          Usługa nie odpowiada (nieudane próby z rzędu: {service.consecutiveFailures}).
        </p>
      ) : null}

      <div className="svc-actions">
        <button type="button" className="btn btn--tonal" aria-expanded={expanded} onClick={toggleExpanded}>
          {expanded ? "Ukryj szczegóły" : "Szczegóły"}
        </button>
        <button
          type="button"
          className="btn btn--outlined"
          disabled={readOnly || busy}
          title={readOnly ? readOnlyHint : undefined}
          onClick={onTogglePause}
        >
          <Icon name={service.enabled ? "pause" : "play"} />
          {service.enabled ? "Wstrzymaj" : "Wznów"}
        </button>
        <button
          type="button"
          className="btn btn--outlined"
          disabled={readOnly || busy}
          title={readOnly ? readOnlyHint : undefined}
          onClick={onEdit}
        >
          Edytuj
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={readOnly || busy}
          title={readOnly ? readOnlyHint : undefined}
          onClick={onRemove}
        >
          Usuń
        </button>
      </div>

      {expanded ? (
        <div className="svc-detail">
          {/* Dane techniczne i dokładne daty — zgodnie z układem karty schowane
              pod „Szczegóły"; nic nie znika, tylko nie zasłania skrótu. */}
          <dl className="svc-meta">
            <div>
              <dt>{isTcp ? "Sprawdzanie" : "Port"}</dt>
              <dd>
                {isTcp
                  ? "Połączenie TCP (connect) — bez ścieżki i bez kodów HTTP."
                  : `${service.port} na hoście ${service.agentHostname || service.agentId}`}
              </dd>
            </div>
            {!isTcp ? (
              <>
                <div>
                  <dt>Ścieżka HTTP</dt>
                  <dd className="age-text mono">{service.path}</dd>
                </div>
                <div>
                  <dt>Oczekiwane kody HTTP</dt>
                  <dd className="age-text">{service.expectedStatuses.join(", ")}</dd>
                </div>
              </>
            ) : null}
            <div>
              <dt>Opóźnienie</dt>
              <dd className="metric-value">
                {formatLatency(service.lastLatencyMs)}
                {lastCode ? ` · ${lastCode}` : ""}
              </dd>
            </div>
            <div>
              <dt>Dostępność — zmierzony czas</dt>
              <dd><AvailabilityNote service={service} /></dd>
            </div>
            <div>
              <dt>Czas pracy usługi</dt>
              <dd>
                {service.status === "up" && service.upSince
                  ? `Działa nieprzerwanie od ${formatDateTime(service.upSince)}`
                  : service.status === "degraded"
                    ? "Ostatni pomiar nieudany — ciągłość przerwana, brak potwierdzonej awarii."
                    : service.status === "paused"
                      ? "Monitoring wstrzymany."
                      : "Brak ciągłości pomiarów — usługa nie przeszła progu sukcesów."}
              </dd>
            </div>
            {service.lastRestartAt ? (
              <div>
                <dt>Restart procesu</dt>
                <dd>
                  Wykryto restart procesu {formatDateTime(service.lastRestartAt)} — ciągłość
                  liczona od pierwszego zdrowego pomiaru (nie od restartu).
                </dd>
              </div>
            ) : null}
            {service.processStartedAt ? (
              <div>
                <dt>Proces</dt>
                <dd>Proces uruchomiono {formatDateTime(service.processStartedAt)} (oddzielne od czasu pomiarów).</dd>
              </div>
            ) : null}
          </dl>

          {historyState === "loading" ? (
            <div aria-label="Ładowanie historii usługi"><div className="skeleton" /><div className="skeleton" /></div>
          ) : historyState === "error" ? (
            <Banner tone="error" actions={<button type="button" className="btn btn--text" onClick={() => void loadHistory()}>Ponów</button>}>
              Nie udało się pobrać historii pomiarów.
            </Banner>
          ) : history ? (
            <div>
              <h4 className="section-title">Opóźnienia</h4>
              <LatencyChart history={history} />
              <h4 className="section-title">Ostatnie pomiary i awarie</h4>
              <RecentTimeline history={history} />
            </div>
          ) : (
            <div aria-label="Ładowanie historii usługi"><div className="skeleton" /></div>
          )}

          {/* Publiczne URL-e renderują się niezależnie od stanu historii:
              błąd/ładowanie historii nie znika sekcji CRuD, a błąd pobrania
              listy nie udaje „Brak dodanych adresów". */}
          {publicSummary && publicSummary.endpoints === null && publicSummary.state === "error" ? (
            <Banner tone="error" actions={<button type="button" className="btn btn--text" onClick={onReloadPublic}>Ponów</button>}>
              Nie udało się pobrać publicznych adresów URL.{publicSummary.error ? ` ${publicSummary.error}` : ""}
            </Banner>
          ) : publicSummary && publicSummary.endpoints === null && publicSummary.state === "loading" ? (
            <div aria-label="Ładowanie publicznych adresów URL"><div className="skeleton" /></div>
          ) : publicSummary && publicSummary.endpoints !== null ? (
            <div>
              {publicSummary.state === "error" ? (
                <Banner tone="error" actions={<button type="button" className="btn btn--text" onClick={onReloadPublic}>Ponów</button>}>
                  Nie udało się odświeżyć listy publicznych adresów — pokazujemy ostatnie znane dane.
                  {publicSummary.error ? ` ${publicSummary.error}` : ""}
                </Banner>
              ) : null}
              <PublicEndpointsSection
                serviceId={service.id}
                serviceName={service.name}
                endpoints={publicSummary.endpoints}
                readOnly={readOnly}
                readOnlyHint={readOnlyHint}
                onChanged={onReloadPublic}
                onSessionExpired={onSessionExpired}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ServicesPage({
  onSessionExpired,
}: {
  onSessionExpired: () => void;
}): React.JSX.Element {
  const online = useOnline();
  const visible = usePageVisible();
  const tablistId = useId();
  const [tab, setTab] = useState<Tab>("monitored");
  const [services, setServices] = useState<MonitoredService[]>([]);
  const [candidates, setCandidates] = useState<DiscoveredCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [enableTarget, setEnableTarget] = useState<DiscoveredCandidate | null>(null);
  const [enableForm, setEnableForm] = useState<ServiceFormValues>(DEFAULT_FORM);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [enableBusy, setEnableBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<MonitoredService | null>(null);
  const [editForm, setEditForm] = useState<ServiceFormValues>(DEFAULT_FORM);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MonitoredService | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const loadAll = useCallback(
    async (initial: boolean) => {
      try {
        const [nextServices, nextCandidates] = await Promise.all([listServices(), listDiscovered()]);
        setServices(nextServices);
        setCandidates(nextCandidates);
        setError(null);
        setRefreshWarning(null);
        if (initial) setLoading(false);
      } catch (err) {
        if (isUnauthorized(err)) {
          onSessionExpired();
          return;
        }
        const message = err instanceof Error ? err.message : "Nie udało się pobrać usług.";
        if (initial) {
          setError(message);
          setLoading(false);
        } else {
          setRefreshWarning(message);
        }
      }
    },
    [onSessionExpired],
  );

  /**
   * Podsumowanie publicznych adresów URL — jeden spójny stan dla całego listy
   * kart (a nie N niezależnych pobrań na rozwiniecie). Karty ładują się
   * automatycznie przy montażu (bounded parallel), odświeżają nie częściej niż
   * PUBLIC_REFRESH_MS i tylko gdy karta jest widoczna; rozwinięcie „Szczegółów"
   * nie wywołuje drugiego requesta. Błąd NIGDY nie udaje pustej listy.
   */
  const [publicSummaries, setPublicSummaries] = useState<Record<string, PublicSummaryEntry>>({});
  const publicInFlight = useRef<Set<string>>(new Set());

  const runPublicFetch = useCallback(
    async (id: string, force: boolean): Promise<void> => {
      // Auto-odświeżanie pomija usługę, której request już leci (bez dublowania);
      // wymuszenie po CRuD zawsze pobiera świeżo.
      if (!force && publicInFlight.current.has(id)) return;
      publicInFlight.current.add(id);
      try {
        const endpoints = await listPublicEndpoints(id);
        setPublicSummaries((prev) => ({
          ...prev,
          [id]: { endpoints, state: "idle", error: null, loadedAt: Date.now() },
        }));
      } catch (err) {
        if (isUnauthorized(err)) {
          // Wygasła sesja to normalny flow auth (wylogowanie), nie „brak adresów".
          onSessionExpired();
          setPublicSummaries((prev) => ({
            ...prev,
            [id]: { endpoints: null, state: "idle", error: null, loadedAt: 0 },
          }));
          return;
        }
        const message = err instanceof Error ? err.message : "Nie udało się pobrać publicznych adresów URL.";
        setPublicSummaries((prev) => {
          const current = prev[id];
          // Zostawiamy ostatnią znaną listę zamiast udawać pusty stan — prawdziwy
          // pusty wynik to `[]`, nie błąd sieci/serwera.
          return {
            ...prev,
            [id]: {
              endpoints: current?.endpoints ?? null,
              state: "error",
              error: message,
              loadedAt: Date.now(),
            },
          };
        });
      } finally {
        publicInFlight.current.delete(id);
      }
    },
    [onSessionExpired],
  );

  const loadPublic = useCallback(
    async (ids: string[], force = false): Promise<void> => {
      if (ids.length === 0) return;
      // Szkielet tylko dla usług bez żadnych danych (odświeżanie nie mruga).
      setPublicSummaries((prev) => {
        let next = prev;
        for (const id of ids) {
          if (!(id in prev)) {
            next = { ...next, [id]: { endpoints: null, state: "loading", error: null, loadedAt: 0 } };
          }
        }
        return next;
      });
      await mapLimit(ids, PUBLIC_FETCH_CONCURRENCY, (id) => runPublicFetch(id, force));
    },
    [runPublicFetch],
  );

  /** Wymuszone odświeżenie jednej usługi (po dodaniu/edycji/wstrzymaniu URL-i). */
  const reloadPublic = useCallback(
    (id: string): void => {
      void loadPublic([id], true);
    },
    [loadPublic],
  );

  // Referencje do efektu odświeżania: interwał ma powstać raz, a nie przy
  // każdej zmianie listy usług (inaczej tyk nigdy by nie dojrzewał).
  const servicesRef = useRef(services);
  servicesRef.current = services;
  const publicSummariesRef = useRef(publicSummaries);
  publicSummariesRef.current = publicSummaries;
  const loadPublicRef = useRef(loadPublic);
  loadPublicRef.current = loadPublic;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await loadAll(true);
    })();
    const timer = window.setInterval(() => {
      if (!cancelled && document.visibilityState === "visible") {
        void loadAll(false);
      }
    }, SERVICES_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadAll]);

  // Publiczne URL-e ładują się od razu dla każdej karty (także zwiniętej) —
  // bez czekania na rozwinięcie „Szczegółów". Jedno pobranie na usługę.
  useEffect(() => {
    const missing = services.map((s) => s.id).filter((id) => !(id in publicSummaries));
    if (missing.length > 0) void loadPublic(missing);
  }, [services, publicSummaries, loadPublic]);

  // Odświeżanie podsumowania w rytmie strony (co 15 s), ale nie częściej niż
  // PUBLIC_REFRESH_MS na usługę i tylko gdy karta jest widoczna — małe usługi
  // nie generują zbędnego N+1 co 15 s.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const stale = servicesRef.current
        .filter((service) => {
          const entry = publicSummariesRef.current[service.id];
          return entry !== undefined && entry.state !== "loading" && now - entry.loadedAt >= PUBLIC_REFRESH_MS;
        })
        .map((service) => service.id);
      if (stale.length > 0) void loadPublicRef.current(stale);
    }, SERVICES_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const refreshHealthy = online && refreshWarning === null;
  const readOnly = !online;
  const readOnlyHint = "Brak połączenia — tryb tylko do odczytu. Akcje będą dostępne po powrocie sieci.";

  // The discovered tab is an action list, not a technical port dump: only
  // available, recognised HTTP candidates that can actually be enabled are
  // shown. Unknown/unmonitorable rows stay in the backend untouched.
  const visibleCandidates = useMemo(
    () =>
      candidates
        .filter((c) => c.available && isMonitorable(c))
        .sort(
          (a, b) =>
            a.agentHostname.localeCompare(b.agentHostname) || a.port - b.port,
        ),
    [candidates],
  );

  function openEnable(candidate: DiscoveredCandidate): void {
    const preset = presetFor(candidate.kind);
    const http = candidate.transport === "http";
    setEnableForm({
      ...DEFAULT_FORM,
      name: candidate.name,
      path: http ? (candidate.suggestedPath ?? preset.path) : "",
      statuses: http
        ? (candidate.suggestedStatuses.length > 0 ? candidate.suggestedStatuses : preset.statuses).join(", ")
        : "",
    });
    setEnableError(null);
    setEnableTarget(candidate);
  }

  async function handleEnable(): Promise<void> {
    if (!enableTarget) return;
    const parsed = formToCreateInput(
      enableForm,
      enableTarget.agentId,
      enableTarget.candidateId,
      enableTarget.transport === "tcp" ? "tcp" : "http",
    );
    if (!parsed.ok || !parsed.input) {
      setEnableError(parsed.error ?? "Sprawdź formularz.");
      return;
    }
    setEnableBusy(true);
    setEnableError(null);
    try {
      const created = await createService(parsed.input);
      setEnableTarget(null);
      setNotice(`Włączono monitoring usługi ${created.name}.`);
      setTab("monitored");
      await loadAll(false);
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionExpired();
        return;
      }
      setEnableError(err instanceof Error ? err.message : "Nie udało się włączyć monitoringu.");
    } finally {
      setEnableBusy(false);
    }
  }

  function openEdit(service: MonitoredService): void {
    setEditForm({
      name: service.name,
      path: service.path,
      statuses: service.expectedStatuses.join(", "),
      intervalSeconds: String(service.intervalSeconds),
      timeoutSeconds: String(service.timeoutSeconds),
      failureThreshold: String(thresholdOrDefault(service.failureThreshold, DEFAULT_FAILURE_THRESHOLD)),
      successThreshold: String(thresholdOrDefault(service.successThreshold, DEFAULT_SUCCESS_THRESHOLD)),
    });
    setEditError(null);
    setEditTarget(service);
  }

  async function handleEdit(): Promise<void> {
    if (!editTarget) return;
    const isTcp = editTarget.transport === "tcp";
    const parsed = formToCreateInput(
      editForm,
      editTarget.agentId,
      editTarget.candidateId,
      isTcp ? "tcp" : "http",
    );
    if (!parsed.ok || !parsed.input) {
      setEditError(parsed.error ?? "Sprawdź formularz.");
      return;
    }
    const { agentId: _agentId, candidateId: _candidateId, ...patch } = parsed.input;
    void _agentId;
    void _candidateId;
    // TCP targets have no HTTP path/status fields to send back.
    if (isTcp) {
      delete (patch as { path?: string }).path;
      delete (patch as { expectedStatuses?: number[] }).expectedStatuses;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      const updated = await updateService(editTarget.id, patch);
      setEditTarget(null);
      setNotice(`Zapisano zmiany usługi ${updated.name}.`);
      await loadAll(false);
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionExpired();
        return;
      }
      setEditError(err instanceof Error ? err.message : "Nie udało się zapisać zmian.");
    } finally {
      setEditBusy(false);
    }
  }

  async function handleTogglePause(service: MonitoredService): Promise<void> {
    setBusyId(service.id);
    try {
      await updateService(service.id, { enabled: !service.enabled });
      setNotice(service.enabled ? `Wstrzymano monitoring usługi ${service.name}.` : `Wznowiono monitoring usługi ${service.name}.`);
      await loadAll(false);
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionExpired();
        return;
      }
      setRefreshWarning(err instanceof Error ? err.message : "Nie udało się zmienić stanu usługi.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(): Promise<void> {
    if (!removeTarget) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await deleteService(removeTarget.id);
      setNotice(`Usunięto usługę ${removeTarget.name}.`);
      setRemoveTarget(null);
      await loadAll(false);
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionExpired();
        return;
      }
      setRemoveError(err instanceof Error ? err.message : "Nie udało się usunąć usługi.");
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <div className="main-content-inner">
      <div className="svc-header">
        <h1 className="page-title">Usługi</h1>
        <span className="age-text">
          {visible ? `Dane odświeżają się co ${POLL_SECONDS} sekund` : `Automatyczne odświeżanie co ${POLL_SECONDS} sekund`}
        </span>
      </div>

      {!online ? (
        <Banner tone="offline" role="status">
          Brak połączenia z siecią — wyświetlane są ostatnie znane dane (tylko do odczytu).
        </Banner>
      ) : null}
      {refreshWarning ? (
        <Banner
          tone="warn"
          role="status"
          actions={<button type="button" className="btn btn--text" onClick={() => void loadAll(false)}>Odśwież</button>}
        >
          Nie udało się odświeżyć danych — poniżej ostatnie znane. Dane mogą być nieaktualne. {refreshWarning}
        </Banner>
      ) : null}
      {notice ? <Banner tone="info" role="status">{notice}</Banner> : null}

      <div className="svc-tabs" role="tablist" aria-label="Usługi" id={tablistId}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "monitored"}
          aria-controls="svc-panel-monitored"
          id="svc-tab-monitored"
          className={`svc-tab${tab === "monitored" ? " svc-tab--active" : ""}`}
          onClick={() => setTab("monitored")}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setTab("discovered");
          }}
        >
          Monitorowane ({services.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "discovered"}
          aria-controls="svc-panel-discovered"
          id="svc-tab-discovered"
          className={`svc-tab${tab === "discovered" ? " svc-tab--active" : ""}`}
          onClick={() => setTab("discovered")}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setTab("monitored");
          }}
        >
          Wykryte na serwerach ({visibleCandidates.length})
        </button>
      </div>

      {loading ? (
        <div className="card" aria-label="Ładowanie usług">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : error ? (
        <div className="card">
          <Banner
            tone="error"
            actions={<button type="button" className="btn btn--text" onClick={() => void loadAll(true)}>Ponów</button>}
          >
            {error}
          </Banner>
        </div>
      ) : tab === "monitored" ? (
        <div role="tabpanel" id="svc-panel-monitored" aria-labelledby="svc-tab-monitored" className="svc-grid">
          {services.length === 0 ? (
            <div className="card">
              <div className="empty-state">
                <Icon name="server" label="Ikona serwera" />
                <h2 className="section-title">Brak monitorowanych usług</h2>
                <p className="age-text">
                  Włącz monitoring z zakładki Wykryte na serwerach — jednym kliknięciem dla nasłuchów HTTP i TCP.
                </p>
                <button type="button" className="btn btn--filled" onClick={() => setTab("discovered")}>
                  Przejdź do wykrytych
                </button>
              </div>
            </div>
          ) : (
            services.map((service) => (
              <ServiceCard
                key={service.id}
                service={service}
                publicSummary={publicSummaries[service.id]}
                readOnly={readOnly}
                readOnlyHint={readOnlyHint}
                busy={busyId === service.id}
                onTogglePause={() => void handleTogglePause(service)}
                onEdit={() => openEdit(service)}
                onRemove={() => {
                  setRemoveError(null);
                  setRemoveTarget(service);
                }}
                onReloadPublic={() => reloadPublic(service.id)}
                onSessionExpired={onSessionExpired}
              />
            ))
          )}
        </div>
      ) : (
        <div role="tabpanel" id="svc-panel-discovered" aria-labelledby="svc-tab-discovered" className="svc-grid">
          {visibleCandidates.length === 0 ? (
            <div className="card">
              <div className="empty-state">
                <Icon name="server" label="Ikona serwera" />
                <h2 className="section-title">Nie znaleziono usług obsługiwanych przez monitoring</h2>
                <p className="age-text">
                  Pokazujemy wszystkie nasłuchy, które można monitorować — HTTP i TCP. Porty
                  z jawnie wyłączonym monitoringiem pozostają poza tą listą.
                </p>
              </div>
            </div>
          ) : (
            visibleCandidates.map((candidate) => {
              const key = `${candidate.agentId}:${candidate.candidateId}`;
              const tcp = candidate.transport === "tcp";
              return (
                <article className="card svc-card" key={key} aria-label={`${candidate.name} na porcie ${candidate.port}`}>
                  <div className="svc-card-head">
                    <div>
                      <h3 className="section-title">{candidate.name}</h3>
                      <p className="age-text" title={recognitionTooltip(candidate)}>
                        {candidate.agentHostname || candidate.agentId} · port {candidate.port} ·{" "}
                        {tcp ? "TCP" : "HTTP"}
                      </p>
                    </div>
                    {candidate.monitored ? (
                      <span className="status-badge status-badge--online"><Icon name="check" /> Monitorowana</span>
                    ) : !candidate.available ? (
                      <span className="status-badge status-badge--neutral"><Icon name="help" /> Niedostępna</span>
                    ) : null}
                  </div>
                  <p className="age-text" title={recognitionTooltip(candidate)}>{recognitionText(candidate)}</p>
                  {!candidate.available ? (
                    <p className="age-text">Usługa zniknęła z ostatniego odczytu agenta — nie można jej teraz włączyć.</p>
                  ) : null}
                  {!tcp && candidate.suggestedPath ? (
                    <p className="age-text mono">
                      {candidate.suggestedPath} · oczekiwane: {(candidate.suggestedStatuses.length > 0 ? candidate.suggestedStatuses : [200]).join(", ")}
                    </p>
                  ) : null}
                  {tcp ? (
                    <p className="age-text">
                      Monitorowanie TCP sprawdza samo połączenie (connect) — bez ścieżki i kodów HTTP.
                    </p>
                  ) : null}
                  {!candidate.available || candidate.monitored ? null : (
                    <div className="svc-actions">
                      <button
                        type="button"
                        className="btn btn--filled"
                        disabled={readOnly}
                        title={readOnly ? readOnlyHint : `Włącz monitoring: ${candidate.name}`}
                        onClick={() => openEnable(candidate)}
                      >
                        <Icon name="add" /> {tcp ? "Włącz monitoring TCP" : "Włącz monitoring"}
                      </button>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      )}

      {!refreshHealthy && !refreshWarning ? (
        <p className="age-text">Automatyczne odświeżanie wstrzymane (karta ukryta lub brak sieci).</p>
      ) : null}

      {enableTarget ? (
        <Dialog
          title={`Włączyć monitoring: ${enableTarget.name}?`}
          onClose={() => {
            if (!enableBusy) setEnableTarget(null);
          }}
          actions={
            <button type="button" className="btn btn--filled" disabled={enableBusy} onClick={() => void handleEnable()}>
              <Icon name="add" /> {enableBusy ? "Włączanie…" : "Włącz monitoring"}
            </button>
          }
        >
          {enableError ? <Banner tone="error">{enableError}</Banner> : null}
          <p className="age-text">
            {recognitionText(enableTarget)}{" "}
            {enableTarget.transport === "tcp" ? (
              <>Sprawdzane będzie połączenie TCP (connect) na porcie {enableTarget.port} — bez ścieżki i bez kodów HTTP.</>
            ) : (
              <>
                Sprawdzane będzie HTTP <span className="mono">{enableForm.path || "—"}</span> na porcie{" "}
                {enableTarget.port} (tylko dostępność HTTP, bez odczytu treści).
              </>
            )}
          </p>
          <ServiceForm
            values={enableForm}
            onChange={setEnableForm}
            prefix="svc-enable"
            transport={enableTarget.transport === "tcp" ? "tcp" : "http"}
          />
        </Dialog>
      ) : null}

      {editTarget ? (
        <Dialog
          title={`Edytuj usługę ${editTarget.name}`}
          onClose={() => {
            if (!editBusy) setEditTarget(null);
          }}
          actions={
            <button type="button" className="btn btn--filled" disabled={editBusy} onClick={() => void handleEdit()}>
              {editBusy ? "Zapisywanie…" : "Zapisz"}
            </button>
          }
        >
          {editError ? <Banner tone="error">{editError}</Banner> : null}
          <p className="age-text">
            {editTarget.transport === "tcp"
              ? "Dla celu TCP edytujesz nazwę i ustawienia zaawansowane; połączenie TCP nie ma ścieżki ani kodów HTTP."
              : "Zmiana ścieżki, kodów lub interwału resetuje zmierzony okres (nowa rewizja konfiguracji)."}
          </p>
          <ServiceForm
            values={editForm}
            onChange={setEditForm}
            prefix="svc-edit"
            transport={editTarget.transport === "tcp" ? "tcp" : "http"}
          />
        </Dialog>
      ) : null}

      {removeTarget ? (
        <Dialog
          title={`Usunąć usługę ${removeTarget.name}?`}
          onClose={() => {
            if (!removeBusy) setRemoveTarget(null);
          }}
          actions={
            <button type="button" className="btn btn--danger" disabled={removeBusy} onClick={() => void handleRemove()}>
              {removeBusy ? "Usuwanie…" : "Usuń usługę"}
            </button>
          }
        >
          {removeError ? <Banner tone="error">{removeError}</Banner> : null}
          <p>
            Monitoring hosta {removeTarget.agentHostname} na porcie {removeTarget.port} zostanie
            zatrzymany, a historia pomiarów tej usługi zniknie z listy. Tej operacji nie można cofnąć.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { getAgentMetrics, isUnauthorized, listAgents, revokeAgent } from "../api/client";
import { useOnline, usePageVisible } from "../hooks/hooks";
import type { AgentSummary, MetricSample } from "../types";
import {
  formatBytes,
  formatDateTime,
  formatPercent,
  formatUptime,
  ratioPercent,
} from "../utils/format";
import { Banner } from "../components/Banner";
import { Dialog } from "../components/Dialog";
import { HistoryChart } from "../components/HistoryChart";
import { Icon } from "../components/Icon";
import { PairingDialog } from "../components/PairingDialog";
import { StatusBadge } from "../components/StatusBadge";

const AGENTS_POLL_MS = 15_000;
const METRICS_POLL_MS = 15_000;

/**
 * Sekundy rzeczywistego interwału odświeżania UI — tekst podaje interwał
 * skonfigurowany (obie ankiety dashboardu mają tę samą wartość), nie wiek danych.
 */
const POLL_SECONDS = Math.round(Math.max(AGENTS_POLL_MS, METRICS_POLL_MS) / 1000);

/** Agent, którego dane przestały napływać — bez twierdzenia, że odświeżanie działa. */
function isAgentStale(status: AgentSummary["status"]): boolean {
  return status === "stale" || status === "offline" || status === "revoked";
}

/**
 * Świeżość danych bez licznika wieku ("X s temu" / "przed chwilą").
 * Zdrowy agent: stały tekst interwału — przy widocznej karcie polling działa
 * („na żywo"), przy ukrytej karcie polling jest wstrzymany, więc zostaje tylko
 * skonfigurowany interwał, bez fałszywego statusu na żywo.
 * Stale/offline/revoked albo nieskuteczne odświeżanie: jawne ostrzeżenie
 * o nieaktualności danych + ostatni znany odczyt (bez tykającego licznika).
 */
function FreshnessNote({
  healthy,
  intervalOnly,
  lastSeenAt,
}: {
  healthy: boolean;
  intervalOnly: boolean;
  lastSeenAt: string | null;
}): React.JSX.Element {
  const visible = usePageVisible();
  if (!healthy) {
    return (
      <span className="age-text">
        {lastSeenAt
          ? `Dane mogą być nieaktualne — ostatni odczyt: ${formatDateTime(lastSeenAt)}`
          : "Dane mogą być nieaktualne"}
      </span>
    );
  }
  const text =
    visible && !intervalOnly
      ? `Dane odświeżają się co ${POLL_SECONDS} sekund`
      : `Automatyczne odświeżanie co ${POLL_SECONDS} sekund`;
  return <span className="age-text">{text}</span>;
}

function MetricCard({
  label,
  main,
  sub,
  barPercent,
}: {
  label: string;
  main: string;
  sub?: string;
  barPercent?: number | null;
}): React.JSX.Element {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-main metric-value">{main}</div>
      {sub ? <div className="metric-sub metric-value">{sub}</div> : null}
      {barPercent !== undefined && barPercent !== null ? (
        <div
          className="progress-track"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(100, Math.max(0, barPercent)))}
        >
          <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, barPercent))}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function AgentDetail({
  agent,
  samples,
  samplesState,
  refreshHealthy,
  onRetryMetrics,
}: {
  agent: AgentSummary;
  samples: MetricSample[];
  samplesState: { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };
  refreshHealthy: boolean;
  onRetryMetrics: () => void;
}): React.JSX.Element {
  const metrics = agent.metrics;
  const memPct = metrics ? ratioPercent(metrics.memoryUsedBytes, metrics.memoryTotalBytes) : null;
  const diskPct = metrics ? ratioPercent(metrics.diskUsedBytes, metrics.diskTotalBytes) : null;

  return (
    <section className="card" aria-labelledby={`agent-${agent.id}-title`}>
      <h2 id={`agent-${agent.id}-title`} className="section-title">
        {agent.hostname}
      </h2>
      <div className="agent-sub">
        <StatusBadge status={agent.status} />
        <FreshnessNote
          healthy={refreshHealthy && !isAgentStale(agent.status)}
          intervalOnly={agent.status !== "online"}
          lastSeenAt={agent.lastSeenAt}
        />
      </div>

      {agent.status === "revoked" ? (
        <Banner tone="warn">
          Dostęp agenta został odwołany. Aby wznowić monitoring, sparuj agenta ponownie nowym tokenem.
        </Banner>
      ) : null}

      {metrics ? (
        <div className="metrics-grid">
          <MetricCard label="CPU" main={formatPercent(metrics.cpuPercent)} />
          <MetricCard
            label="Pamięć"
            main={formatPercent(memPct)}
            sub={`${formatBytes(metrics.memoryUsedBytes)} z ${formatBytes(metrics.memoryTotalBytes)}`}
            barPercent={memPct}
          />
          <MetricCard
            label="Dysk"
            main={formatPercent(diskPct)}
            sub={`${formatBytes(metrics.diskUsedBytes)} z ${formatBytes(metrics.diskTotalBytes)}`}
            barPercent={diskPct}
          />
          <MetricCard label="Uptime hosta" main={formatUptime(metrics.uptimeSeconds)} />
          <MetricCard
            label="Sieć (liczniki)"
            main={`↓ ${formatBytes(metrics.networkRxBytes)}`}
            sub={`↑ ${formatBytes(metrics.networkTxBytes)}`}
          />
        </div>
      ) : (
        <p className="age-text">Brak próbek metryk dla tego agenta — pojawią się po pierwszym heartbeacie.</p>
      )}

      <h3 className="section-title">Historia CPU</h3>
      {samplesState.kind === "loading" ? (
        <div aria-label="Ładowanie historii"><div className="skeleton" /><div className="skeleton" /></div>
      ) : samplesState.kind === "error" ? (
        <Banner
          tone="error"
          actions={<button type="button" className="btn btn--text" onClick={onRetryMetrics}>Ponów</button>}
        >
          {samplesState.message} Dane mogą być nieaktualne.
        </Banner>
      ) : (
        <HistoryChart samples={samples} />
      )}
    </section>
  );
}

export function DashboardPage({
  onSessionExpired,
}: {
  onSessionExpired: () => void;
}): React.JSX.Element {
  const online = useOnline();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsState, setAgentsState] = useState<
    { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string }
  >({ kind: "loading" });
  // Nieudane odświeżenie przy posiadanych danych: dane zostają, widać banner.
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [samplesState, setSamplesState] = useState<
    { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [pairingOpen, setPairingOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AgentSummary | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAgents = useCallback(
    async (initial: boolean) => {
      try {
        const next = await listAgents();
        setAgents(next);
        setAgentsState({ kind: "ready" });
        setRefreshWarning(null);
        setSelectedId((current) => {
          if (current && next.some((agent) => agent.id === current)) {
            return current;
          }
          return next.length > 0 ? next[0].id : null;
        });
      } catch (error) {
        if (isUnauthorized(error)) {
          onSessionExpired();
          return;
        }
        const message = error instanceof Error ? error.message : "Nie udało się pobrać listy agentów.";
        if (initial) {
          setAgentsState({ kind: "error", message });
        } else {
          // Stale: stare dane zostają na ekranie + banner z ponowieniem.
          setRefreshWarning(message);
        }
      }
    },
    [onSessionExpired],
  );

  const loadMetrics = useCallback(
    async (agentId: string) => {
      setSamplesState({ kind: "loading" });
      try {
        const next = await getAgentMetrics(agentId);
        setSamples(next);
        setSamplesState({ kind: "ready" });
      } catch (error) {
        if (isUnauthorized(error)) {
          onSessionExpired();
          return;
        }
        setSamplesState({
          kind: "error",
          message: error instanceof Error ? error.message : "Nie udało się pobrać historii metryk.",
        });
      }
    },
    [onSessionExpired],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) {
        await loadAgents(true);
      }
    })();
    const timer = window.setInterval(() => {
      if (!cancelled && document.visibilityState === "visible") {
        void loadAgents(false);
      }
    }, AGENTS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadAgents]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      if (!cancelled) {
        await loadMetrics(selectedId);
      }
    })();
    const timer = window.setInterval(() => {
      if (!cancelled && document.visibilityState === "visible") {
        void loadMetrics(selectedId);
      }
    }, METRICS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedId, loadMetrics]);

  async function handleRevoke(): Promise<void> {
    if (!revokeTarget) {
      return;
    }
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await revokeAgent(revokeTarget.id);
      setRevokeTarget(null);
      setNotice(`Odwołano dostęp agenta ${revokeTarget.hostname}.`);
      await loadAgents(false);
    } catch (error) {
      if (isUnauthorized(error)) {
        onSessionExpired();
        return;
      }
      setRevokeError(error instanceof Error ? error.message : "Nie udało się odwołać dostępu.");
    } finally {
      setRevokeBusy(false);
    }
  }

  const selected = agents.find((agent) => agent.id === selectedId) ?? null;
  // Odświeżanie działa tylko przy sieci i po ostatnim udanym odświeżeniu listy.
  const refreshHealthy = online && refreshWarning === null;
  const readOnly = !online;
  const readOnlyHint = "Brak połączenia — tryb tylko do odczytu. Akcje będą dostępne po powrocie sieci.";

  return (
    <div className="main-content-inner">
      {!online ? (
        <Banner tone="offline" role="status">
          Brak połączenia z siecią — wyświetlane są ostatnie znane dane (tylko do odczytu). Parowanie i odwoływanie
          dostępu są wyłączone.
        </Banner>
      ) : null}
      {refreshWarning ? (
        <Banner
          tone="warn"
          role="status"
          actions={<button type="button" className="btn btn--text" onClick={() => void loadAgents(false)}>Odśwież</button>}
        >
          Nie udało się odświeżyć danych — poniżej ostatnie znane. Dane mogą być nieaktualne. {refreshWarning}
        </Banner>
      ) : null}
      {notice ? (
        <Banner tone="info" role="status">{notice}</Banner>
      ) : null}

      {agentsState.kind === "loading" ? (
        <div className="card" aria-label="Ładowanie listy agentów">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : agentsState.kind === "error" ? (
        <div className="card">
          <Banner
            tone="error"
            actions={<button type="button" className="btn btn--text" onClick={() => void loadAgents(true)}>Ponów</button>}
          >
            {agentsState.message}
          </Banner>
        </div>
      ) : agents.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Icon name="server" label="Ikona serwera" />
            <h2 className="section-title">Brak sparowanych agentów</h2>
            <p className="age-text">
              Wygeneruj jednorazowy token i sparuj pierwszego agenta Linux, aby zobaczyć metryki CPU, pamięci i dysku.
            </p>
            <button
              type="button"
              className="btn btn--filled"
              disabled={readOnly}
              title={readOnly ? readOnlyHint : undefined}
              onClick={() => setPairingOpen(true)}
            >
              <Icon name="add" /> Wygeneruj token parowania
            </button>
            {readOnly ? <p className="age-text">{readOnlyHint}</p> : null}
          </div>
        </div>
      ) : (
        <div className="dashboard-grid">
          <section className="card" aria-labelledby="agents-title">
            <div className="agent-sub">
              <h2 id="agents-title" className="section-title">Agenci</h2>
              <span className="spacer" style={{ flex: 1 }} />
              <button
                type="button"
                className="btn btn--tonal"
                disabled={readOnly}
                title={readOnly ? readOnlyHint : "Wygeneruj jednorazowy token parowania"}
                onClick={() => setPairingOpen(true)}
              >
                <Icon name="add" /> Paruj
              </button>
            </div>
            <ul className="agent-list">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className="agent-item"
                    aria-current={agent.id === selectedId}
                    onClick={() => {
                      setSelectedId(agent.id);
                      setNotice(null);
                    }}
                  >
                    <span className="agent-name">{agent.hostname}</span>
                    <span className="agent-sub">
                      <StatusBadge status={agent.status} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <div>
            {selected ? (
              <div>
                <AgentDetail
                  agent={selected}
                  samples={samples}
                  samplesState={samplesState}
                  refreshHealthy={refreshHealthy}
                  onRetryMetrics={() => void loadMetrics(selected.id)}
                />
                <div className="card" style={{ marginTop: 16 }}>
                  <h3 className="section-title">Dostęp agenta</h3>
                  <p className="age-text">
                    Odwołanie natychmiast odcina agenta (status revoked). Powrót wymaga ponownego parowania.
                  </p>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={readOnly || selected.status === "revoked"}
                    title={readOnly ? readOnlyHint : undefined}
                    onClick={() => {
                      setRevokeError(null);
                      setRevokeTarget(selected);
                    }}
                  >
                    <Icon name="revoke" /> Odwołaj dostęp
                  </button>
                </div>
              </div>
            ) : (
              <div className="card"><p className="age-text">Wybierz agenta z listy.</p></div>
            )}
          </div>
        </div>
      )}

      {pairingOpen ? <PairingDialog onClose={() => setPairingOpen(false)} /> : null}
      {revokeTarget ? (
        <Dialog
          title={`Odwołać dostęp agenta ${revokeTarget.hostname}?`}
          onClose={() => {
            if (!revokeBusy) {
              setRevokeTarget(null);
            }
          }}
          actions={
            <button type="button" className="btn btn--filled" disabled={revokeBusy} onClick={() => void handleRevoke()}>
              <Icon name="revoke" /> {revokeBusy ? "Odwoływanie…" : "Odwołaj dostęp"}
            </button>
          }
        >
          {revokeError ? <Banner tone="error">{revokeError}</Banner> : null}
          <p>
            Agent natychmiast straci dostęp (credential unieważniony po stronie Core). Monitoring tego hosta
            zatrzyma się do czasu ponownego parowania. Tej operacji nie można cofnąć.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}


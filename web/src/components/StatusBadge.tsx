import type { AgentStatus } from "../types";
import { Icon } from "./Icon";

const LABELS: Record<AgentStatus, string> = {
  online: "Online",
  stale: "Stale",
  offline: "Offline",
  pending: "Oczekujący",
  revoked: "Odwołany",
};

/**
 * Etykieta statusu agenta. Status NIGDY nie jest sygnalizowany samym kolorem:
 * zawsze ikona + tekst (ui-design §4, kryterium daltonizm/a11y).
 */
export function StatusBadge({ status }: { status: AgentStatus }): React.JSX.Element {
  const tone =
    status === "online"
      ? "status-badge--online"
      : status === "stale"
        ? "status-badge--stale"
        : status === "offline"
          ? "status-badge--offline"
          : "status-badge--neutral";
  const icon = status === "online" ? "check" : status === "stale" ? "warn" : status === "offline" ? "error" : "help";
  return (
    <span className={`status-badge ${tone}`}>
      <Icon name={icon} />
      {LABELS[status]}
    </span>
  );
}

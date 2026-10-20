import { useEffect, useState } from "react";
import { createPairingToken } from "../api/client";
import type { PairingToken } from "../types";
import { formatDateTime } from "../utils/format";
import { Banner } from "./Banner";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button type="button" className="btn btn--tonal" onClick={() => void copy()}>
      <Icon name="copy" /> {copied ? "Skopiowano" : "Kopiuj"}
    </button>
  );
}

/**
 * Dialog parowania: generuje JEDNORAZOWY token (TTL 15 min) i pokazuje
 * instrukcję dla operatora. Nigdy nie pokazuje credentiali agenta —
 * Core zwraca je wyłącznie agentowi przy enroll (protokół §1).
 */
export function PairingDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; token: PairingToken } | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    createPairingToken()
      .then((token) => {
        if (!cancelled) {
          setState({ kind: "ready", token });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "Nie udało się wygenerować tokenu.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function retry(): void {
    setState({ kind: "loading" });
    createPairingToken()
      .then((token) => setState({ kind: "ready", token }))
      .catch((error: unknown) =>
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Nie udało się wygenerować tokenu.",
        }),
      );
  }

  return (
    <Dialog title="Parowanie agenta" onClose={onClose}>
      {state.kind === "loading" ? (
        <p>Generowanie jednorazowego tokenu…</p>
      ) : state.kind === "error" ? (
        <Banner tone="error" actions={<button type="button" className="btn btn--text" onClick={retry}>Ponów</button>}>
          {state.message}
        </Banner>
      ) : (
        <div>
          <p>
            Token jednorazowy, ważny do <strong className="metric-value">{formatDateTime(state.token.expiresAt)}</strong>.
            Po udanym parowaniu token wygasa; nieudana próba go nie zużywa.
          </p>
          <div className="token-box">
            <span className="token-value" aria-label="Token parowania">{state.token.token}</span>
            <CopyButton text={state.token.token} />
          </div>
          <div className="instructions">
            <ol>
              <li>Skopiuj token powyżej.</li>
              <li>Na hoście docelowym (Linux) wklej token do konfiguracji agenta i uruchom enroll.</li>
              <li>Agent pojawi się na liście po pierwszym heartbeacie (ok. 15 s).</li>
            </ol>
            <p className="age-text">
              Tokenu nie wpisuj w adres URL ani nie zapisuj w logach. Credential agenta zobaczy wyłącznie agent —
              ten ekran go nigdy nie wyświetla.
            </p>
          </div>
        </div>
      )}
    </Dialog>
  );
}

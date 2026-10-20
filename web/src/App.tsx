import { useCallback, useEffect, useState } from "react";
import { fetchMe, getAuthStatus, logout } from "./api/client";
import { Icon } from "./components/Icon";
import { BootstrapPage } from "./pages/BootstrapPage";
import { AiSettingsPage } from "./pages/AiSettingsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ServicesPage } from "./pages/ServicesPage";
import { LoginPage } from "./pages/LoginPage";

type Route = "checking" | "bootstrap" | "login" | "app";
type AppView = "status" | "services" | "ai";
export type Theme = "auto" | "light" | "dark";

/** Kolejność przełączania motywu: auto → light → dark → auto. */
const THEME_CYCLE: Theme[] = ["auto", "light", "dark"];

/** Etykieta opisuje DZIAŁANIE przycisku (czyli motyw PO kliknięciu). */
const THEME_ACTION_LABEL: Record<Theme, string> = {
  auto: "Przełącz na motyw automatyczny (wg systemu)",
  light: "Przełącz na motyw jasny",
  dark: "Przełącz na motyw ciemny",
};

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

export function nextTheme(theme: Theme): Theme {
  const idx = THEME_CYCLE.indexOf(theme);
  return THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
}

/** Efektywny motyw przy "auto" — decyduje preferencja systemu (matchMedia). */
function prefersDark(): boolean {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  return mq?.matches ?? false;
}

export function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (next: Theme) => void }): React.JSX.Element {
  // Tylko do wy renderowania w trybie auto: gdy system zmieni zdanie
  // (zmiana preferencji koloru), ikona ma od razu pokazywać efekt.
  const [systemDark, setSystemDark] = useState<boolean>(() => prefersDark());

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) {
      return;
    }
    setSystemDark(mq.matches);
    const handle = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    mq.addEventListener("change", handle);
    return () => mq.removeEventListener("change", handle);
  }, []);

  const next = nextTheme(theme);
  const label = THEME_ACTION_LABEL[next];
  // Ikona zapowiada motyw, który będzie aktywny po kliknięciu; "auto" pokazuje
  // to, co system faktycznie zastosuje. Bez animacji (reduced-motion w app.css).
  const applied = next === "auto" ? (systemDark ? "dark" : "light") : next;
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      title={label}
      onClick={() => onChange(next)}
    >
      <Icon name={applied === "dark" ? "moon" : "sun"} />
    </button>
  );
}

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>("checking");
  const [view, setView] = useState<AppView>("status");
  const [email, setEmail] = useState<string>("");
  const [checkError, setCheckError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("sp-theme");
    return saved === "light" || saved === "dark" ? saved : "auto";
  });

  useEffect(() => {
    applyTheme(theme);
    if (theme === "auto") {
      window.localStorage.removeItem("sp-theme");
    } else {
      window.localStorage.setItem("sp-theme", theme);
    }
  }, [theme]);

  const checkSession = useCallback(async () => {
    setCheckError(null);
    try {
      const status = await getAuthStatus();
      if (!status.initialized) {
        setRoute("bootstrap");
        return;
      }
      try {
        const me = await fetchMe();
        setEmail(me.email);
        setRoute("app");
      } catch {
        setRoute("login");
      }
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "Nie udało się połączyć z Core.");
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  async function handleLogout(): Promise<void> {
    try {
      await logout();
    } finally {
      setEmail("");
      setRoute("login");
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Przejdź do treści</a>
      <header className="top-bar">
        <span className="section-title">wind-up monitor</span>
        <span className="spacer" />
        {route === "app" ? <span className="user-email" title={email}>{email}</span> : null}
        <ThemeToggle theme={theme} onChange={setTheme} />
        {route === "app" ? (
          <button type="button" className="icon-btn" aria-label="Wyloguj" title="Wyloguj" onClick={() => void handleLogout()}>
            <Icon name="logout" />
          </button>
        ) : null}
      </header>

      <div className="app-body">
        <nav className="side-nav" aria-label="Nawigacja główna">
          <span className="brand">
            <Icon name="dashboard" />
            <span className="nav-label-full">wind-up monitor</span>
          </span>
          {route === "app" ? (
            <>
              <button
                type="button"
                className="nav-item"
                aria-current={view === "status" ? "page" : undefined}
                onClick={() => setView("status")}
              >
                <Icon name="dashboard" />
                Status
              </button>
              <button
                type="button"
                className="nav-item"
                aria-current={view === "services" ? "page" : undefined}
                onClick={() => setView("services")}
              >
                <Icon name="server" />
                Usługi
              </button>
              <button
                type="button"
                className="nav-item"
                aria-current={view === "ai" ? "page" : undefined}
                onClick={() => setView("ai")}
              >
                <Icon name="help" />
                AI
              </button>
              {/* Przyszły ekran: pokazany jako nieaktywny podpis, NIE link — brak martwych linków. */}
              <span className="nav-item nav-item--future" aria-disabled="true" title="Dostępne w kolejnym etapie">
                <Icon name="warn" />
                Incydenty <span className="nav-soon-badge">Wkrótce</span>
              </span>
            </>
          ) : (
            <>
              <span className="nav-item" aria-current="page">
                <Icon name="dashboard" />
                Status
              </span>
              {/* Przyszłe ekrany (S2+): pokazane jako nieaktywne podpisy, NIE linki — brak martwych linków w S1. */}
              <span className="nav-item nav-item--future" aria-disabled="true" title="Dostępne w kolejnym etapie">
                <Icon name="help" />
                Kontrole <span className="nav-soon-badge">Wkrótce</span>
              </span>
              <span className="nav-item nav-item--future" aria-disabled="true" title="Dostępne w kolejnym etapie">
                <Icon name="warn" />
                Incydenty <span className="nav-soon-badge">Wkrótce</span>
              </span>
            </>
          )}
        </nav>

        <main id="main" className="main-content" tabIndex={-1}>
          {route === "checking" ? (
            <div className="main-content-inner">
              {checkError ? (
                <div className="card" role="alert">
                  <p>{checkError}</p>
                  <button type="button" className="btn btn--filled" onClick={() => void checkSession()}>
                    Ponów połączenie
                  </button>
                </div>
              ) : (
                <div className="card" aria-label="Łączenie z Core">
                  <div className="skeleton" />
                  <div className="skeleton" />
                </div>
              )}
            </div>
          ) : route === "bootstrap" ? (
            <BootstrapPage onDone={() => void checkSession()} />
          ) : route === "login" ? (
            <LoginPage onDone={(nextEmail) => { setEmail(nextEmail); setRoute("app"); }} />
          ) : view === "services" ? (
            <ServicesPage onSessionExpired={() => { setEmail(""); setRoute("login"); }} />
          ) : view === "ai" ? (
            <AiSettingsPage onSessionExpired={() => { setEmail(""); setRoute("login"); }} />
          ) : (
            <DashboardPage onSessionExpired={() => { setEmail(""); setRoute("login"); }} />
          )}
        </main>
      </div>
    </div>
  );
}

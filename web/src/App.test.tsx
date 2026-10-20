import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, nextTheme } from "./App";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Kontrolowany fake `matchMedia("(prefers-color-scheme: dark)")` dla jsdom. */
function stubMatchMedia(systemDark: boolean) {
  const state = { dark: systemDark };
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mq = {
    get matches(): boolean {
      return state.dark;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    dispatchEvent: (): boolean => true,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mq),
  );
  return {
    setSystemDark(next: boolean): void {
      state.dark = next;
      act(() => {
        listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent));
      });
    },
    listenerCount: (): number => listeners.size,
  };
}

async function renderApp(): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/v1/auth/status") {
        return jsonResponse({ initialized: false });
      }
      return jsonResponse({}, 404);
    }),
  );
  render(<App />);
  // Trasa rozstrzygnięta: bootstrap (fetch auth/status zakończony).
  expect(await screen.findByRole("heading", { name: "Pierwsza konfiguracja" })).toBeInTheDocument();
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("motyw (auto → light → dark)", () => {
  it("nextTheme cykluje auto → light → dark → auto", () => {
    expect(nextTheme("auto")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("auto");
  });

  it("etykieta zawsze opisuje motyw PO kliknięciu (auto ustawia light, nie odwrotnie)", async () => {
    stubMatchMedia(false); // system jasny
    const user = userEvent.setup();
    await renderApp();

    // Regresja F6: przy "auto" była etykieta „ciemny", a klik ustawiał light.
    let toggle = screen.getByRole("button", { name: "Przełącz na motyw jasny" });
    expect(toggle).toHaveAttribute("title", "Przełącz na motyw jasny");

    await user.click(toggle);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("sp-theme")).toBe("light");

    toggle = screen.getByRole("button", { name: "Przełącz na motyw ciemny" });
    await user.click(toggle);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem("sp-theme")).toBe("dark");

    toggle = screen.getByRole("button", { name: "Przełącz na motyw automatyczny (wg systemu)" });
    await user.click(toggle);
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem("sp-theme")).toBeNull();
  });

  it("startuje z zapisanego ciemnego motywu i przechodzi w auto", async () => {
    stubMatchMedia(false);
    window.localStorage.setItem("sp-theme", "dark");
    const user = userEvent.setup();
    await renderApp();

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    const toggle = screen.getByRole("button", { name: "Przełącz na motyw automatyczny (wg systemu)" });
    await user.click(toggle);
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem("sp-theme")).toBeNull();
  });

  it("w stanie dark ikona zapowiada auto i podąża za systemem (matchMedia change)", async () => {
    window.localStorage.setItem("sp-theme", "dark");
    const media = stubMatchMedia(true); // system: ciemny
    const user = userEvent.setup();
    await renderApp();

    // Stan: dark → kolejnym motywem jest auto; ikona pokazuje to, co auto
    // faktycznie zastosuje (system), etykieta opisuje akcję.
    const toggle = screen.getByRole("button", { name: "Przełącz na motyw automatyczny (wg systemu)" });
    expect(media.listenerCount()).toBe(1);
    const iconSystemDark = toggle.innerHTML;

    media.setSystemDark(false);
    expect(toggle.innerHTML).not.toBe(iconSystemDark);
    expect(toggle).toHaveAccessibleName("Przełącz na motyw automatyczny (wg systemu)");

    await user.click(toggle);
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem("sp-theme")).toBeNull();
  });

  it("działa także bez matchMedia (środowisko bez preferencji systemu)", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const user = userEvent.setup();
    await renderApp();

    const toggle = screen.getByRole("button", { name: "Przełącz na motyw jasny" });
    await user.click(toggle);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});

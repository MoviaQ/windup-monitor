import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, Icon, type IconName } from "./Icon";

/** Ścieżka z wieloma podfigurami — sprawdzamy spójność geometrii 24×24. */
function dOf(name: IconName): string {
  const { container } = render(<Icon name={name} />);
  const d = container.querySelector("path")?.getAttribute("d") ?? "";
  expect(d).not.toBe("");
  return d;
}

describe("Icon", () => {
  it("eksportuje komplet nazw i nie duplikuje ich", () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
    expect(ICON_NAMES).toContain("pause");
    expect(ICON_NAMES).toContain("play");
    expect(ICON_NAMES).toHaveLength(17);
  });

  it.each(ICON_NAMES)("ikona %s ma spójny kontur 24×24 w pudełku 20×20", (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("width")).toBe("20");
    expect(svg?.getAttribute("height")).toBe("20");
    expect(svg?.getAttribute("fill")).toBe("none");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.getAttribute("stroke-width")).toBe("2");
    expect(svg?.getAttribute("stroke-linecap")).toBe("round");
    expect(svg?.getAttribute("stroke-linejoin")).toBe("round");
    expect(svg?.classList.contains("sp-icon")).toBe(true);

    const d = container.querySelector("path")?.getAttribute("d") ?? "";
    expect(d).not.toBe("");
    expect(d).not.toMatch(/NaN|undefined/);

    // Stałe pudełko: bez kurczenia się i bez wpływu na wysokość linii.
    const style = svg?.getAttribute("style") ?? "";
    expect(style).toContain("flex-shrink: 0");
    expect(style).toContain("display: block");
  });

  it("domyślnie jest ikoną dekoracyjną (aria-hidden, focusable=false)", () => {
    const { container } = render(<Icon name="check" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(svg?.getAttribute("role")).toBeNull();
    expect(svg?.getAttribute("aria-label")).toBeNull();
  });

  it("z podanym label role=img i aria-label, bez aria-hidden", () => {
    const { container } = render(<Icon name="server" label="Ikona serwera" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Ikona serwera");
    expect(svg?.getAttribute("aria-hidden")).toBeNull();
  });

  it("check to okrąg ze znacznikiem (bez pełnej plamy), warn to trójkąt z wykrzyknikiem", () => {
    const check = dOf("check");
    expect(check).toMatch(/^M12 3a9 9 0 1 0 0 18/); // kontur okręgu, nie wypełnienie
    expect(check).toContain("7.5 12.4"); // osobny podpis "check"

    const warn = dOf("warn");
    expect(warn).toMatch(/H3Z/); // trójkąt domknięty
    expect(warn).toContain("12 17.4h.01"); // kropka wykrzyknika
  });

  it("pause ma dwie pionowe kreski, play domknięty trójkąt", () => {
    const pause = dOf("pause");
    expect(pause.split("M").filter(Boolean)).toHaveLength(2);
    expect(pause).toMatch(/^M9 7v10M15 7v10$/);

    const play = dOf("play");
    expect(play.endsWith("Z")).toBe(true);
    expect(play).toMatch(/^M8\.5 5\.8 18\.4 12 8\.5 18\.2Z$/);
  });

  it("pausa/play nie zmieniają zachowania istniejących nazw", () => {
    for (const name of ICON_NAMES) {
      expect(() => render(<Icon name={name} />)).not.toThrow();
    }
  });
});

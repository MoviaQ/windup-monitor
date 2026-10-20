/* Własny system ikon SVG — kontur 24×24 renderowany w stałym pudełku 20×20.
   Bez fontów ikon i bez zasobów bitmapowych: stroke=currentColor, fill=none,
   strokeWidth=2, zaokrąglone końce/złącza. Wszystkie ikony mają tę samą
   geometrię i grubość konturu, więc wyrównanie w pudełku 20px jest regularne.
   Uwaga: to NASZE ikony (nie oficjalne Material Icons) — tylko styl minimalistyczny. */

export type IconName =
  | "dashboard"
  | "check"
  | "warn"
  | "error"
  | "help"
  | "logout"
  | "add"
  | "refresh"
  | "copy"
  | "close"
  | "sun"
  | "moon"
  | "offline"
  | "server"
  | "revoke"
  | "pause"
  | "play";

export const ICON_NAMES: readonly IconName[] = [
  "dashboard",
  "check",
  "warn",
  "error",
  "help",
  "logout",
  "add",
  "refresh",
  "copy",
  "close",
  "sun",
  "moon",
  "offline",
  "server",
  "revoke",
  "pause",
  "play",
];

/** Kontury w układzie 24×24; środek optyczny (12,12), margines ≥1 na kontur. */
const PATHS: Record<IconName, string> = {
  // Siatka 2×2 (16, 14, 4).
  dashboard: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  // Okrąg + check (nie wypełniona plama).
  check: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM7.5 12.4 10.6 15.5 16.5 9.6",
  // Trójkąt ostrzegawczy + wykrzyknik.
  warn: "M12 4.6 21 20.2H3ZM12 10v4.2M12 17.4h.01",
  // Okrąg + wykrzyknik.
  error: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.4v6.4M12 17.4h.01",
  // Okrąg + znak zapytania.
  help: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.7 10.1a2.6 2.6 0 0 1 4.8 1.4c0 1.8-2.5 1.8-2.5 3M12 17.4h.01",
  // Otwarty frame drzwi + strzałka wyjścia.
  logout: "M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8M9.5 12H20m-3.2-3.2L20 12l-3.2 3.2",
  add: "M12 5v14M5 12h14",
  // Pierścień + grot wskazujący kierunek obrotu.
  refresh: "M12 4.6A7.6 7.6 0 1 1 5.42 15.8M9.4 2.4 12 4.6 9.4 6.8",
  // Dwa nachodzące arkusze (przedni rysowany tylko poza zasłonięciem).
  copy: "M16 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h5M10 10h10v10H10z",
  close: "M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5",
  // Rdzeń + 8 promieni.
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M7.6 7.6 5.9 5.9M16.4 7.6l1.7-1.7M7.6 16.4 5.9 18.1M16.4 16.4l1.7 1.7",
  // Sierp (okrąg 8.5 minus wycięcie 9).
  moon: "M19.04 16.77A8.5 8.5 0 1 1 8.9 4.09A9 9 0 0 0 19.04 16.77Z",
  // Przekreślony okrąg — brak połączenia.
  offline: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.64 18.36 18.36 5.64",
  // Dwa moduły + diody.
  server:
    "M6 4h12a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM6 14h12a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2zM7.5 7h.01M7.5 17h.01",
  // Okrąg + kreska (cofnięcie uprawnień).
  revoke: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12h8",
  // Dwie pionowe kreski.
  pause: "M9 7v10M15 7v10",
  // Trójkąt (optycznie wyśrodkowany w pudełku 24).
  play: "M8.5 5.8 18.4 12 8.5 18.2Z",
};

const SVG_PROPS: React.SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  width: 20,
  height: 20,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "sp-icon",
  // Stałe pudełko: ikona nie kurczy się i nie zmienia wysokości linii tekstu.
  style: { flexShrink: 0, display: "block" },
};

/**
 * Ikona dekoracyjna (domyślnie) albo z etykietą dla czytników ekranu.
 * `label` → role="img" + aria-label; bez `label` → aria-hidden + focusable=false.
 */
export function Icon({ name, label }: { name: IconName; label?: string }): React.JSX.Element {
  const glyph = <path d={PATHS[name]} />;
  if (label) {
    return (
      <svg {...SVG_PROPS} role="img" aria-label={label}>
        {glyph}
      </svg>
    );
  }
  return (
    <svg {...SVG_PROPS} aria-hidden="true" focusable="false">
      {glyph}
    </svg>
  );
}

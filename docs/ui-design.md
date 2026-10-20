# UI Design (Material Design 3)

> Stan wiedzy zweryfikowany: **2026-10-19**. Wszystkie cytaty ze źródeł oficjalnych Google poniżej.
> Powiązane: statusy kanoniczne z [data-model.md](data-model.md) §5 — UI używa dokładnie tych stringów.

## 1. Aktualny stan M3 / M3 Expressive (co jest prawdą w 2026)

- **M3 Expressive to rozszerzenie M3** (nie osobny system): nowe/zaktualizowane komponenty, rozszerzona skala typografii (warianty baseline + emphasized), nowy spring-based motion, biblioteka kształtów. Ogłoszone na I/O 2025, rozwijane na I/O 2026 (system layoutu, listy/menu, spacing 8dp). Źródła: <https://m3.material.io/> , <https://m3.material.io/blog/whats-new-at-io26> (2026-05-19).
- **Web jest w tyle celowo i oficjalnie:** „Material Web Components are currently in maintenance mode. No updates are currently being made to this library. **Material 3 Expressive is not implemented on Web.**" — <https://m3.material.io/develop/web>. Najnowszy release `@material/web` v2.5.0 (opublikowany 2026-07-15, głównie `labs:` utilities Expressive) nie zmienia tego statusu: <https://github.com/material-components/material-web/releases>.
- **MUI ≠ M3.** Tabela wspieranych komponentów MUI wskazuje implementację **MD2** dla komponentów materialowych, a umbrella „Adopt Material Design 3" jest otwarta ze statusem on-hold: <https://mui.com/material-ui/getting-started/supported-components/> , <https://github.com/mui/material-ui/issues/29345>. Wniosek: MUI nie jest drogą do M3.
- **Typografia Expressive na Web niedostępna:** tabela dostępności na <https://m3.material.io/styles/typography> — wiersz „Web: Expressive — Unavailable" (stan: sie 2026).

**Konsekwencja architektoniczna (DEC-UI-01):** Web Windup Monitor implementuje **aktualne wytyczne M3 własną dostępną warstwą komponentów React** (ręczne tokeny CSS: zmienne, light/dark schemes z ról kolorów) i **NIE zależy** od `@material/web` ani MUI. Brak gotowego frameworka Expressive na Web nie blokuje realizacji specyfikacji M3/Expressive we własnym CSS/React — nowe wzorce M3 są dozwolone, o ile realizują tokeny (§3), anatomię/stany/klawiaturę komponentu wg dokumentacji M3 oraz kryteria a11y (§8); rozjazd z bibliotekami Google dokumentujemy w release notes. Dozwolone jest użycie maintained, dostępnych headless primitives (logika focus/ARIA/klawiatury) pod własnymi komponentami, gdy to sensowne — bez wymuszania wielkiego customowego systemu a11y.

## 2. Co bierzemy z M3 (baseline, Web-dostępne)

- **Role kolorów** (primary/secondary/tertiary/neutral/neutral-variant + on-*/container/*): <https://m3.material.io/styles/color/roles>. Schemat statyczny baseline (nie dynamic color — self-host nie ma dostępu do tapety użytkownika; decyzja świadoma).
- **Skala typu**: 5 ról (display/headline/title/body/label) × rozmiary S/M/L — tylko style **baseline** (emphasized/expressive niedostępne na Web). Tokeny jak `--md-sys-typescale-title-large-*`.
- **Kształty**: skala sketch (extra-small…extra-large) + pełne koło; kształt = sygnał semantyczny (karty medium, FAB large, chip small).
- **Stany interakcji**: state layers (hover 8%, focus 12%, pressed 12% — wartości M3) realizowane overlayem, nie podmianą koloru.
- **Nawigacja responsywna**: bar (compact) → rail (medium) → drawer (expanded) — wg breakpointów M3/layout I/O 2026.
- **Dostępność z fundamentów**: <https://m3.material.io/foundations> — kontrast, cele dotykowe 48dp, focus widoczny.

## 3. Tokeny (kontrakt z kodem)

```css
:root {
  --md-sys-color-primary: #…;        /* + on-primary, primary-container… */
  --md-sys-color-surface: #…;        /* + on-surface, surface-variant, outline */
  --md-sys-color-error: #…;          /* + on-error, error-container */
  --md-sys-typescale-body-large-size: 1rem; /* …line-height, tracking, weight */
  --md-sys-shape-corner-medium: 12px;
  --sp-spacing-1: 8px;               /* baza 8dp, system spacing I/O 2026 */
}
```

Jeden plik `tokens.css` (+ `tokens-dark.css` przez `prefers-color-scheme` i przełącznik). Komponenty odwołują się WYŁĄCZNIE do tokenów — hex poza tokenami zakazany (reguła review).

## 4. Kolory statusów: status NIGDY nie tylko kolorem

Mapowanie (te same nazwy co w data-model §5):

| Stan | Kolor (rola) | + kształt/ikona/tekst (redundancja) |
|---|---|---|
| `online` / `ok` / `resolved` / `succeeded` | primary lub zielony rozszerzony* | ikona `check_circle` + etykieta tekstowa |
| `stale` / `acknowledged` | tertiary/amber* | ikona `schedule`/`warning` + wiek danych („2 min temu") |
| `offline` / `down` / `open` / `failed` | error | ikona `error` + etykieta |
| `unknown` / `pending` / `expired` / `rejected` / `cancelled` | outline/surface-variant | ikona `help`/`hourglass` + etykieta, nigdy sam szary kolor |

(`degraded` zarezerwowane na future — MVP go nie używa; data-model §5. Kryteria anatomii/stanów/klawiatury dla komponentów statusu weryfikowane są przy implementacji, nie na podstawie tego dokumentu.)

\* M3 nie definiuje semantycznych „success/warning" — bierzemy je z palety rozszerzonej M3 (custom colors / tonal palettes), udokumentowane w tokenach jako `--sp-status-ok/*-warn`. Kontrast min. 4.5:1 dla tekstu statusu. Kropka statusu zawsze z etykietą tekstową obok (a11y + daltonizm).

## 5. Typografia i fonty (self-host, zero CDN)

- Font: Roboto Flex (lub Roboto) + Roboto Mono do liczb/logów — pakiety `@fontsource-variable/*`, bundlowane przez Vite (brak Google Fonts CDN w runtime — wymóg offline/PWA).
- Ikony: **Material Symbols** (aktualny zestaw, nie legacy Material Icons), self-host przez Fontsource (`@fontsource-variable/material-symbols-rounded`), osie `FILL/wght/GRAD/opsz`, licencja Apache-2.0. Źródło: <https://developers.google.com/fonts/docs/material_symbols>. Używać ligatur (`home`, `error`) z fallbackiem `aria-label`; `font-display: block`.
- Liczby metryk: wariant tabular (font-feature `tnum`), jednostki zawsze widoczne.

## 6. Nawigacja responsywna i ekrany

- **Compact (<600dp):** navigation bar (4 destynacje: Status, Checks, Incidents, Settings) + FAB „Acknowledge"? — NIE, brak globalnego FAB (akcje tylko kontekstowe; mniej pomyłek).
- **Medium:** navigation rail. **Expanded:** navigation drawer.
- Ekrany: `Status` (lista agentów: status + wiek danych + mini-wykres), `Agent detail` (metryki, Docker, historia), `Checks`, `Incidents` (open→ack→resolved), `Commands/Audit` (kolejka + dziennik), `Settings` (pairing, rotacja, retencja, backup info).
- Stany każdego ekranu: `loading (skeleton) / data / stale (banner „dane sprzed X") / offline (read-only cache) / empty / error`. Nigdy pusty spinner bez limitu czasu (timeout 10 s → error + retry).

## 7. PWA i offline (MVP: app-shell only)

- `manifest.webmanifest` (name, short_name, `display: standalone`, theme_color z tokenu primary, ikony PNG 192/512 + maskable; SVG maskable opcjonalnie).
- Service worker (MVP): **wyłącznie app-shell cache** (HTML/CSS/JS/fonty). Brak cache'owania odpowiedzi API w MVP (prostszy model bezpieczeństwa: brak ryzyka wycieku danych uwierzytelnionych do cache; uwierzytelniony cache GET wymagałby scopingu per użytkownik/sesja i czyszczenia przy logout/revokacji — odłożone na future).
- Offline = tryb **read-only**: widoczny banner; ostatnie znane dane wyłącznie z otwartej sesji (in-memory), bez serwowania danych z cache SW; akcje (restart/ack) WYŁĄCZONE z wyjaśnieniem (nie kolejkowane — brak „czekających restartów", które odpalą po tygodniu). NIGDY w żadnym storage SW: session cookie, enroll tokeny, credentiale, kolejka komend, wyniki mutacji.
- Powiadomienia: Web Push/Notification API — zależne od platformy i lokalnego wdrożenia (iOS standalone ograniczenia, brak VAPID bez serwera push — MVP: tylko powiadomienia in-app + (opcjonalnie) webhook; push jako epik future). Nie obiecywać w UI tego, czego platforma nie daje.

## 8. Dostępność (a11y)

- Focus ring zawsze widoczny (token outline), kolejność tabulacji = kolejność wizualna, drawer/bar z `nav` + `aria-current`.
- Kontrast tekstu 4.5:1 / dużego 3:1; statusy redundantne (§4); wykresy z tabelą alternatywną (details/summary).
- Ruch: `prefers-reduced-motion` wyłącza sprężyste animacje; brak animacji zapętlonych poza progress (i te z pauzą).

## 9. Rozjazd z bibliotekami Web (udokumentowany, bez sztucznego zakazu)

Brak gotowej implementacji Web danego wzorca Expressive (np. shape-morph na komponentach krytycznych, waveform progress, button groups „bump", toolbar+split-button) nie blokuje jego implementacji — każdy nowy wzorzec M3/Expressive wymaga: tokenów (§3), anatomii + stanów (hover/focus/pressed/disabled) + obsługi klawiatury wg dokumentacji M3 oraz kryteriów §8; zgodność weryfikuje wizualne review desktop/mobile przy implementacji (kanban SP-104/SP-501), nie ten dokument. Rozjazd z Compose/bibliotekami dokumentujemy w release notes, zamiast udawać kompletność.

## 10. Otwarte decyzje

| ID | Pytanie | Rekomendowany default |
|---|---|---|
| DEC-UI-01 | Baza komponentów | ręczne tokeny + własne lekkie komponenty React (bez MUI/@material/web); dozwolone maintained headless primitives dla a11y/klawiatury |
| DEC-UI-02 | Dynamic color | NIE (produkt self-host, statyczny baseline + dark) |
| DEC-UI-03 | Powiadomienia push w MVP | NIE (in-app + webhook opcjonalnie) |
| DEC-UI-04 | Paleta brandowa (2026-10-19, życzenie użytkownika) | Neutralna: light = białe surfaces, dark = grafitowo-czarne surfaces, brand/primary = GRANAT (`#1a365d` light / `#a9c1e8` dark); zero różu/fioletu w primary/secondary/tertiary (tertiary = neutralny slate). Semantyka bez zmian: error czerwony, warn dyskretny amber, success zielony — tylko statusy, nie brand. Tryb `auto` (wg systemu) ZOSTAJE — użytkownik nie nakazał white-only, oba motywy spójne. Kontrasty tekstu ≥7:1 (wymóg 4.5:1 z zapasem). |

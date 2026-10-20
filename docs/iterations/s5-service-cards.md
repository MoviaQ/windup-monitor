# Iteracja S5 — Karty Usług: publiczny status bez rozwijania (2026-10-20)

Zakres: rutynowy UI kart ekranu **Usługi** + drobna optymalizacja odczytu
(publiczne URL-e). Bez redesignu strony, bez zmian backendu, bez zmian
hosta/włączania/wstrzymywania usług (`SP-808`, `kanban.md`).

## 1. Układ karty

**Zwinięta karta pokazuje** (bez klikania „Szczegóły"):

- nazwa + host,
- status lokalny (`ServiceStatusBadge`),
- **status publicznego URL** — `PublicStatusSummary`:
  - agregat `Adres publiczny: …` (najgorszy stan wygrywa: `nie odpowiada` →
    `jeszcze nie sprawdzono` → `sprawdzanie wstrzymane` → `wymaga logowania`
    → `przekierowanie` → `odpowiada`),
  - przy >1 adresie dodatkowo odznaka każdego adresu (`etykieta: status`) —
    awaria jednego adresu nigdy nie chowa się za drugim,
  - brak adresów → subtelne `Adres publiczny: nie dodano`,
  - ładowanie/błąd → neutralne (`sprawdzanie…` / `stan nieznany`), nigdy zielone,
  - wstrzymanie osobno (ikona pause), 3xx = „Przekierowanie", 401/403 =
    „wymaga logowania" (nie fake health),
  - tooltip: „Sprawdzane z serwera wind-up monitor, bez zewnętrznego punktu
    pomiarowego" (vantage Core, nie „internet everywhere"), bez linków i bez
    wywoływania zapytań/sekretów w UI,
- dostępność (24 h), CPU procesu, RAM procesu,
- komunikaty statusu (pierwszy pomiar/unknown/degraded/down) + akcje.

**Pod „Szczegóły" schowane** (dane zachowane, nie usunięte): port, ścieżka,
oczekiwane kody HTTP, opóźnienie + ostatni kod, dokładne daty (`upSince`,
restart procesu, start procesu), rozbicie dostępności observed/unknown,
historia (wykres opóźnień + oś czasu) oraz CRuD publicznych URL-i.

## 2. Pobieranie danych (bez N+1 co 15 s)

- Podsumowanie publiczne trzyma `ServicesPage` (jeden spójny stan
  `publicSummaries`), nie każda karta osobno.
- Ładowanie **automatycznie przy montażu** (czyli także dla zwiniętej karty),
  `mapLimit(…, 4)` — bounded parallel, dedupe „in-flight" dla auto-odświeżeń.
- Odświeżanie: co 15 s sprawdzenie wieku wpisu, odświeżenie nie częściej niż
  **45 s na usługę** i tylko gdy karta jest widoczna (`visibilityState`).
- Rozwinięcie „Szczegółów" **nie wywołuje drugiego requesta** (osobny fetch
  tylko dla historii).
- CRuD (dodaj/edytuj/wstrzymij/usuń) → `onChanged` → wymuszone odświeżenie
  jednej usługi (stan widoczny od razu).
- Zachowane reguły MED: stan publiczny **niezależny** od stanu historii,
  401 → `onSessionExpired`, inny błąd → jawny komunikat + „Ponów", błąd
  **nie udaje** pustej listy (`[]` to tylko prawdziwy pusty wynik).
- Backend bez zmian — istniejący `GET /api/v1/services/:id/public-endpoints`
  wystarcza dla małej liczby usług (żadnego nowego endpointu).

## 3. Zmienione pliki

- `web/src/pages/ServicesPage.tsx` — układ karty, stan publiczny strony,
  `AvailabilitySummary` (collapsed) obok `AvailabilityNote` (details),
  teksty display `StatusPilot` → `wind-up monitor` w edytowanych plikach.
- `web/src/pages/ServicesPage.test.tsx` — 2 testy zaktualizowane pod układ
  (daty pod „Szczegóły"), 4 nowe (publiczny status na zwiniętej karcie,
  awaria nie ukryta za agregatem, CRuD bez dublowania requestów, błąd →
  neutralny stan).
- `web/src/public-endpoints/PublicEndpoints.tsx` — `PublicSummaryState`,
  `publicEndpointShortName`, `publicEndpointBadge`, `aggregatePublicStatus`,
  `PublicStatusSummary`; brand display.
- `web/src/public-endpoints/PublicEndpoints.test.tsx` — 5 nowych testów
  agregatu/renderu.
- `web/src/services.css`, `web/src/public-endpoints/public-endpoints.css` —
  tylko klasy `.svc-public` i `.pe-summary-badges` (tokeny M3, zawijanie na
  mobile).
- `web/src/public-endpoints/api.ts` — komentarz nagłówkowy (brand).

## 4. Checks

- `npm run lint --workspace web` — zielone (`--max-warnings=0`).
- `npm run typecheck --workspace web` — zielone.
- `npm run test --workspace web` — **124/124** (było 115; +9).
- `npm run build --workspace web` — OK (`index-CPNIysux.js`).
- Nie uruchamiano ponownie pełnego Core/Go/Docker (poza buildem web i
  restartem własnego Core).

## 5. Live

- Restart **wyłącznie własnego** Core: `kill <pid>` + `.tmp/review/start-core.sh`
  (ten sam env: `SESSION_SECRET`/`COOKIE_SECURE`/`ALLOWED_ORIGINS`/Tailscale),
  bez dotykania T3/Jellyfin/Postgres/agent-`agent-state`.
- `https://minipclaw.tail8bb992.ts.net:18443/` → 200 (root i `/api/v1/health/ready`),
  serwowany nowy bundle.
- Weryfikacja browser: T3 `preview_status` → `preview_open` zablokowane
  przez AppArmor (explicit: „This host blocks the sandbox T3's browser runs
  in") → fallback na **cached Playwright Chromium** (bez pobierania).
- Zrzuty: `.tmp/review/s5-cards-desktop.png`, `.tmp/review/s5-cards-mobile.png`,
  `.tmp/review/s5-details-desktop.png`, `.tmp/review/s5-details-mobile.png`
  (skrypt `.tmp/review/s5-cards.mjs`, credentiale scrubowane).

Wynik (desktop 1440 / mobile 390, identyczny w obu):

| Sprawdzenie | Wynik |
|---|---|
| Jellyfin: `Adres publiczny: odpowiada` bez rozwijania | ✓ (obie szerokości) |
| Karty bez URL-i: subtelne `Adres publiczny: nie dodano` | ✓ (T3 Code, Status pilot) |
| CPU/RAM/dostępność na zwiniętej karcie | ✓ |
| Dane techniczne (port/ścieżka/kody/daty) na zwiniętej karcie | brak ✓ |
| Wyższa karta po rozwinięciu | 348 → 1350 px, 396 → 1470 px ✓ |
| Szczegóły: port, kody, `upSince`, historia, CRuD („Dodaj publiczny URL") | ✓ |
| `aria-expanded` na „Szczegóły" | `true` po rozwinięciu ✓ |
| „Dane odświeżają się co 15 sekund" | ✓ |
| Overflow poziomy / `pageerror` | brak / brak ✓ |

## 6. Ograniczenia

- Brak nowego endpointu batch (nie był potrzebny przy 3 usługach); przy
  kilkudziesięciu usługach warto rozważyć `GET /api/v1/public-endpoints`.
- Podsumowanie odświeża się co ≤45 s (sondy i tak mają interwał ≥15 s), nie
  w każdym tyku 15 s — to celowe ograniczenie ruchu.
- Jednorundowa weryfikacja własna (niezależne review nie było zamawiane).
- Brak commit/push — zmiany w working tree do publikacji przez ownera.

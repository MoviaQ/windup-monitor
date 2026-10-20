# Windup Monitor Web (S1)

Responsywny dashboard Material 3: bootstrap single-user, logowanie, parowanie agenta (one-time token),
lista agentów online/stale/offline z wiekiem danych, metryki CPU/RAM/dysk/sieć/uptime + historia z tabelą alternatywną.

## Wymagania

- Node.js 22+, uruchomiony Core na `http://localhost:8080` (Vite proxy `/api` → Core).

## Komendy

- `npm run dev` — serwer deweloperski (nasłuch `0.0.0.0:5173`, proxy `/api` → `localhost:8080`).
- `npm run build` — typecheck + build produkcyjny do `dist/` (serwowany przez Core).
- `npm run preview` — podgląd buildu (`0.0.0.0:4173`).
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — testy komponentów (vitest).
- `npm run lint` — eslint.

## Zakres S1 (celowo brak)

Brak ekranów Kontrole/Incydenty/Komendy (nawigacja pokazuje je jako „Wkrótce", bez martwych linków),
brak próbkowych/fikcyjnych hostów, brak Service Workera i instalacji PWA (etap S5), brak telemetrii.

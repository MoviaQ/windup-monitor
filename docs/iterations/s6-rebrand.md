# Iteracja S6 — rebranding: Windup Monitor / wind-up monitor (2026-10-20)

Status: **wdrożone lokalnie i zweryfikowane live**. Zakres wyłącznie
nazewnictwo/tożsamość produktu; bez zmian funkcji, danych, historii, sesji,
sekretów, auth i health. Bez commitów, pushy i remote.

## Nazwy kanoniczne

| Warstwa | Wartość |
|---|---|
| Projekt / README / tytuł w T3 | **Windup Monitor** |
| Repozytorium, katalog, slug pakietu | `windup-monitor` |
| Nazwa aplikacji w UI i `<title>` | **`wind-up monitor`** (dokładnie, lowercase + hyphen) |
| Pakiety npm | `windup-monitor`, `@windup-monitor/core`, `@windup-monitor/web` |
| Moduł Go / binarka / CLI | `windup-monitor/agent`, `windup-monitor-agent` |

## Co zmieniono

- **Web/UI:** top bar i nawigacja, ekran logowania, pierwsza konfiguracja,
  panel AI („Tylko ta aplikacja (wind-up monitor)”), `index.html`
  (`<title>`, meta description), komentarze modułów. Bez zmian układu kart
  ani logiki — brand to conditionowana podmiana copy.
- **Pakiety/workspace:** nazwy root/core/web + `package-lock.json`; linki
  workspace `node_modules/@windup-monitor/{core,web}`; skrypty root
  `agent:{build,test,vet}` naprawione na uruchamianie wewnątrz `agent/`
  (wcześniej `go ... ./agent/...` z rootu nie miało modułu).
- **Agent Go:** moduł i importy `windup-monitor/agent/...`, katalog
  `cmd/windup-monitor-agent`, UA `windup-monitor-agent/<ver>`, komunikat
  `--help`, unit `systemd/windup-monitor-agent.service`, domyślny
  `--state-dir /var/lib/windup-monitor`. Nowy prefix env `WINDUP_MONITOR_*`;
  legacy `STATUSPILOT_*` nadal czytany (nowy ma pierwszeństwo).
- **Core:** nazwy pakietu, log-tagi `[windup-monitor]`, komunikat startu,
  domyślny `AI_CHATGPT_AGENT_NAME` = `wind-up monitor`, tekst pomocy
  callbacku ChatGPT. Bez zmian API, cookie, CSRF i schematu DB.
- **Dokumentacja/deploy/CI:** README, CONTRIBUTING, SECURITY, architektura,
  storage, protokół agenta, ChatGPT setup, UI design, etykiety Compose,
  binarki w CI. Historyczne iteracje S1–S4 mają jawną adnotację, że to
  dokumenty archiwalne.
- **Repozytorium:** katalog `.../projects/windup-pilot` → `.../windup-monitor`
  (atomic `mv` w tym samym FS, to samo `.git`, ten sam inode); stara ścieżka
  pozostaje symlinkiem zgodności do nowej. Projekt T3 (`6578ccf8-…`) ma
  title **Windup Monitor** i `workspaceRoot` na nowej ścieżce.

## Zachowana zgodność (bez resetu DB)

- PostgreSQL: baza `statuspilot_review`, role `statuspilot`,
  `statuspilot_app`, kontener dev `statuspilot-test-pg` — bez zmian.
- Cookie sesji (`__Host-sp_session` / `sp_session`), CSRF, format
  `credential.json`, `seq`, `state.json`, `outbox/`, journal — bez zmian.
- Legacy env `STATUSPILOT_*` i stara ścieżka repo/agent state działają;
  istniejący agent nie wymaga ponownego parowania.
- URL-e runtime bez zmian: `https://minipclaw.tail8bb992.ts.net:18443/`,
  Core `127.0.0.1:18080`, publiczny Jellyfin `https://filmy.moviak.quest/`.

## Weryfikacja

- Web: `npm run lint/typecheck/test/build --workspace web` → **13 plików /
  115 testów PASS**, build Vite OK.
- Core: `lint`, `typecheck`, `build` PASS; targeted `chatgpt.test.ts` +
  `web-static.test.ts` na izolowanej bazie `windup_monitor_brand_test`
  (utworzona i usunięta po przebiegu) → **34/34 PASS**.
- Go: `go vet ./...`, `go test ./...` w `agent/` → **10 pakietów PASS**;
  build `agent/bin/windup-monitor-agent` OK (skrypt rootowy).
- Live: `GET /api/v1/health` i `/health/ready` → **200**; po kontrolowanym
  restarcie review Core (PID 3877053, cwd nowej ścieżki, stabilny
  `SESSION_SECRET`) SPA serwuje nowe assety (`<title>wind-up monitor`).
  Restart był potrzebny, by wyczyścić eskalowany in-memory limiter logowania
  po powtarzanych próbach wizualnych i załadować nowy `core/dist`; nie dotknął
  agenta, Postgresa ani innych usług.
- Login/sesja: te same dane z `.tmp/s1-review-access.json` → `POST
  /api/v1/auth/login` **200**, `GET /api/v1/auth/me` **200** i zgodny e-mail;
  następnie login w obu kontekstach przeglądarki.
- Browser (headless Chromium, 1440×900 i 390×844): desktop i mobile pokazują
  `wind-up monitor` w top barze i nawigacji, `<title>` = `wind-up monitor`,
  login tymi samymi danymi review działa, agent `review-demo` = **online**,
  brak poziomego overflow, brak starej nazwy w treści; zrzuty:
  `.tmp/review/rebrand-{login,dashboard,services}-{desktop,mobile}.png`.
- Repo: `git rev-parse --show-toplevel` = nowa ścieżka, `.git/HEAD` intact,
  status pracy zachowany; brak remote (nic nie zmieniano/nie utworzono).

## Ograniczenia / świadome decyzje

- Nie zmieniano identyfikatorów DB, cookie, CSRF, stanu agenta ani ścieżek
  sekretów runtime — to zgodność, nie dług brandowy.
- Kontener/użytkownik OS w obrazie Core zachowuje nazwę `statuspilot`
  (właściciel wolumenów); to wewnętrzny identyfikator, nie nazwa produktu.
- Historyczne nazwy w `docs/iterations/s1–s4` i wierszach kanbanu to zapis
  zdarzeń; mają adnotację archiwalną.
- Restart Core był wykonany świadomie po weryfikacji (PID 3877053,
  cwd nowej ścieżki): nowy SPA działał już wcześniej dzięki
  `@fastify/static`, a restart wyczyścił eskalowany limiter logowania po
  powtarzanych próbach wizualnych i załadował nowe stringi Core.
  Szczegóły i kolejność pracy z taskiem kart: `.tmp/rebrand-handoff.md`.
- Brak zdalnego repo/PR — nie było `origin`; nie tworzono nowego.

<img src="assets/icon.svg" width="64" height="64" alt="">

# Windup Monitor

**Status: S1 + iteracja usług wdrożone lokalnie.** Auth/bootstrap, pairing,
metryki hosta, automatyczne discovery i zatwierdzane sondy HTTP → PostgreSQL
→ dashboard oraz historia minimalnych incydentów. Iteracja usług czeka na
niezależne review; pełne recovery, AI i PWA service worker pozostają przyszłe.

Self-hosted monitoring z deterministycznym recovery (docelowo) — bez kont
zewnętrznych, abonamentów i telemetrii wychodzącej. Wszystko działa u
użytkownika; dane zostają w jego PostgreSQL.

- **Core** — TypeScript / Node 22, Fastify 5, Prisma 7 (PostgreSQL 16), serwuje API i SPA z tego samego origin.
- **Agent** — Go, outbound-only, bez nasłuchu na porcie; zbiera CPU/RAM/dysk/sieć/uptime, wykrywa lokalne listenery i wykonuje zatwierdzone sondy HTTP.
- **Web** — React + Vite + TypeScript, Material 3 (własne tokeny CSS).

Nazwa wyświetlana aplikacji to **wind-up monitor** (UI, tytuł dokumentu w
przeglądarce), projekt i repozytorium to **Windup Monitor**, a slug pakietu
to `windup-monitor`. Historyczne nazwy techniczne PostgreSQL (`statuspilot`,
`statuspilot_review`), cookie sesji i zmienne legacy `STATUSPILOT_*` pozostają
obsługiwane dla zgodności istniejących instalacji — bez resetu bazy.

## Co działa w S1

| Obszar | Zakres |
|---|---|
| Auth | bootstrap jednorazowy (token 0600), login, sesja cookie `HttpOnly`/`SameSite=Lax`/`Secure` (prod), CSRF + Origin, rate-limity, argon2id |
| Pairing | jednorazowy token enrollmentu (TTL 15 min), credential pokazywany raz, w DB tylko hash argon2id, plik agenta 0600 |
| Ingest | heartbeat v1 (snake_case), `seq` + idempotencja, transakcja `ReadCommitted` + `SELECT … FOR UPDATE`, brak nadpisywania nowszego starszym, `late` > 10 min, CONFIG_STALE |
| Dashboard API | `GET /agents`, `GET /agents/:id/metrics` (bounded), `POST /agents/pairing-tokens`, `POST /agents/:id/revoke` |
| Rotacja (SP-105) | dual-accept w oknie overlap, idempotentny retry, `ROTATION_CONFLICT`, lazy promocja po deadline, revoke czyści oba sekrety |
| Health | `/api/v1/health` (liveness), `/api/v1/health/ready` (sprawdza DB) |
| Logi | pino z redakcją `password`/`token`/`cookie`/`Authorization`/`credential` |
| AI (fundamenty) | konfiguracja AI per user + połączenia (OpenRouter/OpenAI/custom OpenAI-compatible/ChatGPT SIWC), sekrety AES-GCM (`AI_CREDENTIAL_KEY`), test połączeń bez inferencji, panel zużycia app-side; tryby pracy zapisywane (DEFAULT `approval_required`) — bez inferencji i działań agenta; kontrakt: [`docs/ai-integration-contract.md`](docs/ai-integration-contract.md) |

Kontrakt API (w tym rozstrzygnięcia i dodatki S1): [`core/CONTRACT.md`](core/CONTRACT.md).
Protokół agenta: [`docs/agent-protocol.md`](docs/agent-protocol.md).

## Wymagania

- Node.js ≥ 22 i npm ≥ 10
- PostgreSQL 16 (lokalnie przez Docker albo natywnie)
- Go ≥ 1.22 (tylko dla agenta)
- Opcjonalnie Docker + Compose (wdrożenie produkcyjne)

## Szybki start lokalnie (dev)

```sh
# 1. Zależności (npm workspaces: core + web)
npm ci

# 2. Baza (Docker, bez compose) — wypisze gotowy DATABASE_URL
./scripts/dev-db.sh
export DATABASE_URL='postgresql://statuspilot:statuspilot@127.0.0.1:55432/statuspilot?schema=public'

# 3. Konfiguracja Core (dev: SESSION_SECRET może pozostać pusty — sesje
#    przestają działać po restarcie; w produkcji jest wymagany)
cp core/.env.example core/.env
#    AI: ustaw AI_CREDENTIAL_KEY (np. openssl rand -base64 48), jeśli chcesz
#    zapisywać klucze dostawców; bez niego odczyt ustawień AI działa, a zapis
#    sekretu zwraca AI_CREDENTIAL_KEY_MISSING.

# 4. Migracje
npm run migrate:deploy --workspace core

# 5. Uruchomienie (dwa terminale)
npm run dev --workspace core     # API na http://127.0.0.1:8080
npm run dev --workspace web      # SPA na http://localhost:5173 (proxy /api → 8080)
```

Otwórz <http://localhost:5173>. Token bootstrapu pierwszego startu jest w
pliku `core/data/bootstrap-token`:

```sh
cat core/data/bootstrap-token
```

Wklej token w UI, ustaw hasło (min. 12 znaków). Potem w UI utwórz token
pairingu i uruchom agenta:

```sh
cd agent
go build -o windup-monitor-agent ./cmd/windup-monitor-agent
export WINDUP_MONITOR_ENROLL_TOKEN="<token z UI>"

./windup-monitor-agent enroll --core-url http://127.0.0.1:8080 --allow-insecure-http --state-dir ~/.local/share/windup-monitor
./windup-monitor-agent run    --core-url http://127.0.0.1:8080 --allow-insecure-http --state-dir ~/.local/share/windup-monitor
```

Dashboard pokaże agenta jako `online` i metryki CPU/RAM/dysk/sieć/uptime.
Szczegóły agenta (flagi, systemd, rotacja): [`agent/README.md`](agent/README.md).

## Wdrożenie produkcyjne (Compose)

```sh
cp deploy/.env.example deploy/.env
# Ustaw POSTGRES_PASSWORD i SESSION_SECRET:
#   openssl rand -base64 48

docker compose -f deploy/docker-compose.yml up -d --build
# (na hoście bez wtyczki compose: docker-compose -f deploy/docker-compose.yml up -d --build)
docker compose -f deploy/docker-compose.yml ps
curl -fsS http://127.0.0.1:8080/api/v1/health/ready
```

> Weryfikacja lokalna 2026-10-19: produkcyjny obraz `83ec6310bf57`
> zbudowany i uruchomiony w izolowanym stacku. Readiness/PostgreSQL,
> natywny Argon2, sesja/CSRF, API usług i assety SPA przeszły smoke;
> kontener healthy, bez restartów. Docker root i cache projektu są na
> `/mnt/ai_data` (osobny dysk od małego `/`). Zdalnego CI nie uruchamiano.
> Dowody i ograniczenia: `docs/iterations/s2.md`.

# Token bootstrapu (plik 0600 w wolumenie core-data):
```sh
docker compose -f deploy/docker-compose.yml exec core cat /app/core/data/bootstrap-token
```

Compose wystawia Core tylko na loopback (`127.0.0.1:8080`) — zgodnie z
`docs/security.md`. Obraz buduje SPA i serwuje je z Core (jeden origin), działa
jako użytkownik non-root, uruchamia `prisma migrate deploy` przy starcie i ma
healthcheck. **Core nigdy nie montuje `docker.sock`** — agent instalujesz na
monitorowanym hoście (binarka + systemd).

### TLS lokalnie / reverse proxy

Opcjonalny profil Caddy (automatyczny certyfikat dla `SP_DOMAIN`):

```sh
SP_DOMAIN=status.example.com \
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.tls.yml up -d --build
```

Przykład reverse proxy: [`deploy/examples/Caddyfile`](deploy/examples/Caddyfile).
Przy dostępie przez proxy ustaw `TRUST_PROXY=true` i `COOKIE_SECURE=true`
(domyślne w `deploy/.env.example`). Dla własnego reverse proxy ustaw
`ALLOWED_ORIGINS` na publiczny origin, jeśli różni się od nagłówka `Host`.

### Dostęp w tailnecie (Tailscale serve) — szablon

Zamiast publicznego wystawienia można udostępnić Core **wyłącznie wewnątrz
własnego tailnetu** (bez Funnel, bez zmian ACL), osobnym portem HTTPS, żeby nie
kolidować z istniejącymi endpointami:

```sh
# osobny wolny port HTTPS -> Core na loopback (nie nadpisuje innego serwisu)
tailscale serve --bg --https=<PORT> http://127.0.0.1:<CORE_PORT>

# zatrzymanie tylko tego endpointu
tailscale serve --https=<PORT> off
```

Przy takim proxy ustaw `COOKIE_SECURE=true`, `TRUST_PROXY=true` i dopisz origin
do `ALLOWED_ORIGINS`, np. `ALLOWED_ORIGINS=https://<node>.<tailnet>.ts.net:<PORT>`
(fallback `…==18080` lokalnie). Sesja używa wtedy cookie `__Host-sp_session`
z `Secure`; CSRF i kontrola `Origin` działają bez osłabienia. Certyfikaty
`*.ts.net` pochodzą od Let's Encrypt, więc przeglądarka ufa im bez dodatkowej
instalacji CA. Dokładny przebieg lokalnego wdrożenia (bez sekretów i bez
prywatnych URL-i): `.tmp/tailscale-access.md`.


### Backup / restore

```sh
docker compose -f deploy/docker-compose.yml exec -T db \
  pg_dump -U statuspilot statuspilot > statuspilot-$(date +%F).sql

# restore do świeżej bazy:
cat statuspilot-2026-10-19.sql | docker compose -f deploy/docker-compose.yml exec -T db \
  psql -U statuspilot -d statuspilot
```

Backup `.env` trzymaj osobno z uprawnieniami `0600` (zawiera `SESSION_SECRET`).
Hasła są w DB jako hashe argon2id — dump ich nie ujawnia.

### Odzyskanie sekretu bootstrapu

Dopóki instancja nie jest zainicjalizowana, token można wygenerować ponownie
(stary przestaje działać):

```sh
# dev
npm run bootstrap:recover --workspace core

# Compose
docker compose -f deploy/docker-compose.yml exec core node dist/cli/recover-bootstrap.js
```

Po ustawieniu hasła bootstrap jest **trwale zamknięty** (`bootstrap_state.used_at`).
Fizyczna utrata pliku z tokenem przed inicjalizacją nie blokuje — komenda
tworzy nowy. Reset hasła bez tokenu (CLI `reset-password`) należy do S6/SP-600.

## Testy i weryfikacja

Komendy rootowe obejmują **core i web** (po poprawce toolingu S1):

```sh
export DATABASE_URL='postgresql://statuspilot:statuspilot@127.0.0.1:55432/statuspilot?schema=public'
npm run lint        # eslint core + web
npm run typecheck   # tsc core + web
npm run build       # build core + web (dist serwowane przez Core)
npm run test        # vitest core (prawdziwy PostgreSQL) + web
```

Wynik lokalny (2026-10-19): **core 7 plików / 52 testy**, **web 7 plików /
31 testów** — wszystko zielone, w tym dwa równoległe pełne przebiegi core
na dwóch bazach (harness z unikalnym tmp per proces — współbieżne suity
nie współdzielą pliku bootstrap-token). Agent: `go vet ./...`,
`go test ./...` w `agent/` (stdlib only, testy parsowania `/proc`,
auth/nagłówków, rotacji). Root ma własny `devDependencies.jsdom`, żeby
hoistowany do rootu `vitest` znajdował środowisko jsdom webu po czystym
`npm ci` (bez ręcznych symlinków).

End-to-end prawdziwą binarką Go (bez mocków ingestu, izolowana DB
`statuspilot_e2e` na porcie 18081 — nie rusza dev ani review):

```sh
npm run test:e2e     # buduje core+web+binarkę Go, stawia Core (prod dist),
                     # enroll binarką → ciągłe heartbeaty → DB → dashboard API
```

Wynik lokalny (2026-10-19): **24/24 kroków** — enroll binarką Go, ciągłe
heartbeaty → wiersze `metric_samples` w PostgreSQL → dashboard API `online`
z metrykami, restart agenta z persistent `seq` (bez `STALE_SEQ`), duplikat
koperty → `409 STALE_SEQ` bez nowego wiersza, zły Bearer/nieznany agent →
`401`, brak CSRF/obcy Origin → `403`, revoke → `AGENT_REVOKED` + `revoked`
w dashboardzie, SPA z Core, logout, grep po pełnych logach Core/agenta —
brak sekretów. Stale/offline bez czekania: manipulacja
`last_seen_at` w DB (core `status.test.ts`), bez 5-minutowych sleepów.
Dowód i pełne logi: [`docs/iterations/s1.md`](docs/iterations/s1.md).

Smoke end-to-end (prawdziwe HTTP przeciw świeżej instancji, syntetyczne
koperty — szybka alternatywa dla `test:e2e`, który używa prawdziwej binarki):

```sh
BASE_URL=http://127.0.0.1:8080 \
BOOTSTRAP_TOKEN_FILE=core/data/bootstrap-token \
node scripts/smoke-s1.mjs
```

Wynik lokalny: **17/17 kroków** (readiness → bootstrap → CSRF → pairing →
enroll → heartbeat → CONFIG_STALE → config → dashboard → historia → SPA →
revoke → logout). CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
(lint/typecheck/test/build dla core i web, `go vet/test/build` dla agenta,
PostgreSQL jako service). **CI zdalne nie zostało w tej sesji uruchomione** —
powyższe wyniki są lokalne.

## Bezpieczeństwo (skrót)

- Single-user, brak kont zewnętrznych, zero telemetrii wychodzącej.
- Hasła i credentiale agentów: wyłącznie argon2id; plaintext istnieje tylko w
  odpowiedzi enroll (raz) i w pliku agenta `0600`.
- Sesja: losowy 256-bit id, cookie `__Host-sp_session` (prod) `HttpOnly`,
  `SameSite=Lax`, `Secure`, TTL 30 dni ze sliding renewal.
- Mutacje: `X-CSRF-Token` + kontrola `Origin`/`Referer`.
- Logi: redakcja sekretów; `audit_log` bez plaintextu.
- Nagłówki SPA: CSP, `nosniff`, `no-referrer`, COOP, `frame-ancestors 'none'`;
  HSTS tylko za TLS.
- Core nie dotyka `docker.sock`; agent nie nasłuchuje na porcie.

Pełny model: [`docs/security.md`](docs/security.md) i [`SECURITY.md`](SECURITY.md).

## Ograniczenia S1 (świadome)

- Rate-limity są in-memory (jedna instancja; restart zeruje liczniki).
- Brak joba `state_sweeper`: promocja rotacji po deadline jest leniwa (przy
  pierwszym żądaniu); retencja/rollupy/`expired` komend należą do S5.
- Rozdział roli DB `audit_log` (INSERT+SELECT, bez UPDATE/DELETE) jest
  wdrożeniowy: aplikacja nie wykonuje UPDATE/DELETE, ale egzekwowanie uprawnień
  roli wymaga osobnej roli — patrz `SECURITY.md`.
- Brak resetu hasła CLI (SP-600), brak 2FA (SEC-002).
- Docker inventory/status, pełny workflow incydentów (ack/powiadomienia),
  kolejka komend/recovery, rollupy, retencja i PWA SW pozostają przyszłe.
  Lokalny wycinek HTTP i minimalne incydenty N/M są już zaimplementowane.
  AI: wdrożone są fundamenty konfiguracji/połączeń (bez inferencji — patrz
  `docs/ai-integration-contract.md` §0); inferencja i tryby działań to przyszłość.

## Struktura repo

```
core/     Fastify + Prisma; API, ingest, auth, SPA; Dockerfile, migrations, testy
web/      React + Vite + M3; serwowane przez Core (same origin)
agent/    Go; binarka Linux (systemd), outbound-only
deploy/   docker-compose (+ TLS Caddy), .env.example, przykłady
scripts/  dev-db.sh, smoke-s1.mjs, e2e-go-core.mjs
docs/     architecture / agent-protocol / data-model / security / ui-design
```

## Licencja

Apache-2.0 — patrz [`LICENSE`](LICENSE). Repo jest publiczne open source;
wkład podlega warunkom Apache-2.0 (sekcja 5 licencji).

### Iteracja usług — monitoring na hoście agenta

Zakładka **Usługi** pokazuje lokalne listenery wykryte automatycznie przez
agenta. Rozpoznane Jellyfin, T3 Code i OpenCode mają bezpieczne presety HTTP;
wybierz **Monitoruj**, aby zatwierdzić sondowanie. Można zmienić nazwę,
ścieżkę względną, oczekiwane statusy HTTP, interwał, timeout i progi N/M,
wstrzymać/wznowić lub usunąć monitoring. Nieznane listenery są domyślnie TCP
bez automatycznego włączania HTTP. Agent nie używa socketa Dockera ani shella.

Sondy wykonuje agent na swoim `127.0.0.1`, nigdy serwer Core. Jellyfin
`/Health` sprawdza zdrowie HTTP; T3 `/` potwierdza odpowiedź frontendu, a
OpenCode `/` akceptuje także 401 bramy uwierzytelnienia. To nie są testy
funkcjonalne całej aplikacji. Przekierowania i proxy są wyłączone.

Dostępność jest procentem **zmierzonego czasu** między rzeczywistymi
sondami (minimum dwie); przerwy ponad dwa interwały i cisza po ostatniej
próbce są nieznane. Offline agenta oznacza nieznany stan usług. Historia
przechowuje wyniki oraz minimalne incydenty otwierane po N błędach i
zamykane po M sukcesach. Ack, powiadomienia i recovery pozostają przyszłe.
Czas procesu jest osobnym, opcjonalnym dowodem z `/proc`, nie uptime HTTP.

Discovery działa przy starcie i co 60 s, heartbeat/UI co 15 s, sondy
standardowo co 30 s. Ograniczenia: Linux `/proc`, reguły identyfikacji o
różnej pewności; HTTP wspiera bind IPv4 loopback/wildcard. IPv6 i bind LAN
są widoczne jako TCP. Najpierw wdrażaj migrację i Core, następnie agenta,
zachowując jego katalog stanu. Szczegóły: `docs/iterations/s2.md`.

# Iteracja S4 — integracja: publiczne URL-e, generyczne discovery, uczciwy status

> Dokument historyczny: ówczesna nazwa produktu „StatusPilot”; obecnie **Windup Monitor** (UI: **wind-up monitor**). Nazwy baz/ścieżek w treści są historyczne i pozostają bez zmian dla zgodności.

Data: 2026-10-19. Zakres: Core + Web + migracja addytywna; bez Dockera,
bez nowego obrazu, bez AI, bez zmian w `agent/**` (agent edytowany równolegle
przez MiMo). Bez commit/push/PR.

## 1. Publiczne adresy URL (CRUD + sonda Core)

Wpięte istniejące moduły `core/src/public-endpoints/**` i
`web/src/public-endpoints/**`:

- `registerPublicEndpointRoutes(api, ctx)` w `core/src/app.ts` (sesja + CSRF +
  Origin dla mutacji), scheduler w `core/src/index.ts` (własny timer,
  concurrency 2, timeout sondy ≤ 8 s); definicje i wyniki w PostgreSQL.
- Web: sekcja „Publiczne adresy URL" w szczegółach karty usługi (bez nowego
  nav), dodawanie/edycja/pauza/usuwanie, max 5 na usługę.
- Polityka: wyłącznie `https://`, port 443, brak userinfo/fragmentów/literałów
  IP; świeży DNS na każdą sondę, każdy adres musi być publiczny (odrzucane
  prywatne/loopback/link-local/CGNAT/multicast/documentation, IPv4-mapped,
  6to4/Teredo/ISATAP z prywatnym IPv4, ULA); połączenie dialuje zwalidowane IP
  z SNI/hostem oryginalnej nazwy (pin, anty-rebinding); brak proxy, brak
  cookies/auth, brak follow redirectów; body 64 KiB odrzucane.
- Statusy: 2xx/3xx/401/403/4xx = „odpowiada" (`up`), przy czym 3xx ma
  `errorCode REDIRECT` („Przekierowanie", nigdy finalny health), 401/403
  `AUTH_REQUIRED`; 5xx i błąd transportu = `down`. Zmiana URL/pauza czyści
  stary wynik i historię. Copy mówi „Sprawdzane z serwera StatusPilot", nie
  „publicznie dostępne z całego internetu".
- Dowód live: URL operatora `https://filmy.moviak.quest/Health` dodany przez
  normalne API (sesja) do usługi Jellyfin, scheduler wykonał sondę:
  `status=up`, `statusCode=200`, `latency≈2.0 s`, historia 1 wpis. Root
  `https://filmy.moviak.quest/` nadal zwraca 302 — wybór `/Health` jest
  świadomy (root byłby „Przekierowanie").

## 2. Generyczne discovery + TCP (Core gotowe, agent równolegle)

Kontrakt addytywny (szczegóły: `.tmp/generic-agent-v2-handoff.md`,
`core/CONTRACT.md` §6):

- `kind` nie jest zamkniętym katalogiem (wzorzec `^[a-z0-9][a-z0-9-]{0,31}$`);
  `source` zostaje starym enumem; `kind: "unknown"` nie oznacza
  „niemonitorowalne".
- Kandydat: `monitorable: boolean` + `name_source` z enumem
  `exe|comm|package-json|systemd|container|fallback|fingerprint`; generyczne id
  `generic-<port>`, stare id zachowane. Brak nowych pól = stara inferencja.
- Migracja `20261019140000_generic_discovery`: `discovered_services.monitorable`,
  `name_source` (enum DB), `services.transport` (default `http`),
  `services.last_restart_at`; poluzowane CHECK-i dla generycznego `kind` oraz
  TCP (`path=''`, puste `expected_statuses`), z zachowaniem ostrych reguł HTTP.
- `GET /config.service_checks[]` ma `transport` (`http` domyślnie dla starego
  agenta); checki TCP wysyłane tylko agentowi z capability `tcp_checks`.
- UI pokazuje **wszystkie** `monitorable` kandydaty z faktycznymi nazwami
  (także `kind: unknown`), oferuje „Włącz monitoring TCP"; tooltip opisuje
  źródło/pewność słowami. HTTP nadal wymaga ścieżki; sugestia discovery to
  tylko podpowiedź, nazwę można zmienić.
- TCP: tylko eligibilne `127.0.0.1`/`0.0.0.0`, bez ścieżki, `status_code=null`;
  sukces = samo połączenie. Stary agent nie dostaje checków TCP (nie
  raportuje fałszywego HTTP `down`).

Status agenta: **wdrożony** (binarka v2 z tego samego `agent/**`, zachowany
`.tmp/review/agent-state`: ten sam agent id, seq kontynuowany od 1604).
Live discovery zwróciło 75 kandydatów, w tym 29 generycznych
(`generic-<port>`), 24 monitorowalne; nazwy pochodzą z `package-json`
(np. `statuspilot`, `@statuspilot/core`, `@statuspilot/web`), `exe`
(np. `cloudflared`) lub `fallback` („Usługa na porcie N”). Stare wiersze
`unknown-*` nie są już wysyłane; pozostają w DB jako nieaktywne, gdy nowy
kompletny snapshot ich nie zawiera. Backcompat: nowy agent → stary Core jest
bezpieczny (nowe klucze są ignorowane przez niestrict schema, a lista
capabilities się nie zmieniła); nowy Core → stary agent traktuje brak
`transport` jako HTTP i nie dostaje checków TCP. Kolejność wdrożenia: Core
najpierw, potem agent.

## 3. Uczciwy status: `degraded` i restart

Diagnoza zgłoszenia „T3 down, UI nadal up" na podstawie DB (UTC) i czasu
przeglądarki:

- Ostatni nieudany pomiar T3: `service_results.observed_at = 11:16:43 UTC`
  (`ok=false`, `errorCode=TIMEOUT`), następny sukces `11:17:13 UTC`.
- `up_since` T3 zmienił się na `11:17:13 UTC`, co odpowiada **20:17 czasu
  przeglądarki** (UTC+9) — to wyjaśnia „zmieniło się 20:17", bez założenia,
  że przeglądarka jest w UTC.
- Przez ten czas `status` pozostawał `up`, bo `failureThreshold=3`; pierwszy
  sukces wyzerował `up_since` (pierwsza zdrowa obserwacja po przerwie).
  To nie dowodzi wielogodzinnej awarii — dowód obejmuje jedną nieudaną sondę
  i reset ciągłości.

Zmiany:

- Nowy status **pochodny** `degraded` (`computeServiceStatus`): usługa
  historycznie `up` z `consecutiveFailures > 0` nie jest już pokazywana jako
  `up`; UI: „Pogorszenie" + „ostatni pomiar nieudany, próg awarii
  nieosiągnięty". Brak danych/stary `lastCheckedAt`/offline agenta nadal
  `unknown` — przerwa nigdy nie liczy się jako `up`.
- Wykryty restart procesu właściciela (`process_started_at` zmienia się):
  `last_restart_at`, reset `up_since`/streaków, status `unknown` do pierwszej
  zdrowej próbki. UI pokazuje osobno „Wykryto restart procesu …" i ciągłość
  od pierwszego zdrowego pomiaru — bez fałszywego czasu pracy.
- Zegar: `observed_at` agenta jest UTC; przy cofnięciu zegara spóźnione
  wyniki nie nadpisują nowszych. Nie fabrykujemy czasu trwania awarii.

Dowód live `degraded` (bez zatrzymywania usług użytkownika): tymczasowy
serwer HTTP na `127.0.0.1:18090`, usługa HTTP z `failureThreshold=2` była
`up`/200; po zatrzymaniu fixture pierwsza nieudana sonda dała
`status=degraded`, `consecutiveFailures=1`, `lastErrorCode=SERVICE_UNAVAILABLE`
— **bez** otwartego incydentu i bez pokazywania `up`. Fixture i usługa
usunięte po teście.

## 4. CPU/RAM procesów (bez zmian)

Zachowane z S3: realne CPU/RSS procesów Jellyfin/T3/OpenCode, karta usługi
pokazuje „CPU procesu"/„RAM procesu", paleta biały/czarny/granat, stały tekst
„Dane odświeżają się co 15 sekund", brak widocznej tabeli CPU. Live API nadal
zwraca metryki procesów (T3 ~18%/367 MB, Jellyfin realne ~0%/25–26 MB).

## 5. Wdrożenie i weryfikacja

- Backup przed migracją: `.tmp/review/pre-s4-integration-20261019T123329Z.dump`
  (custom dump, zweryfikowany `pg_restore --list`).
- `prisma migrate deploy` na `statuspilot_review`: zastosowane
  `20261019130000_ai` (wcześniej pending, schema-only; ten task nie dodaje
  funkcji AI) i `20261019140000_generic_discovery`.
- `npm run build` (core+web) zielony; Core zrestartowany
  `.tmp/review/start-core.sh`, `/api/v1/health/ready` → 200
  `{database:"ok"}`; agent zachował `.tmp/review/agent-state` i wznawia
  heartbeaty (te same seq/credentiale).
- Live: normalne API dodało Jellyfin `https://filmy.moviak.quest/Health`;
  publiczny status `up`/200. T3 i Jellyfin lokalnie `up`, CPU/RAM obecne.
- Agent v2: zbudowany `go build` (bez edycji `agent/**`) i podmieniony pod
  tą samą ścieżką/state dir; `go vet ./...` i `go test ./...` zielone
  (w tym `go test -race` uruchomiony przez właściciela agenta).
  Live: `generic-18080` („statuspilot”, `name_source=package-json`) ma
  realne CPU/RAM (np. CPU ≈2.4%, RSS ≈183 MB), a po włączeniu przez normalne
  API jako TCP: `transport=tcp`, `path=""`, `expected_statuses=[]`,
  dwa wyniki `ok=true`, `status_code=null`, status `up`.
- Regresja HTTP fail: tymczasowa usługa HTTP na porcie TCP-only
  (`generic-55432`) z `failureThreshold=1` przeszła w `down` z
  `lastErrorCode=TRANSPORT_ERROR` po pierwszej nieudanej sondzie; następnie
  usunięta. HTTP up (T3/Jellyfin) bez zmian.
- Browser (cached Chromium, `--no-sandbox`, AppArmor blokuje sandbox):
  desktop 1440×1000 i mobile 390×844 — sekcja publicznych URL widoczna,
  „Publiczny adres odpowiada", zakładka wykrytych pokazuje 29
  monitorowalnych (w tym generyczne TCP z „Włącz monitoring TCP"), brak
  `pageerror`, brak poziomego overflow. Zrzuty:
  `.tmp/review/s4-services-*.png`, `s4-discovered-*.png`.
  To sanity właściciela, **nie niezależny review** (review wykonany później —
  §8).

## 6. Testy

- Core (real PostgreSQL, własna baza `statuspilot_services_test`):
  `test/generic-discovery.test.ts` (9) — nowe pola/enum, inferencja legacy,
  generyczny TCP bez ścieżki, inferencja `tcp_checks` z dowodu v2, metryki
  CPU/RSS dla `generic-*` z exact `candidate_id`+`process_started_at` (bez
  kind-whitelisty; brak startu = null), restart, `degraded`, brak
  fałszywego `up`.
- Core: `public-endpoints.test.ts` — CRUD/limit/unikalność/CSRF, retarget
  czyści wynik, scheduler (due/pauza/brak nakładania), klasyfikacja
  2xx/3xx/401/4xx/5xx, redirect jako `up`+`REDIRECT`.
- `public-endpoints-policy.test.ts` / `public-endpoints-probe.test.ts` —
  SSRF (prywatne DNS, pin IP, mixed answers), brak follow, deadline, 401.
- Web: 110 testów (m.in. `degraded`, restart, generyczny TCP, redirect copy),
  typecheck, lint, build — po dodaniu 3 testów poprawkowych (§8): 113.
- Go: `go vet ./...`, `go test ./...` — zielone (agent edytowany przez
  właściciela; ten task nie zmieniał `agent/**`).

Przebieg pełnego suite Core (real PG) dał 198/200; dwa błędy były w testach
(clock stale w teście `degraded` oraz oczekiwanie starego `PATH_REQUIRED`
po zmianie monitorowalności). Oba poprawione; targeted rerun:
`generic-discovery` 9/9, `services`+`public-endpoints` 47/47,
`heartbeat`+`process-metrics` 13/13. Nie ma otwartych błędów w zmienionych
modułach.

## 7. Pozostałe ograniczenia / niepewność

- Wszystkie elementy acceptance tej iteracji są wdrożone live (public URL,
  TCP, generyczne nazwy, CPU/RAM, `degraded`). Niezależny review (read-only)
  został wykonany i zamyka iterację po naprawieniu dwóch findings — szczegóły
  i rozdzielenie dowodów w §8; ten dokument rozdziałowo opisuje sanity
  właściciela (§5), a review i sanity po poprawkach (§8).
- Zgłoszonej awarii T3 nie da się potwierdzić jako wielominutowej z dostępnych
  danych: jest jedna nieudana sonda + reset `up_since`; konwersja 11:17 UTC →
  20:17 czasu przeglądarki wskazuje UTC+9, ale nie zakładamy tego globalnie.
  Był to pojedynczy `TIMEOUT`, nie potwierdzony incydent — dowód obejmuje
  jedną nieudaną próbę, nie wielominutową awarię.
- Publiczny check ma vantage tylko z serwera StatusPilot (bez zewnętrznego
  punktu pomiarowego); copy UI tego nie rozszerza.
- Monitorowanie TCP sprawdza samo połączenie (connect), nie protokół usługi;
  `status_code` jest `null` i UI nie udaje HTTP health.
- Metryki CPU/RAM procesu czytają `/proc` właściciela: przy braku
  uprawnień (procesy root-owned, niedostępne fd) lub niejednoznacznym
  ownerze wartości są `null`, nigdy zerem — to celowy brak danych.
- Nazwy generycznych kandydatów zależą od `name_source`
  (`package-json|exe|…|fallback`); `fallback` to „Usługa na porcie N"
  z pewnością `low` — to nie gwarancja trafnej nazwy usługi.

## 8. Niezależny review (read-only) i finalne poprawki

Reviewer (Spark, read-only) obejrzał kod i wdrożenie live bez commitów i bez
uruchamiania pełnego suite Core (nie miał własnej bazy). Poza potwierdzeniami
— polityka publicznych URL-i (świeży DNS/pin IP, ≤8 s, concurrency 2,
uczciwy vantage „ze serwera StatusPilot", bez follow), generyczny allowlist
TCP z pewnością nazw, CPU/RAM, ikony, `degraded`/restart, luka obserwowana,
zrzuty `.tmp/review/s4r-*.png` desktop/mobile bez overflow i `pageerror` —
zgłosił dwa findings. Oba naprawione, bez nowych feature'ów, migracji i
budowy Dockera:

1. **MED1 — `web/src/pages/ServicesPage.tsx`.** Sekcja „Publiczne adresy
   URL" renderowała się tylko w gałęzi sukcesu historii: `history` 500
   usuwał blok CRuD, a `catch` listy publicznej mapował każdy błąd (w tym
   401) na `[]` → fałszywe „Brak dodanych adresów". Teraz publiczne URL-e
   mają własny stan (`idle/loading/error` + ostatnia znana lista), ładują się
   i renderują niezależnie od historii (także przy jej ładowaniu/błędzie);
   401 wywołuje właściwy `onSessionExpired`, inne błędy dają jawnny komunikat
   z „Ponów" (przy danych — pokazujemy ostatnią znaną listę), a realny pusty
   wynik to nadal `[]`. Jedno rozwinięcie = jeden request (bez dublowania).
2. **MED2 — `core/src/services/service.ts` (`updateService`).** `PATCH
   /services/:id` z `path` na celu TCP zwracał 200, ignorując pole. Teraz
   `path` przesłany dla TCP = `400 INVALID_BODY`, transakcja bez zapisu i bez
   wpisu audytu (serwis nietknięty). Walidacja ścieżki HTTP, cooldowny i
   transport bez zmian; Web i tak nie wysyła `path`/`expectedStatuses` dla TCP
   (usuwa je z payloadu), więc istniejące edycje TCP działają.

### Testy po poprawkach (targeted — bez powtarzania pełnego Core suite)

- **Web:** `ServicesPage.test.tsx` 26/26, w tym 3 nowe: historia 500 a
  sekcja publiczna dalej dostępna; publiczne 401 → `onSessionExpired` zamiast
  fałszywego pustego stanu; realne `[]` jako normalny stan + brak dublowania
  requestu. Pełny `web` **113/113**, `lint`/`typecheck`/`build` zielone.
- **Core** (real PG, izolowana własna baza `statuspilot_s4_finalfix` na
  `127.0.0.1:55432` — **nie** `statuspilot_review`, którego global setup
  truncuje): `services.test.ts` **27/27**, w tym nowy test (TCP `path` → 400
  bez zmiany serwisu, TCP rename/pauza 200, HTTP `path` PATCH 200 z
  istniejącego testu). `lint`/`typecheck`/`build` zielone. Pełny suite
  ponownie nieuruchamiany (bez potrzeby).

### Wdrożenie i dowód live

- Core przebudowany i zrestartowany wyłącznie `.tmp/review/start-core.sh`
  (ten sam stabilny `SESSION_SECRET`, `COOKIE_SECURE=true`, origins Tailscale;
  `web/dist` przebudowany przed restartem Core — własny restart jest potrzebny
  dla routingu wygenerowanych assetów). Agent v2 nietknięty: `.tmp/review/
  agent-state` bez zmian, ten sam agent, po restarcie `online`.
- `GET /api/v1/health/ready` → 200 `{"database":"ok"}`, `/api/v1/health` →
  200, `GET /api/v1/services` bez sesji → 401, `/` i nowy asset
  `assets/index-*.js` → 200. Bez restartu Jellyfin/innych kontenerów (czasy
  `Up` bez zmian) i bez odpauzowania OpenCode.
- Kontrakt MED2 na żywym API: `PATCH {path:"/health"}` na TCP `statuspilot` →
  `400 INVALID_BODY`, serwis bez zmian (`path=""`, `configRevision=1`,
  `status=up`); publiczny URL Jellyfin nadal `up`/200.

### Dowód wizualny: review niezależne vs sanity właściciela

- **Niezależny review (Spark):** zrzuty `.tmp/review/s4r-*.png` (desktop
  1440×1000, mobile 390×844) obejrzane przez recenzenta — brak poziomego
  overflow i `pageerror`, poprawna hierarchia sekcji. To review, nie testy.
- **Sanity właściciela po poprawkach:** `.tmp/review/s4fix-verify.mjs`
  **16/16 checks** + zrzuty `.tmp/review/s4fix-services-{desktop,mobile}.png`
  i pełnostronicowe `s4fix-jellyfin-{desktop,mobile}.png` — sekcja publiczna
  renderuje się pod historią („1 z 5", „Publiczny adres odpowiada"), pusty
  copy zgodny z API, brak overflow i błędów strony. To sanity właściciela,
  **nie** kolejna runda review.

Pochodzenie dowodów testowych: niezależny reviewer Core nie uruchamiał suite
(brak własnej bazy) — jego testowy wkład to przegląd i 32 testy web; pełny
Core 198/200 (2 testy skorygowane) + targeted 69 oraz web 110 (teraz 113) to
uruchomienia właściciela.

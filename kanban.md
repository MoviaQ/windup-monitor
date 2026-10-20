# Kanban Windup Monitor

> Plan pracy przyrostowej. Faza S1 (slice) zaimplementowana, zweryfikowana lokalnie i zamknięta po niezależnym code security review + visual review desktop/mobile 2026-10-19 (dowód: `docs/iterations/s1.md`, szczegóły §7); SP-105 pozostaje `Partial` (SP-105b w Backlogu), zdalne CI = follow-up SP-107. Lokalny build/smoke Docker PASS; iteracja usług zamknięta po niezależnym review (dowody `s2.md` + `s4-integration.md` §8). Integracja S4 (publiczne URL-e, generyczne discovery/TCP, `degraded`) wdrożona live i zamknięta po niezależnym read-only review: 2 findings naprawione, testy targeted + sanity wizualne zielone (`docs/iterations/s4-integration.md` §8), SP-303/SP-304 → Done; agent v2 bez zmian (SP-304). Pozostały zakres faz S2–S7 nadal Backlog; zdalne CI nadal otwarte. Statusy zadań: `Backlog | Ready | In progress | Blocked | Done | Partial`.

## 0. Jak czytać ten plik (reguły aktualizacji)

1. **Kolumny:** `Backlog` (pomysł, brak gotowości) → `Ready` (opis + kryteria gotowe do wzięcia) → `In progress` (max 2 na osobę) → `Blocked` (zawsze z powodem i linkiem) → `Done` (spełnia Definition of Done + dowód). Osobno **`Partial`**: wykonana część zakresu tasku, gdy reszta jest jawnie odłożona do innego tasku — wymaga dopisania w nawiasie, co jest Done i gdzie kontynuacja (np. SP-105 → SP-105b); `Partial` nie zamyka acceptance w pełnym zakresie.
2. **Stabilne ID:** `SP-XXX` nigdy nie zmieniają znaczenia; nowe zadania dostają kolejne numery, nie „wypełniają luk".
3. **Priorytety:** `P0` blokuje release MVP, `P1` w MVP ale nie blokuje startu slice'a, `P2` future po MVP, `P3` nice-to-have.
4. **Fazy (etapy):** `S0 foundations` → `S1 pierwszy slice` → `S2 docker` → `S3 http+incidents` → `S4 recovery` → `S5 dane/polish` → `S6 hardening` → `S7 OSS/release`.
5. **Zależności:** wymienione w tasku (`Dep:`). Nie zaczynać tasku, gdy zależność nie jest w Done.
6. **Przeniesienie do Done:** wymaga dowodu z sekcji „Dowód"/„Akceptacja" tasku + przejścia Definition of Done (§4).
7. **Słownictwo statusów** w taskach UI/API jest identyczne z [docs/data-model.md](docs/data-model.md) §5 (`online/stale/offline`, `open/acknowledged/resolved`, `queued/claimed/running/succeeded/failed/expired/rejected/cancelled`). Protokół: [docs/agent-protocol.md](docs/agent-protocol.md) v1.
8. **Aktualizacja:** przy zmianie statusu dopisać datę i inicjały; nie usuwać historii (dopisek, nie nadpisanie).

## 1. Tablica: faza S0 — foundations (projekt dokumentacji)

| ID | Task | Pri. | Status |
|---|---|---|---|
| SP-001 | Ryzyka i niejasności: zebrać i rozstrzygnąć defaultami | P0 | Done |
| SP-002 | Struktura repo i granice komponentów | P0 | Done |
| SP-003 | Protokół agent–Core v1 (pairing/credentiale/offline/kolejka) | P0 | Done |
| SP-004 | Model danych + maszyny stanów + retencja | P0 | Done |
| SP-005 | Bezpieczeństwo: granice, auth, Docker root-equiv, SSRF | P0 | Done |
| SP-006 | UI: aktualny stan M3/Expressive na Web + tokeny + PWA | P0 | Done |
| SP-007 | Plan slice'ów i vertical slice S1 | P0 | Done |

Dowód dla SP-001…SP-007: pliki `docs/*.md` + ten kanban jako lokalne pliki robocze bez commita. Kryterium: każdy dokument ma sekcję otwartych decyzji z rekomendowanym defaultem; linki wewnętrzne działają; źródła MD3 aktualne (2026-10-19) z linkami.

### S0b — Foundations-extension: przygotowanie publicznego OSS (przed S1, lokalnie, bez zdalnego repo)

> Publikacja repo jest przyszłym zadaniem, nie wykonanym: ten etap wyłącznie PRZYGOTOWUJE lokalnie minimalne pliki i plan publikacji. Warunkiem publikacji jest wyraźne potwierdzenie przez użytkownika proponowanej licencji (DEC-007). Zdalne publiczne repo obecnie nie istnieje; nic nie jest upublicznione. Rozbudowa dokumentów (SP-700) i końcowa higiena (SP-704) następują później — bez cykli zależności.

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-008 | Minimalne pliki OSS + plan publicznego repo (lokalnie, bez publikacji): `LICENSE` (Apache-2.0 jako PROPOZYCJA użytkownika — default rekomendowany, do potwierdzenia przed publikacją), szkielety `CONTRIBUTING.md` / `SECURITY.md`, jawny plan publikacji z warunkiem potwierdzenia licencji | P0 | Done (2026-10-19: `LICENSE.proposed` + `CONTRIBUTING.md` + `SECURITY.md` istnieją lokalnie; DEC-007 jako propozycja; brak publikacji, brak sekretów w plikach) | SP-001–007 | `LICENSE` (propozycja) + szkielety `CONTRIBUTING`/`SECURITY` istnieją lokalnie; plan publikacji odnotowany; decyzja DEC-007 odnotowana jako propozycja do potwierdzenia; brak sekretów w plikach (grep-test); brak twierdzenia, że repo jest już publiczne |

## 2. Tablica: implementacja (S1 → S7)

### S1 — Pierwszy vertical slice: login + pairing + metryki hosta → dashboard

> Cel: zalogowany użytkownik widzi sparowanego agenta Linux i jego CPU/RAM/dysk z rozróżnieniem online/stale/offline. Bez Dockera, bez HTTP checks, bez recovery.

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-100 | Szkielet repo: `core/` (Fastify+Prisma), `agent/` (Go), `web/` (Vite), `deploy/compose`, CI lint/build | P0 | Done (2026-10-19: lint/typecheck/build core+web zielone, `go vet/test/build` zielone, `compose config` + overlay TLS valid; dowód lokalny w `docs/iterations/s1.md`; pełne acceptance — log zdalnego CI + `up --build` — NIEZAMKNIĘTE: zdalne CI nieuruchomione, budowa obrazu odłożona → follow-up **SP-107**) | SP-001–007 | CI przechodzi na pustym szkielecie (`lint+typecheck+build`); `compose config` valid; dowód: log CI (zdalny log CI otwarty → SP-107, lokalne wyniki w `s1.md` §2) |
| SP-101 | Bootstrap + lokalne logowanie (argon2id, session cookie, rate-limit) | P0 | Done (2026-10-19: `core/test/auth.test.ts` 11 zielonych + smoke/E2E; single-use, rate-limit 5/5min, CSRF/Origin) | SP-100 | Bootstrap single-use działa raz (2. użycie → błąd); login OK/błędny wg spec; rate-limit 5/5min/IP (test); dowód: testy + log CI |
| SP-102 | Enroll agenta (one-time token, credential+hash, 0600) + ekran pairing | P0 | Done (2026-10-19: `core/test/enroll.test.ts` + E2E prawdziwą binarką Go `enroll` → 0600; retry po błędzie nie pali tokenu) | SP-101 | Token single-use tylko po sukcesie (retry po błędzie działa); hash w DB (brak plaintext); plik 0600; dowód: test e2e enroll |
| SP-103 | Heartbeat v1: seq/idempotency, ingest CPU/RAM/dysk/sieć/uptime → Postgres | P0 | Done (2026-10-19: `core/test/heartbeat.test.ts` dedup/`STALE_SEQ`/restart/CONFIG_STALE/zakresy + E2E ciągłe heartbeaty binarki → wiersze DB) | SP-102 | Retry tego samego `seq` nie duplikuje (`ON CONFLICT DO NOTHING`); `STALE_SEQ`/`STALE_SNAPSHOT` bez overwrite; dowód: test ingest |
| SP-104 | Dashboard: lista agentów online/stale/offline + wiek danych + wykres | P0 | Done (2026-10-19: web 31 testów zielonych + E2E `GET /agents` online z metrykami; niezależny visual review desktop 1440×900 + mobile 390×844 na żywym stacku :18080 — **BRAK BLOCKERÓW**, 9 zrzutów w `.tmp/review/` (gitignored); brak PR/zdalnego repo → zrzuty lokalne, dowód w `s1.md` §7.2) | SP-103 | Anatomia/stany/klawiatura komponentów statusu wg M3; zrzuty desktop+mobile + visual review; dowód: zrzuty + test render |
| SP-105 | Rotacja/revokacja credentialu z UI + procedura compromise | P1 | Partial (2026-10-19: SP-105a Done — API `POST /rotate`+`/rotate_confirm`, dual-accept, `ROTATION_CONFLICT`, lazy promocja, revoke czyści oba sekrety, CLI `rotate`, testy `rotation.test.ts` + `credential-races.test.ts` 10 zielonych; UI rotacji brak → SP-105b) | SP-102 | Sekret `next` generuje agent i zapisuje `0600` przed `/rotate`; retry tym samym `rotation_id + next` przy pending = `200` idempotentnie, inny `next` przy pending = `409`; retry `rotate` po zakończeniu rotacji (`last_rotation_id`) = `409` bez odtwarzania pending; `rotate_confirm` nowym (`200`, repeat confirm tym samym ID = `200`); po deadline promocja `next` także przy pierwszym żądaniu ze starym/błędnym Bearerem (stary sekret → `401`); brak confirm → autopromocja `next` o `overlap_until`; revoke czyści current+next bez overlap i jest terminalny (401 `AGENT_REVOKED` także dla żądań autoryzowanych przed revoke); re-enroll tylko przy utracie obu sekretów; rotacja nie blokuje heartbeat; dowód: `rotation.test.ts` + `credential-races.test.ts` (real PG, deterministyczna synchronizacja po auth, bez sleepów) |
| SP-105b | Rotacja credentialu z UI (przycisk w dashboardzie, stany pending/overlap, procedura compromise w docs) | P1 | Backlog | SP-105 | Ekran dashboardu pozwala zainicjować rotację i pokazuje stan; dowód: test render + visual review |
| SP-106 | Testy S1 (jednostkowe ingest/auth + e2e: enroll→heartbeat→stale/offline) | P0 | Done (2026-10-19: core 7 plików/52 testy + web 7/31 + `scripts/e2e-go-core.mjs` 24/24 prawdziwą binarką; grep-test sekretów w logach w E2E; **niezależny visual review desktop+mobile zakończony BRAK BLOCKERÓW** — dowód i zrzuty w `s1.md` §7.2) | SP-103, SP-104 | E2E zielone: enroll→heartbeat→rozłączenie 45 s `stale` / 5 min `offline`; brak sekretów w logach (grep-test); dowód: log CI |
| SP-107 | Follow-up do SP-100: budowa obrazu Docker (`up --build`) na hoście z zapasem miejsca + pierwsze uruchomienie zdalnego CI (repo istnieje tylko lokalnie) | P1 | Backlog | SP-100 | `docker compose up -d --build` przechodzi i healthcheck zielony; zdalne CI zielone na wypchnięciu; dowód: log CI + `compose ps` (do czasu wykonania SP-100 ma tylko lokalne równoważne pokrycie: `compose config` + prod `dist` w E2E) |
| SP-108 | Paleta neutralna navy (biały/czarny/granat, zero pink/purple) w web | P1 | Done (2026-10-19: tylko `tokens.css` + `theme-color` w `index.html`; layout/backend/auth/dane bez zmian; DEC-UI-04 w `docs/ui-design.md`; build + testy web zielone; zrzuty light/dark desktop+mobile w `.tmp/review/navy-*`, brak różu w głównych elementach, kontrasty ≥7:1; live dist odświeżony na review Core :18080) | SP-104 | `tokens.css` bez fioletu/różu w rolach (grep-test); light/dark + auto spójne; statusy czytelne (ikona+tekst); dowód: zrzuty + testy web |
| SP-109 | UI copy: stały interwał odświeżania zamiast licznika wieku zdrowych danych („X s temu"/„przed chwilą"/„Ostatnie dane" → „Dane odświeżają się co 15 sekund"; ukryta karta → „Automatyczne odświeżanie co 15 sekund" jako interwał skonfigurowany) + historia CPU bez widocznej tabeli (podsumowanie okresu/ostatniej wartości/min/maks dla czytników przez `aria-describedby`, bez nowej kontrolki) | P2 | Done (2026-10-19: `web` lint/typecheck/test 30/30 dla zmienionych plików + build zielone; live na review Core :18080 i Tailscale HTTPS — `verify-tailscale.mjs` 15/15 (agent `online`, `lastSeenAge=14s`, cookie `__Host-sp_session` Secure, CSRF/origin zielone) + smoke Playwright desktop 1440×900 / mobile 390×844 = 14/14, zrzuty `.tmp/review/refresh-0*`; `formatAge`/`useNow` usunięte jako martwe; SP-104 bez zmian ID) | SP-104 | Brak tykającego wieku i „lastUpdated" przy zdrowych danych; stale/offline/nieudane odświeżenie mówi wprost „Dane mogą być nieaktualne" albo „Brak połączenia", bez claimu, że odświeżanie działa; timestampy próbek na wykresie, token expiry i uptime bez zmian; `role="img"` + `aria-describedby` zamiast widocznej tabeli; zielone `npm run lint/typecheck/test --workspace web` dla plików w zakresie + `npm run build --workspace web`; UWAGA: `docs/ui-design.md` (§46/§64) nadal opisuje przykład „2 min temu" i „wiek danych" — poza zakresem tego tasku, do korekty przy okazji przeglądu docs |

Kryteria akceptacji S1 (bramka fazy): enroll działa z tokenem 15-min single-use konsumowanym atomowo po sukcesie (retry po błędzie nie pali tokenu); retry tego samego `seq` nie duplikuje próbek; rozłączenie agenta 45 s → `stale`, 5 min → `offline` (lub wartości potwierdzone w DEC-003); dashboard pokazuje wiek danych; brak sekretów w logach (test grep). Dowód: zielone CI + nagranie/zrzuty dashboardu w PR.

> Uwaga dowodowa (2026-10-19): PR ani zdalne repo nie istnieją, więc zamiast dowodu „w PR" są **lokalne zrzuty** (`.tmp/review/`, gitignored) + `docs/iterations/s1.md` §7, a zielone CI to **lokalne** lint/typecheck/test/build (actionlint zielony) — zdalny log CI otwarty jako **SP-107**. Bramka zamknięta na dowodach lokalnych, bez twierdzenia o zdanym CI zdalnym.

> Uwaga dyskowa (2026-10-19): repo oraz `data-root` Dockera są już na dysku danych `/mnt/ai_data` (`/dev/sda1`, 458 GB, 33% użycia); ograniczeniem jest dysk systemowy `/` (13 GB, 98%). **Nie wykonano migracji repo** — była bezcelowa. Cache buildu tego projektu przekierowano lokalnie na dysk danych (`scripts/env.sh` → `<repo>/.cache`; `.cache/` w `.gitignore`), bez zmian globalnych cache innych projektów ani danych Dockera. Fakty i before/after `df`: `docs/storage.md`. SP-107 (pierwsza budowa obrazu + zdalne CI) pozostaje follow-upem.

### S2 — Docker: discovery/status/resources (tylko odczyt)

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-200 | Agent: odczyt docker.sock (inventory + stats), allowlista wywołań | P0 | Backlog | SP-103 | Tylko wywołania z allowlisty (brak exec/create/run — test statyczny grep); `snapshot_at` w każdym bloku; dowód: test z mock socketem |
| SP-201 | Core+Web: lista kontenerów, status, uptime/restarts/resources, historia | P0 | Backlog | SP-200 | Stary snapshot nie nadpisuje nowszego; historia tylko przy zmianie stanu; dowód: test overwrite-guard |
| SP-202 | Testy S2 (mock socketa: running/exited/timeout; brak exec w kodzie — test statyczny) | P0 | Backlog | SP-201 | Mocki running/exited/timeout zielone; grep-test braku exec; dowód: log CI |

Kryteria: Core nie montuje socketa (test: `grep` compose+kod); restart jeszcze NIE istnieje (celowy brak — bramka).

### S3 — HTTP checks + incydenty

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-300 | Scheduler checks (interval/timeout/threshold, flap guard, SSRF allowlist) | P0 | Backlog | SP-100 | Progi N/M działają; redirect-cap 3; metadata-IP zawsze blokowane (test); dowód: testy progów + SSRF |
| SP-301 | Incydenty open/acknowledged/resolved + historia + ekran | P0 | Backlog | SP-300 | Cykl open→ack→resolved; reopen = nowy incydent z linkiem; dowód: test flow |
| SP-302 | Testy S3 (progi N/M, redirect-cap, blokady metadata-IP, ack flow) | P0 | Backlog | SP-301 | Wszystkie przypadki S3 zielone w CI; dowód: log CI |
| SP-303 | CPU/RAM rzeczywistego procesu usług (Jellyfin/T3/OpenCode) + prosta lista wykrytych usług | P1 | Done (2026-10-19: addytywny `service_process_metrics`, migracja, API null po 45 s/offline/start mismatch, UI 2 metryki „CPU procesu"/„RAM procesu" i filtr znanych HTTP; testy Go/Core/Web lokalne PASS; live API i UI desktop/mobile PASS na review :18080 — Jellyfin/T3/OpenCode mają realne CPU/RSS; niezależny review S4 (read-only) bez blockerów + sanity właściciela po poprawkach: `s4fix-verify.mjs` 16/16, zrzuty `.tmp/review/s4fix-*.png`; szczegóły `docs/iterations/s3-processes.md` i `s4-integration.md` §8) | SP-301 | Tylko jednoznaczny właściciel socketu albo zweryfikowany Jellyfin; brak danych = null (nie 0), PID nie opuszcza hosta; pierwsze CPU null, delta z rzeczywistego czasu, RAM MiB; UI pokazuje 2 metryki i ukrywa nierozpoznane/niemonitorowalne; dowód: testy + live API/UI |
| SP-304 | Integracja S4: publiczne URL-e (CRUD+sonda), generyczne discovery/TCP, `degraded`/restart, live review | P1 | Done (2026-10-19: Core+Web+**agent v2** wdrożone live — publiczny URL Jellyfin `https://filmy.moviak.quest/Health` dodany normalnym API, sonda `up`/200; migracja `20261019140000_generic_discovery`; generyczne `generic-*` z nazwami package-json/exe, TCP `up` z `status_code=null`, CPU/RAM dla generic, HTTP fail → `down`, `degraded` po pierwszej nieudanej sondzie przed progiem; browser desktop/mobile bez overflow/errors; **niezależny review read-only zamknięty**: potwierdzone SSRF/DNS-pin/≤8 s/concurrency 2/uczciwy vantage, generyczny allowlist TCP z pewnością nazw, ikony, `degraded`/restart, zrzuty `s4r-*.png` bez overflow/`pageerror`; **2 findings naprawione** — MED1: sekcja publicznych URL-i niezależna od stanu historii (błąd historii nie znika CRuD), 401 → `onSessionExpired`, inny błąd → jawnny komunikat + „Ponów" zamiast fałszywego „Brak dodanych adresów" (`web/src/pages/ServicesPage.tsx`); MED2: `PATCH {path}` na celu TCP → `400 INVALID_BODY` zamiast cichego 200, serwis bez zmian (`core/src/services/service.ts`; potwierdzone live na `statuspilot`); testy targeted: web **113/113** (3 nowe), core `services.test.ts` **27/27** na izolowanej własnej bazie `statuspilot_s4_finalfix` (nie `statuspilot_review`), lint/typecheck/build zielone; Core zrestartowany `.tmp/review/start-core.sh`, health ready 200, agent `online`, bez restartu innych kontenerów; sanity po poprawkach 16/16 + `s4fix-*.png`; szczegóły `docs/iterations/s4-integration.md` §8) | SP-303 | Publiczne URL-e: max 5/usługę, unikalność, https/443/SSRF-pin, brak follow; 3xx/401 jako „odpowiada" z etykietą, nie finalny health; TCP na `127.0.0.1`/wildcard, bez ścieżki, `status_code=null`; `degraded` gdy ostatnia sonda nieudana przed progiem; brak danych nigdy `up`; dowód: testy Core/Web/Go + live API + browser |

### S4 — Recovery: scoped restart + playbooki opt-in

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-400 | Kolejka komend `restart_container`: lease/TTL/journal/replay-dedupe | P0 | Backlog | SP-201 | `queue_expires_at = issued_at + 300 s`; `expired` wyłącznie z `queued` nigdy nie claimed; timeout po claimie/starcie → `failed + AMBIGUOUS` (brak auto-requeue); unikalny aktywny per cel + konserwatywny journal (fsync przed exec); podwójne dostarczenie = 1 restart (journal replay); spóźniony wynik idempotentnie jako obserwacja audytowa; dowód: test journal |
| SP-401 | Ręczny restart z UI (ta sama kolejka, audyt, cancel w `queued`) | P0 | Backlog | SP-400 | Cancel tylko w `queued`; każdy restart w `audit_log`; dowód: test cancel + audyt |
| SP-402 | Playbooki opt-in: cooldown/retry cap/weryfikacja/eskalacja | P0 | Backlog | SP-401, SP-301 | Retry tylko `failed + NEGATIVE` w limicie `max_attempts` + cooldown; dowód: test limitów |
| SP-403 | Procedura ambiguous-outcome (brak unsafe retry) + testy | P0 | Backlog | SP-402 | `failed + AMBIGUOUS + result_detail` zapisane; zero auto-retry i zero auto-requeue (test negatywny); spóźniony wynik nie nadpisuje `AMBIGUOUS` na sukces bez weryfikacji; nowa komenda na ten sam cel dopiero po świeżym inventory/weryfikacji albo potwierdzeniu operatora po ostrzeżeniu; dowód: test ambiguous |

Kryteria: podwójne dostarczenie komendy = 1 restart (test journal replay); wynik ambiguous nie retryuje (test); każdy restart w `audit_log`.

### S5 — Dane: rollupy, retencja, PWA offline

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-500 | Rollupy 5-min + jobs retencji + `state_sweeper` | P1 | Backlog | SP-103, SP-301 | Rollup idempotentny po `bucket`; retencja kasuje wg tabeli data-model §4 (audyt tylko procedurą maintenance); dowód: test jobów |
| SP-501 | PWA: manifest/ikony (PNG 192/512 + maskable, SVG opcjonalnie)/standalone, app-shell cache only, read-only offline | P1 | Backlog | SP-104 | Manifest valid; ikony PNG 192/512 obecne; SW cache'uje tylko app-shell (brak odpowiedzi API w cache — test); offline banner + akcje wyłączone; anatomia/stany/klawiatura + zrzuty desktop/mobile w PR; dowód: test SW + zrzuty |
| SP-502 | Powiadomienia in-app (+ opcjonalny webhook); push = future | P1 | Backlog | SP-301 | In-app widoczne dla open/eskalacji; webhook opt-in (test doręczenia); brak obietnic push w UI; dowód: test + zrzut |

### S6 — Hardening i docs bezpieczeństwa

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-600 | Rate-limity, headery, CSRF-final, TLS-docs (Caddy profil), reset hasła CLI | P0 | Backlog | SP-101 | Headery z security §8 obecne (test); CSRF mutacji działa; reset CLI wymaga dostępu do hosta; dowód: testy + docs |
| SP-601 | Backup/restore runbook + test odtwarzania z dumpa | P0 | Backlog | SP-500 | Restore ze świeżego `pgdata` działa (test odtwarzania); RPO/RTO best-effort udokumentowane; dowód: log testu restore |
| SP-602 | Audyt sekretów w logach/cache (grep-test w CI) | P0 | Backlog | SP-105 | Grep-test CI zielony (sekrety/tokeny/Bearery w logach i cache SW); dowód: log CI |

### S7 — OSS / publiczne repo / release

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-700 | Rozbudowa dokumentów OSS: pełne README produktowe + CONTRIBUTING + CODE_OF_CONDUCT + SECURITY.md | P0 | Backlog | SP-008, SP-601 | Dokumenty pełne (rozwinięcie minimalnych z SP-008); linki wewnętrzne działają; dowód: review + link-check |
| SP-701 | Licencja Apache-2.0 — finalne potwierdzenie przez użytkownika (DEC-007) + nagłówki | P0 | Backlog | SP-008 | Publikacja wymaga jawnego potwierdzenia licencji; `LICENSE` (propozycja z SP-008) potwierdzony przez użytkownika; nagłówki w repo; dowód: test licencji w CI |
| SP-702 | CI: testy na PR, multi-arch build, SBOM, cosign (proporcjonalnie) | P0 | Backlog | SP-100 | CI zielone na PR; multi-arch amd64/arm64; SBOM; dowód: log CI + artefakty |
| SP-703 | Release v0.1.0: tag, obrazy, notes, weryfikacja compose od zera | P0 | Backlog | SP-008, SP-106, SP-202, SP-302, SP-403, SP-500, SP-501, SP-502, SP-600, SP-601, SP-602, SP-700, SP-701, SP-702 | Bramki faz S1–S6 zaliczone (testy, PWA shell-only, powiadomienia in-app, hardening, backup/restore, grep-test sekretów); compose od zera działa; dowód: notes + log weryfikacji |
| SP-704 | Końcowa higiena lokalnych plików po release (publikacja wyłącznie jako przyszły krok po potwierdzeniu licencji; ten task niczego nie publikuje) | P1 | Backlog | SP-703 | Linki/licencja/pliki zweryfikowane po release; checklista w PR potwierdza gotowość do ewentualnej publikacji, bez publikowania czegokolwiek przez ten task |

### S8 — AI: fundamenty konfiguracji (bez inferencji)

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-806 | Fundamenty AI: konfiguracja per user (provider/model/autoFree/tryby pracy `approval_required` default), połączenia OpenRouter/OpenAI/custom (OpenAI-compatible) + ChatGPT SIWC, sekrety AES-GCM (`AI_CREDENTIAL_KEY`), test połączeń bez inferencji, rejestrator zdarzeń zużycia (app-side), API `/api/v1/ai/*` | P0 | Done (2026-10-19: migracja `20261019130000_ai`, 17 testów `core/test/ai.test.ts` + 28 modułu ChatGPT zielone; kontrakt `docs/ai-integration-contract.md`; brak inferencji — tryby tylko zapisywane) | — | Kontrakt web zgodny (`settings/connections/capabilities`, DTO `customName`/`customBaseUrl` alias); separacja per user; zero plaintext sekretów w DB/odpowiedziach/logach; `autoFree` → zawsze `openrouter/free`; brak `AI_CREDENTIAL_KEY` = odczyt działa, zapis sekretu wraca `AI_CREDENTIAL_KEY_MISSING`; brak endpointu fałszowania zużycia; callback SIWC strict `GET /auth/callback` |

### S9 — Rebranding: Windup Monitor / wind-up monitor (2026-10-20)

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-807 | Rebranding projektu/repo/aplikacji: projekt+README `Windup Monitor`, slug/repo/pakiety `windup-monitor`, UI i `<title>` dokładnie `wind-up monitor`, agent `windup-monitor-agent`, katalog repo `.../windup-monitor` + symlink zgodności `windup-pilot`, projekt T3 title/root zaktualizowany | P0 | Done (2026-10-20: web 13 plików/115 testów, core lint/typecheck/build + targeted 34/34, Go vet/test 10 pakietów + build; live health 200, login/session i agent `review-demo` online, browser desktop+mobile bez overflow i starej nazwy; zrzuty `.tmp/review/rebrand-*.png`; dowód `docs/iterations/s6-rebrand.md`) | — | Nowa nazwa widoczna w login/nav/title/help/AI; pakiety i lock spójne; Go importy/CLI/unit spójne; DB, cookie, credentiale, sekrety i URL-e runtime bez zmian; stara ścieżka/env działają jako zgodność; brak commit/push/remote |

### S10 — Karty Usług: publiczny status bez rozwijania (2026-10-20)

| ID | Task | Pri. | Status | Dep | Akceptacja (testowalna) |
|---|---|---|---|---|---|
| SP-808 | Karta Usługi (zwinięta): status publicznego URL bez rozwijania (agregat + każdy adres, awaria nie chowa się za drugim), CPU/RAM/dostępność dalej widoczne; pod „Szczegóły" schowane port/ścieżka/kody, dokładne daty (upSince/restart/proces), pokrycie observed/unknown, CRuD publicznych URL-i; podsumowanie publiczne ładowane automatycznie przy montażu (bounded parallel + cache, odświeżanie nie częściej niż 45 s na usługę, brak N+1 co 15 s, bez dublowania requesta przy rozwinięciu) | P1 | Done (2026-10-20: web lint/typecheck zielone, **web 124/124** (9 nowych/zmienionych), build `index-CPNIysux.js`; live 200 po `.tmp/review/start-core.sh`, browser desktop 1440 + mobile 390: Jellyfin „Adres publiczny: odpowiada" na ZWINIĘTEJ karcie, karty bez danych technicznych (348 px vs 1350 px), szczegóły dalej z portem/kodami/datami/historią/CRuD, `aria-expanded` poprawne, bez overflow i `pageerror`; zrzuty `.tmp/review/s5-cards-*.png`; dowód `docs/iterations/s5-service-cards.md`) | SP-304 | Podsumowanie publiczne widoczne bez „Szczegółów"; loading/błąd neutralne (nigdy zielone), brak URL-i → subtelne „nie dodano", 401 → `onSessionExpired`, błąd nie udaje `[]`; 3xx = „Przekierowanie", 401/403 = „wymaga logowania", paused osobno; tooltip to vantage Core; tekst „Dane odświeżają się co 15 sekund" zachowany; brak zmian hosta/enable-pauzy; bez commit/push |

Future (po MVP, nie ruszać): `SP-800` AI BYOM Observer → `SP-801` Operator → `SP-802` Admin (zawsze policy-gated); `SP-803` multi-user; `SP-804` push notifications; `SP-805` HA/multi-Core (Redis).

## 3. Zależności między fazami (mapa)

`S0(Done) → S0b(SP-008, przed S1) → S1 → {S2, S3} → S4 → S5 → S6 → S7`. S0b równolegle do przygotowań S1 (nie blokuje SP-100). S2 i S3 mogą iść równolegle po S1. S4 wymaga obu. DEC-003/DEC-004 potwierdzone najpóźniej przy bramce S1.

## 4. Definition of Done (każdy task implementacyjny)

1. Kod + migracje (addytywne) + testy z sekcji „Testy" fazy — zielone w CI.
2. Dokumentacja zaktualizowana, jeśli task zmienia kontrakt (protokół → bump wersji + oba docs).
3. Brak sekretów w logach/cache (grep-test przechodzi).
4. Review drugiego agenta/człowieka dla S4 i S6 (ryzyko), dla reszty self-review + CI.
5. Dowód w PR: co zmieniono, jak przetestowano (log CI + zrzut/nagranie dla UI), znane ograniczenia.

## 5. Otwarte decyzje (zbiorczo z docs)

DEC-001 brak Redis w MVP · DEC-002 Prisma · DEC-003 interwały 15 s/45 s/5 min (potwierdzić w S1) · DEC-004 retencja 48 h/90 d/1 r (audyt: rola app bez DELETE, purge tylko procedurą maintenance z eksportem) · DEC-005 GitHub Actions · DEC-006 multi-arch od dnia 1 · DEC-007 Apache-2.0 jako PROPOZYCJA (default rekomendowany) do potwierdzenia przez użytkownika przed publikacją (lokalne pliki SP-008, rozbudowa SP-700, finalne potwierdzenie SP-701) · SEC-001 Caddy-profil opcjonalny · SEC-002 brak 2FA w MVP · SEC-003 brak custom headers w checks · DEC-UI-01 ręczne tokeny M3 + własne komponenty (headless primitives dozwolone) · DEC-UI-02 brak dynamic color · DEC-UI-03 brak push w MVP.

### Iteracja usług — przyspieszony wycinek HTTP (bez zmiany ID faz)

| Zakres | Status | Dowód / pozostało |
|---|---|---|
| Discovery /proc + zatwierdzane lokalne HTTP, UI Usługi | Done (2026-10-19: Live wdrożone; Core78/Web53/Go PASS, E2E28/28; `docs/iterations/s2.md`; niezależny review zamknięty w rundzie S4 — ekran Usługi, discovery, publiczne URL-e i ikony obejrzane na `s4r-*.png`/`s4fix-*.png`, 2 findings naprawione, web teraz 113/113 — `s4-integration.md` §8; zdalne CI nadal otwarte → SP-107) |
| SP-300 / SP-301: sondy, progi N/M, minimalna historia incydentów | Partial | Wycinek agentowy; ack/powiadomienia pozostają Backlog |
| SP-302: testy wycinka usług | In progress | Real DB + real Go/HTTP fixture28/28 PASS; ack flow przyszłe, bez remote CI |
| SP-107: produkcyjny Docker smoke | In progress | Obraz83ec6310bf57 + izolowany healthy/auth/assets smoke PASS; remote CI przyszłe |

S2 Docker inventory nie jest ukończony przez ten wycinek. S4 recovery pozostaje Backlog.

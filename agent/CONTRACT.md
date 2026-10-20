# Agent — CONTRACT.md (decyzje kontraktowe S1)

> Właściciel: `agent/**`. Odbiorca: implementacja Core (osobny wykonawca).
> Podstawa: `docs/agent-protocol.md` v1. Ten plik rozstrzyga miejsca, w których
> protokół/dokumenty dopuszczają wiele interpretacji. Agent implementuje
> **bezpieczny minimalny kontrakt S1**: metryki hosta, zero Dockera, zero
> wykonywania komend.

## 1. Capabilities i blok `docker`

- Enroll wysyła `"capabilities": ["metrics"]`. Core NIE MOŻE wysyłać do tego
  agenta `pending_commands` (agent i tak je odrzuca, patrz §6).
- Każdy heartbeat zawiera `"docker": {"present": false}`.
- **Wymaganie do Core:** blok `docker` jest opcjonalny w S1; brak klucza
  `docker` lub `present=false` NIE może skutkować `INVALID_BODY`.

## 2. Koperta heartbeat (jeden POST = jeden `seq`)

- Jeden POST `/heartbeat` niesie dokładnie jedną kopertę (jeden `seq`).
- Nadrabianie zaległości po offline: **max 5 POST-ów na tick**, rosnąco po
  `seq`, **stop na pierwszym błędzie** (in-order, bez wyprzedzania).
- Retry wysyła **bajtowo identyczną** kopertę z outboxu (ten sam `observed_at`,
  te same metryki). Agent nigdy nie regeneruje payloadu dla zajętego `seq`.
- `seq` jest alokowany i zapisywany na dysk (fsync) **przed** wysłaniem.
  Restart nigdy nie cofa licznika: przy starcie `last = max(seq-file,
  max(outbox))`. Luka w `seq` po crashu jest dopuszczalna (Core porządkuje
  po `seq`, luki nie są błędem).
- `observed_at`: RFC3339 UTC z sekundami (`time.RFC3339`), moment pobrania
  próbki. `config_version`: ostatnia znana (start: `0` → Core odpowiada
  `CONFIG_STALE` → agent pobiera `GET /config`).
- `command_results`: `[]` gdy brak; odrzucenia wg §6.

## 3. Semantyka metryk (Linux)

- **CPU** `usage_pct`: delta `/proc/stat` (linia `cpu`), `100*(1-idleΔ/totalΔ)`,
  clamp `[0,100]`. Pierwsza próbka po starcie ma realną deltę dzięki
  500 ms warmupowi. `load1`: 1. pole `/proc/loadavg`.
- **Mem**: `total=MemTotal`, `avail=MemAvailable`, `used=total-avail` (bajty).
  Fallback (jądra bez `MemAvailable`): `avail=MemFree+Buffers+Cached`.
- **Dysk**: zawsze `/`, plus mountpointy z `/proc/mounts` o typie z allowlisty
  `{ext2,ext3,ext4,xfs,btrfs,zfs,f2fs,vfat,exfat,ntfs,ntfs3}`, z pominięciem
  prefiksów `/snap`, `/var/lib/docker`, `/var/lib/kubelet`,
  `/run/containers`, `/run/docker`; tmpfs i pseudo-fs pomijane.
  `total=Blocks*Bsize`, `used=(Blocks-Bfree)*Bsize`, `avail=Bavail*Bsize`.
- **Sieć**: suma liczników wszystkich interfejsów **oprócz `lo`**
  (eth/wlan/tunele/mosty — widok hosta). `rx_bps/tx_bps`: delta/dt między
  próbkami; pierwsza próbka: `0`.
- **Uptime**: `/proc/uptime`, całe sekundy (`uptime_s`).
- Agent nie wysyła `arch/os` w JSON (brak pola w schemacie); tożsamość buildu
  jest w nagłówku `User-Agent: windup-monitor-agent/<ver> (<goos>/<goarch>)`.

## 4. Idempotencja i poison-guard

- `idempotency_key = agent_id:seq` zakłada Core; agent gwarantuje unikalność
  `seq` i identyczność retry.
- `STALE_SEQ` / `INVALID_BODY` → agent **usuwa kopertę** (poison-guard, brak
  pętli) i idzie dalej. Każde inne `4xx/5xx`/błąd transportu → bounded
  backoff (1 s × 2ⁿ + jitter, cap 5 min), kolejka max 20 kopert (ring, FIFO
  drop najstarszych z licznikiem).

## 5. Błędy i zakończenia

- `AGENT_REVOKED` → agent kasuje `credential.json` + `rotation.json`, log
  (bez sekretu), **exit 3**, brak retry tym sekretem.
- `BAD_CREDENTIAL` (heartbeat) → backoff retry; po 10 kolejnych: stop
  z błędem, pliki ZACHOWANE (exit 1, `awaiting_repair` po stronie operatora).
- `UPGRADE_REQUIRED` → stop, exit 2.
- `CONFIG_STALE` → `GET /api/v1/agent/config`, zapis `config_version`
  + `heartbeat_interval_s` (clamp 5 s…1 h), potwierdzenie w następnym
  heartbeat. `full_inventory=true` → log (brak Dockera w S1, nic do wysłania).
- Drift `|server_time − observed_at| > 60 s` → ostrzeżenie w logu (NTP),
  bez wpływu na `seq`.

## 6. Komendy (S1: brak wykonywania)

- S1 nie wykonuje niczego. Każda `pending_commands` → w następnym heartbeat
  wpis `command_results`: `state=rejected`, `outcome=null` (JSON null,
  kanoniczne NULL), `result_detail="UNSUPPORTED_COMMAND_TYPE: S1 agent
  supports metrics only, type=<type>"`, `idempotency_key` = klucz serwera
  (fallback: `command_id`), `completed_at` = teraz (RFC3339).
- Journal wykonania (`journal.jsonl`) **nie istnieje w S1** — powstaje
  w S4 razem z obsługą `restart_container` (wtedy też dual-accept / replay).
  Mapowanie Core: `rejected` + brak wyniku → brak retry tej komendy.

## 7. Rotacja (klient gotowy; wyzwalacz: podkomenda `rotate`)

- Sekret `next`: 256-bit RNG, base64url bez paddingu (43 znaki).
- `rotation_id`: `rot_` + 26-znakowy ULID Crockford (48-bit ms + 80-bit RNG).
- Kolejność: zapis `rotation.json` (0600, fsync) → `POST /rotate` (Bearer
  bieżący; po `401 BAD_CREDENTIAL` jedna próba Bearerem `next`, dual-accept)
  → `POST /rotate_confirm` (Bearer `next`) → promocja lokalna → kasowanie
  `rotation.json`.
- Retry (`rotate` ponownie) **nie generuje** nowego sekretu: używa zapisanego
  `rotation_id + next`. `409 ROTATION_CONFLICT` → stop z komunikatem
  (rozwiązanie po stronie operatora / re-enroll przy utracie obu sekretów).
- Throttling rotacji (max 5/dobę) egzekwuje Core.

## 8. Transport i sekrety

- Tylko HTTPS. HTTP wyłącznie z flagą `--allow-insecure-http` **i** hostem
  loopback (`127.0.0.0/8`, `::1`, `localhost`); każda inna kombinacja to
  twardy błąd startu. `InsecureSkipVerify` nigdy nie jest włączane.
- Dodatkowe CA: `--ca-file` (PEM, dopinane do systemowego poola).
- Timeouty: enroll/rotate/config 15 s; heartbeat 45 s (toleruje held
  response / long-poll do ~25 s). Brak pinowania odcisku certyfikatu
  (`tls_fingerprint` z security §6 = future, odnotowane bez implementacji).
- Token enroll: env `WINDUP_MONITOR_ENROLL_TOKEN` (preferowane) > stdin
  (`--enroll-token-stdin`, pierwsza linia) > flaga `--enroll-token`
  (ostrzeżenie: widoczny w `ps`) > plik JSON (0600). Nigdy w logach,
  nigdy w URL, nigdy w `audit_log` (po stronie Core).
- Nagłówki każdego żądania: `Agent-Protocol-Version: 1`, `Accept` +
  `Content-Type: application/json`. Heartbeat/config/rotate ponadto
  `X-Agent-ID` i `Authorization: Bearer` (enroll: brak Bearera).

## 9. Pliki stanu (`0600`, katalog `0700`)

`credential.json {agent_id, credential}`, `rotation.json
{rotation_id, next_credential}`, `seq` (liczba + `\n`), `state.json
{config_version, heartbeat_interval_s}`, `outbox/<20-cyfrowy seq>.json`.
Zapis: plik tymczasowy + `chmod 0600` + fsync + rename + fsync katalogu.

## 10. Znane ograniczenia S1 (nie usterki)

- Brak metryk per-proces/kontener (S2), brak checks/incydentów/recovery.
- CPU/sieć liczone względem poprzedniej próbki — restart agenta zeruje
  baseline (pierwsza próbka: `rx_bps=0`, CPU z warmupu).
- Kontenery/namespace'y sieciowe: brak rozróżnienia (suma hosta bez `lo`).
- Plik konfiguracyjny: JSON (stdlib, zero zależności), nie YAML.

## 11. Service discovery + HTTP checks (iteracja usług, v1 ADDITIVE)

> Agent implementuje swoją połowę wspólnego kontraktu iteracji usług.
> Klucze wire (`service_discovery`, `service_results`, `service_checks`,
> `capabilities` w heartbeat) są ustalone z Core i Web — NIE zmieniaj ich
> samodzielnie.

- **Capabilities:** enroll i każdy heartbeat wysyłają
  `["metrics", "service_discovery", "http_checks"]` (tylko te wartości
  allowlisty). Stare Core ignoruje nieznane klucze; nowy agent wymaga Core
  ze wsparciem usług (w przeciwnym razie `INVALID_BODY` → poison-drop
  koperty — wdrożenie koordynuje integrator, bez restartu na żywo tutaj).
- **Heartbeat:** `service_discovery {observed_at, complete, candidates[]}`
  (max 64) + `service_results[]` (max 64 na kopertę). Koperta ≤ 256 KB
  (przy przepełnieniu wyniki są ścinane, metryki + discovery zostają).
  Dedup/idempotencja po `seq` obejmuje wyniki i discovery atomowo —
  retry wysyła bajtowo identyczną kopertę z outboxu.
- **Discovery:** czysty Go (`os.ReadFile` na `/proc/net/tcp,tcp6` LISTEN +
  mapowanie fd własnego uid, `comm`/`stat`/`exe`). Bez `exec.Command`,
  shella, socketa Dockera, skanowania globalnego, env i pełnego cmdline.
  Jedyny odczyt cmdline to wąski parser argumentów
  `-host-port/-container-port` procesów `docker-proxy` (lokalnie, nigdy
  na wire). Jedyny fetch HTTP to fingerprint Jellyfin
  (`GET 127.0.0.1:8096/System/Info/Public`, cap 64 KB, tylko dla już
  słuchającego 8096 na IPv4).
  - Ograniczenie IPv4: sondy zawsze biją w `127.0.0.1`, więc monitorowalne
    HTTP są TYLKO bindy IPv4 `127.0.0.1`/`0.0.0.0`. Bindy LAN-owe i całe
    IPv6 (wildcard `::` nie dowodzi dual-stack) widać jako
    `tcp`/unmonitorable bez sugestii HTTP — nigdy fałszywego `down`.
    Przy kilku bindach jednego portu tożsamość wygrywa bind eligible.
  - `candidate_id` = `kind-port` (stabilne między restartami; port
    przejęty przez inną aplikację dostaje inne ID).
  - Jellyfin (root, fd denied): `comm jellyfin` + `docker-proxy 8096→8096`
    → `medium`, `source docker-proxy`/`proc-comm`, bez gwarancji pid
    match; `process_started_at` z `stat` wówczas to evidence runtime.
  - T3 (`exe==t3`, np. `comm node-MainThread`): `high`, `/` → `[200]`.
  - OpenCode (`comm`/`exe opencode[.exe]`): `high`, label `OpenCode`
    (nigdy nie nazywamy każdej instancji opencode "T3"), `/` → `[200,401]`
    (brama auth odpowiada 401 — to też sygnał "up").
  - Nieznane: `Nierozpoznana usługa`, `tcp`, `low`, bez sugestii HTTP
    (bazy/sshd/DNS nie trafiają do monitoringu HTTP domyślnie).
  - `complete=false` przy niepełnym odczycie `/proc` — Core NIE usuwa
    znanych kandydatów po niepełnym snapshocie. Discovery: start + co 60 s.
  - **Generic discovery (v2, ADDITIVE 2026-10-19):** rozpoznane presety
    (Jellyfin/T3/OpenCode) zachowują `kind`, nazwy i ID `<kind>-<port>`.
    Każda inna usługa dostaje `kind=unknown` i stabilne ID `generic-<port>`
    (nie `unknown-<port>`) — bez claimu marki, ale z nazwą z lokalnych
    metadanych właściciela (łańcuch dowodów, pierwsze trafienie):
    `name_source=package-json` (wrapper Node: exe/comm w allowliście
    node|nodejs → nearest `package.json` „name" z cwd lub katalogu skryptu
    z argv[1]; max 64 KiB na plik, dir + max 3 rodziców, max 2 katalogi
    startowe, nigdy globalny walk) → `exe` (basename `/proc/<pid>/exe`,
    pomijany dla interpreterów typu node/sh/java/python*) → `comm` →
    `systemd` (unit z `/proc/<pid>/cgroup` bez D-Bus) → `container`
    (czytelny token scope'a kontenera; same id 12/64-hex NIE są nazwą) →
    `fallback` (etykieta `Usługa na porcie N`). Nazwy są sanityzowane
    (bez znaków kontrolnych, max 64 rune'ów); argv/env/cwd/ścieżki nigdy
    nie opuszczają hosta. Bez fd-proven ownera (fd denied, ambiguicja
    różnych binariów) → port label + `confidence=low`; nazwany z jednego
    dowodzonego ownera → `medium`, `source=proc`; zgadzające się
    współdzielone sockety (np. worker'y) zachowują nazwę, ale nigdy
    pid/timing. Brak czytelnego `/proc/<pid>/cgroup` nie jest error.
    Metryki procesu (`service_process_metrics`): kandydat `generic-*` z
    jednoznacznym fd-proven właścicielem (PID+starttime z exact ownera,
    nigdy proxy/heurystyka) jest próbkowany jak rozpoznane kindy;
    ambiguicja (wiele pid) i brak atrybucji zostają null — Core usuwa
    własny guard `kind in (known)` przy zgodnym `candidate_id`.
  - **`monitorable`:** `true` WYŁĄCZNIE dla bindów IPv4 `127.0.0.1`/
    `0.0.0.0`; bindy LAN i całe IPv6 (także `::1`) → `false` — Core nie
    może przypisywać im checków; agent i tak odmawia (INVALID_CHECK, bez
    sieci), więc unsupported bind nigdy nie da fałszywego `down` ani fake
    healthy. `name_source` jest nullable (opcjonalne); stary Core ignoruje
    oba pola.
  - **`transport` w `service_checks`:** `http` (domyślny przy braku
    klucza — pełna wsteczna zgodność) albo `tcp`. TCP = jeden bounded
    connect do `127.0.0.1:<port>` (numerically, bez DNS, bez payloadu,
    bez odczytu); sukces → `ok=true`, `status_code=null`,
    `error_code=null`; refused/reset → `SERVICE_UNAVAILABLE`, timeout →
    `TIMEOUT`. Check przypisany do nieodkrytego portu/zmanipulowanego
    candidate_id → `SERVICE_UNAVAILABLE` bez sieci; nieznany `transport`
    → `INVALID_CHECK`.
- **Sondy:** wykonuje je pula w tle (4 workery, kolejka 64, jeden
  przebieg checka naraz) — tick heartbeat nigdy na nie nie czeka, więc
  wolne checki nie zatrzymują metryk ani nie fałszują offline hosta.
  Tick podpina tylko GOTOWE wyniki (max 64); wynik znika z bufora dopiero
  gdy koperta z nim jest trwale zapisana (brak zgubień przy błędzie
  `seq`/store, brak duplikatów). Bufor wyników: max 128 (ring).
  Wykonanie na `127.0.0.1` + dokładny port kandydata, ścieżka względna
  (`/` na początku, bez `//`, URL-i, `@`, kontroli; max 512). Redirecty wyłączone, proxy wyłączone, brak
  cookies/auth/nagłówków, body nieczytane i nielogowane (wyjątek: ograniczony fingerprint discovery).
  Timeout 1–10 s (default 5, zawsze < interwału), interwał 15–3600 s
  (default 30); discovery odświeża się w tle (max 1 przebieg, co 60 s),
  tick podpina cache'owany snapshot.
  Zniknięty kandydat → `SERVICE_UNAVAILABLE`
  (nie `down` usługi przy offline agenta — brak próbek to `unknown`).
  Zmiana `config_revision` wymienia zestaw atomowo (reset harmonogramu,
  brak wyników ze starej rewizji); brak klucza `service_checks` (starszy
  Core) zostawia zapisany zestaw, jawne `null`/`[]` czyszczą go atomowo
  (persist + scheduler); zestaw persistuje w
  `service_checks.json` (0600) i wraca po restarcie + bezpieczny refresh
  `/config` przy starcie.

# Protokół Agent ↔ Core (v1)

> Wersja protokołu: **1**. Nagłówek każdej odpowiedzi/żądania agenta: `Agent-Protocol-Version: 1`.
> Zmiana niekompatybilna → bump wersji + migracja równoległa (Core akceptuje v1 i v2 przez 1 release).
> Powiązane: [architecture.md](architecture.md) §4, [data-model.md](data-model.md) §2–§5, [security.md](security.md) §5–§6.
>
> Status implementacji: **v1 zaimplementowany w S1 (2026-10-19)** — enroll,
> heartbeat (`seq` + idempotencja), config, rotate/rotate_confirm, revoke.
> Dowód: [iterations/s1.md](iterations/s1.md). Bloki `docker` i
> `command_results` są przyjmowane i ignorowane w S1 (pełne znaczenie
> w fazach S2/S4).

## 0. Zasady transportu

- Tylko **HTTPS** (w LAN dopuszczony HTTP wyłącznie z explicit `insecure_lan: true` w configu agenta + ostrzeżenie w logu; default: TLS).
- Tylko agent dzwoni do Core (outbound-only). Core nigdy nie łączy się z agentem.
- Wszystkie body: `application/json`, UTF-8. Czas: ISO-8601 UTC (`observed_at`). Idempotentność przez klucze (niżej).
- Uwierzytelnianie: `Authorization: Bearer <credential>` + `X-Agent-ID`. Enroll (jedyny endpoint bez Bearera) używa one-time tokenu.

## 1. Enroll / pairing

**UI → operator:** Core generuje `enroll_token` (256-bit, base64url, TTL 15 min, single-use). Token konsumowany atomowo wyłącznie po pomyślnym enrollment (transakcja: `UPDATE enroll_tokens … WHERE used_at IS NULL` + utworzenie agenta); nieudana próba tokenu nie pali (licznik prób + rate-limit: max 10 prób / 10 min / IP, potem `429 RATE_LIMITED`).

```http
POST /api/v1/agent/enroll
{ "enroll_token": "…", "hostname": "nas-01", "agent_version": "0.1.0",
  "protocol_version": 1, "capabilities": ["metrics", "docker", "restart"] }
```

Odpowiedź `201`:

```json
{ "agent_id": "ag_01J…", "credential": "<SECRET — pokazany RAZ>",
  "heartbeat_interval_s": 15, "config_version": 7 }
```

- Core przechowuje wyłącznie **hash** credentialu (argon2id). `credential` nigdy nie wraca w API.
- Agent zapisuje `agent_id + credential` z modem `0600`.

## 2. Rotacja i revokacja credentiali (schema: data-model §1 `agents.credential_hash + credential_hash_next + credential_overlap_until + rotation_id + last_rotation_id`)

- **Zasada utraty odpowiedzi (kanoniczna):** sekret `next` generuje **agent** (kryptograficzny RNG, 256-bit, base64url) i zapisuje atomowo lokalnie z modem `0600` **PRZED** wysłaniem `POST /api/v1/agent/rotate` (osobny plik `credential.next` + `rotation_id`, fsync katalogu; stary plik credentialu nietknięty do czasu promocji). Core dostaje `next` w plaintext wyłącznie po TLS w body `POST /rotate` i przechowuje **wyłącznie hash** (argon2id); plaintext nigdy nie wraca w API, nigdy w heartbeat, nigdy w logach ani w `audit_log.detail` (audit notuje wyłącznie `agent_id + rotation_id + timestamps + result code`).
- **Żądania (jawne endpointy, nigdy w heartbeat):**
  ```http
  POST /api/v1/agent/rotate
  Authorization: Bearer <STARY credential>   # akceptowany też Bearer <NEXT> po zapisaniu pending (dual-accept, niżej)
  X-Agent-ID: ag_01J…
  { "rotation_id": "rot_01J…", "new_credential": "<SECRET — raz, wygenerowany przez agenta>" }
  ```
  Odpowiedź `200 { "overlap_until": "…", "rotation_id": "rot_01J…" }` — bez zwracania sekretu. `rotation_id` generuje agent (ULID/`rot_` + ULID, unikalny per operacja); retry MUSI odczytać ten sam `rotation_id + next` z pliku lokalnego, NIE generować nowego sekretu.
  - Retry z tym samym `rotation_id` i tym samym `next` (hash zgodny z `credential_hash_next`) → `200` idempotentnie, bez nadpisywania `pending` i bez przesuwania `overlap_until`.
  - Żądanie z innym `next` gdy `pending` istnieje (`rotation_id` zajęte, `credential_hash_next IS NOT NULL`) → `409 ROTATION_CONFLICT` (agent nie nadpisuje; kontynuuje z zapisanym lokalnie `next`).
  - Brak `pending` na Core (request nigdy nie dotarł — stary sekret nadal jedynym ważnym): retry z zapisanym `rotation_id + next` tworzy `pending` normalnie (`200`). Agent po zapisie lokalnym próbuje `next`, a po `401 BAD_CREDENTIAL` wraca do starego **w granicach timeoutu operacji** (retry nie generuje nowego sekretu i nie nadpisuje `pending` cudzym `next`).
  - Rate-limit rotacji: max 5/dobę/agent (liczone po utworzonych `pending`, nie po retry idempotentnym).
- **Potwierdzenie:** `POST /api/v1/agent/rotate_confirm { "rotation_id": "rot_01J…" }` z `Bearer <NEXT sekret>` → Core atomowo (jedna transakcja): weryfikuje Bearer przeciw `credential_hash_next` + zgodność `rotation_id`, kopiuje `next → credential_hash`, czyści `credential_hash_next/overlap_until/rotation_id`, ustawia `last_rotation_id = rotation_id`. Odpowiedź `200`. Powtórzony `confirm` po utraconej odpowiedzi (ten sam `rotation_id == last_rotation_id`, Bearer zgodny z bieżącym `credential_hash`) → `200` idempotentnie, bez zmiany stanu.
- **Deadline bez confirm:** o `overlap_until` job `state_sweeper` atomowo promuje `next → credential_hash` (ten sam efekt co confirm), czyści pola rotacji, ustawia `last_rotation_id`; stary sekret jest od tej chwili odrzucany (`401`). Agent zachował `next` lokalnie przed `/rotate`, więc po deadline przechodzi na `next` bez re-enroll. Do `overlap_until` Core akceptuje **oba sekrety** (dual-accept) dla heartbeat/ingest/wyników komend — rotacja NIE blokuje metryk.
- **Revokacja:** natychmiastowa, bez overlap: UI `POST /api/v1/agents/:id/revoke` (session auth) czyści **oba** hashe (`credential_hash + credential_hash_next`) i wszystkie pola rotacji (`status=revoked`, `revoked_at=now`). Bearer stary i nowy → `401 AGENT_REVOKED`. Agent po 401 z `code=AGENT_REVOKED` kasuje pliki credentialu lokalnie i przechodzi w `awaiting_repair` (log + exit code, bez loopu retry z tym samym sekretem).
- **Compromise procedure:** revoke → nowy enroll token → re-enroll. Każdy krok w audit logu (bez plaintext). **Re-enroll wymagany wyłącznie przy utracie OBU sekretów** (bieżącego i zapisanego `next`); utrata samego `next` przed confirm = kontynuacja na starym + nowa operacja z nowym `rotation_id`; utrata starego po zapisaniu `next` = confirm/promocja na `next`.

## 3. Heartbeat + batch metryk

```http
POST /api/v1/agent/heartbeat
Authorization: Bearer <credential>
X-Agent-ID: ag_01J…
{
  "seq": 1842,
  "observed_at": "2026-10-19T12:00:15Z",
  "config_version": 7,
  "metrics": {
    "cpu": { "usage_pct": 23.4, "load1": 0.8 },
    "mem": { "total_b": 836..., "used_b": 412..., "avail_b": 423... },
    "disk": [ { "mount": "/", "total_b": 1…, "used_b": 4…, "avail_b": 5… } ],
    "net": { "rx_b": 1…, "tx_b": 2…, "rx_bps": 1234.0, "tx_bps": 567.0 },
    "uptime_s": 864001
  },
  "docker": {
    "present": true,
    "containers": [
      { "id": "sha256:abc…", "name": "plex", "image": "plex:1.2",
        "state": "running", "started_at": "…", "restart_count": 0,
        "cpu_pct": 4.2, "mem_used_b": 3…, "mem_limit_b": 8… }
    ]
  },
  "command_results": [ { "command_id": "cmd_…", "state": "succeeded", "outcome": "OK",
    "result_detail": "restart ok in 1.8s", "completed_at": "…", "idempotency_key": "…" } ]
}
```

Odpowiedź `200` (heartbeat + komendy w jednym RTT):

```json
{ "server_time": "…", "config_version": 7, "config_changed": false,
  "pending_commands": [
    { "command_id": "cmd_…", "type": "restart_container",
      "params": { "container_id": "sha256:abc…" },
      "issued_at": "…", "queue_expires_at": "…", "lease_s": 120, "idempotency_key": "…" } ],
  "full_inventory": false }
```

Limity: body ≤ 256 KB; > 200 kontenerów → agent wysyła skrót (top-N po CPU/RAM + liczniki stanów; pełna lista na żądanie `full_inventory: true` w odpowiedzi heartbeat — następny heartbeat MUSI zawierać pełny `docker.containers` + `docker.snapshot_at`).

### 3a. Endpoint konfiguracji (kanoniczny cel `CONFIG_STALE`)

`GET /api/v1/agent/config` (Bearer credential + `X-Agent-ID`) → `200 { "config_version": 7, "heartbeat_interval_s": 15, "queue_ttl_s": 300, "lease_s": 120, "result_ttl_s": 600 }`. Kod `CONFIG_STALE` w odpowiedzi heartbeat oznacza: agent MA pobrać ten endpoint (a nie zgadywać), zaktualizować `config_version` i potwierdzić w następnym heartbeat. Brak innych ukrytych endpointów konfiguracyjnych.

### 3b. Snapshoty Docker: czas, `late`, zakaz nadpisywania nowszego starszym

Każdy blok `docker` w heartbeat zawiera `snapshot_at` (czas obserwacji na agencie, ISO-8601 UTC). Próbki starsze niż 10 min (`now − snapshot_at > 10 min`) Core przyjmuje z `late=true` (widoczne w UI jako wiek danych, nie wskrzeszają incydentów). Reguła overwrite: Core ignoruje snapshot, gdy `seq ≤ last_seq` LUB `snapshot_at < last_snapshot_at` dla tego agenta (odpowiedź `STALE_SEQ` / `STALE_SNAPSHOT` bez zapisu). Pełny `full_inventory` po powrocie z offline nie cofa `restart_count` ani `state` nowszych niż snapshot.

## 4. Metryki: idempotencja, kolejność, zegary, backpressure

- **`seq` monotoniczny per agent** (persist w `/var/lib/windup-monitor/seq`). Core odrzuca `seq ≤ last_seq` z `code=STALE_SEQ` (agent nie cofa licznika; po reinstalacji enroll od nowa).
- **Idempotencja batchy:** `idempotency_key = agent_id:seq`. Retry tego samego `seq` nie duplikuje próbek (`ON CONFLICT DO NOTHING`).
- **Zegary:** Core NIE ufa `observed_at` do porządkowania — porządkuje po `seq`; `observed_at` służy diagnostyce (drift = `server_time − observed_at`, alert przy > 60 s). Serwer stempluje `received_at`.
- **Batching/backpressure:** agent buforuje do 20 batchy na dysku (ring). Po offline wysyła zaległe rosnąco po `seq`, max 5 batchy/heartbeat. Starsze niż 10 min próbki `docker`/metryk są przyjmowane, ale oznaczane `late=true` (nie wskrzeszają incydentów).
- **Walidacja:** zakresy (`0 ≤ pct ≤ 100`, `used ≤ total`), odrzucenie całości batcha przy błędzie kształtu (`400 INVALID_BODY`, agent loguje i idzie dalej — brak poison-pill retry).

## 5. Heartbeat, stale, offline

| Stan agenta | Warunek (defaulty DEC-003, do potwierdzenia) |
|---|---|
| `online` | heartbeat ≤ 45 s temu |
| `stale` | 45 s – 5 min (UI pokazuje ostatnie znane dane + wiek) |
| `offline` | > 5 min (incydent `agent_offline` tylko jeśli agent ma `notify_on_offline=true`) |
| `revoked` / `pending` | terminalne/administracyjne (patrz data-model §5) |

Po powrocie z offline agent MUSI wysłać `resync` (pełny inventory docker + `seq` kontynuowany). Core nie ekstrapoluje luk — wykresy pokazują przerwę.

## 6. Kolejka komend: scoped, typed, polling, TTL, replay, dedupe, journal

- **Typy MVP:** wyłącznie `restart_container {container_id}`. Brak shellexec — celowo (security §6). Nieznany `type` agent odrzuca: `rejected {reason: UNKNOWN_TYPE}`.
- **Polling:** agent pyta co heartbeat; `pending_commands` to lease: `lease_s=120` (kanonicznie z data-model §1) — agent musi rozpocząć wykonanie przed końcem lease i raportować wynik w ≤ `result_ttl_s=600`.
- **Stany komendy (kanoniczne, identyczne z data-model §5):** `queued → claimed → running → succeeded | failed`; `queued → expired | cancelled` (wyłącznie z `queued`); `queued/claimed → rejected` (agent odrzuca nieznany typ). **Brak przejścia `claimed/running → expired`** — timeout po claimie/ starcie to NIE `expired` (patrz wygasanie niżej). Kanoniczne pola wyniku: `outcome` + `result_detail` (diagram i dozwolone przejścia: data-model §5). Kanonika `outcome`: `state='succeeded' → outcome='OK'`; `state='failed' → outcome ∈ {'NEGATIVE','AMBIGUOUS'}`; wszystkie pozostałe stany (`queued/claimed/running/expired/cancelled/rejected`) → `outcome IS NULL`. Walidowane CHECK w DB i w aplikacji; przykłady w §3 i §7 używają `result_detail` (nigdy samo `detail`).
- **Replay/dedupe:** każda komenda ma `idempotency_key = command_id`. Agent trzyma **persistent conservative execution journal** (`/var/lib/windup-monitor/journal.jsonl`, fsync): przed wykonaniem restartu zapisuje `started {command_id, container_id, at}`; wykonuje restart TYLKO jeśli journal nie zawiera `started` dla tego `command_id`; po restarcie dopisuje wynik. Po restarcie systemu odtwarza stan z journala i raportuje `succeeded/failed` zamiast wykonywać ponownie. Podwójne dostarczenie tej samej komendy → odpowiedź z cache journala, bez drugiego restartu. **Unikalność aktywnych:** Core dopuszcza co najwyżej jedną komendę aktywną (`queued/claimed/running`) per cel — `(agent_id, params.container_id)` z częściowym UNIQUE w DB + odmowa `409 COMMAND_CONFLICT` w aplikacji; nowa komenda na ten sam cel po `succeeded/failed(NEGATIVE)` wymaga zakończenia poprzedniej, a po `failed(AMBIGUOUS)` — dodatkowo ścieżki weryfikacyjnej z §7.
- **Wygasanie (`expired` WYŁĄCZNIE z `queued`, nigdy z `claimed/running`):** `queued` z `now > queue_expires_at` (`issued_at + queue_ttl_s`, kanonicznie 300 s) → `expired` przez job DB (`state_sweeper`). Agent, który dostanie `pending_commands` po `queue_expires_at`, MUSI odmówić startu z `rejected {reason: COMMAND_EXPIRED}` (lub lokalnie `expired`) i nie wykonywać restartu. Kod `COMMAND_EXPIRED` dotyczy wyłącznie odmowy startu `queued` po deadline — **nie blokuje zapisu spóźnionej obserwacji** (niżej).
- **Timeout po claimie/starcie (`claimed/running` bez wyniku):** lease `lease_s=120` (agent musi przejść `claimed → running` i rozpocząć wykonanie przed końcem lease) oraz wynik w ≤ `result_ttl_s=600`. Przekroczenie lease bez `running`, brak wyniku po `result_ttl_s`, albo crash agenta po potencjalnym wykonaniu bez potwierdzenia → Core zapisuje `state='failed' + outcome='AMBIGUOUS' + result_detail` (incydent weryfikacyjny) i NIGDY nie robi automatycznego requeue ani auto-retry tej komendy. Spóźniony wynik ze zgodnym `command_id + agent_id` po terminalnym `failed(AMBIGUOUS)` jest przyjmowany idempotentnie (`ON CONFLICT DO NOTHING` po `idempotency_key`) wyłącznie jako dodatkowa obserwacja audytowa (`audit_log` + dopisek do `result_detail` historią, bez nadpisywania terminalnego `AMBIGUOUS` na pewny sukces bez weryfikacji z §7), nie wznawia retry, nie uruchamia komendy ponownie.
- **Anulowanie:** operator może `cancel` tylko w stanie `queued`.

## 7. Niejednoznaczny wynik restartu (bez unsafe retry — trwały zakaz)

Przypadki: agent wysłał restart, ale stracił obserwowalność (daemon timeout, container zniknął z listy, host reboot w trakcie, przekroczony lease/`result_ttl_s` bez wyniku, crash po potencjalnym wykonaniu bez potwierdzenia). Obowiązuje procedura:

1. Agent raportuje `state=failed`, `outcome=AMBIGUOUS`, `result_detail` (co dokładnie zaobserwowano; patrz schema `commands.outcome/result_detail` w data-model §1). `outcome='AMBIGUOUS'` występuje wyłącznie z `state='failed'` (kanonika z §6).
2. Core zapisuje komendę jako `failed + outcome=AMBIGUOUS` (terminalnie) i NIGDY nie planuje automatycznego retry ani requeue tej komendy (trwały zakaz unsafe retry; nowa próba wyłącznie jako nowa komenda z nowym `command_id` po ścieżce z pkt 4).
3. Następny discovery z pełnym inventory i/lub zgodny wynik spóźniony (`command_id + agent_id` zgodne) rozstrzygają wyłącznie jako obserwacje: kontener `running` z nowym `started_at` → weryfikacja sukcesu (incydent może iść do `resolved` po health checks, ale terminalne `failed + AMBIGUOUS` tej komendy NIE jest nadpisywane na `succeeded/OK` bez tej weryfikacji); spóźniony wynik przyjmowany idempotentnie jako dopisek audytowy, bez wznawiania retry i bez ponownego uruchamiania komendy.
4. Przed NOWĄ komendą na ten sam cel (`agent_id + container_id`) z nierozstrzygniętym `AMBIGUOUS` wymagane jest: świeże inventory (discovery `state/started_at/restart_count`) LUB weryfikacja HTTP/health check, LUB jawne potwierdzenie operatora po ostrzeżeniu w UI („poprzedni restart nierozstrzygnięty — ryzyko podwójnego restartu"). Ścieżka ta dostępna jest wyłącznie przy normalnej polityce backendu i lokalnej allowliście (`container_id` pełnoformatowo z ostatniego discovery, brak restartów „na nazwę z palca", brak `exec/create/run` — security §4).
5. Playbook retry dotyczy wyłącznie wyników **jednoznacznie negatywnych** (`failed + outcome=NEGATIVE` przy zachowanej obserwowalności) i w limicie `max_attempts` + `cooldown`.

## 8. Wersjonowanie i kompatybilność

- Nagłówek `Agent-Protocol-Version: 1` + pole `protocol_version` w enroll.
- Pola unknown w JSON: ignorowane (forward-compat po stronie czytelnika); pola usuwane tylko w nowej wersji major protokołu.
- `capabilities[]` pozwala Core nie wysyłać komend typu, którego agent nie deklaruje (np. agent bez Dockera: `["metrics"]`).

## 9. Kody błędów (kanoniczne)

`INVALID_BODY, STALE_SEQ, STALE_SNAPSHOT, BAD_CREDENTIAL, AGENT_REVOKED, UNKNOWN_COMMAND_TYPE, COMMAND_EXPIRED (odmowa startu `queued` po `queue_expires_at`; nie blokuje zapisu spóźnionej obserwacji idempotentnie, §6), ROTATION_CONFLICT (inny `next` przy istniejącym `pending` rotacji, §2), COMMAND_CONFLICT (druga aktywna komenda na ten sam cel, §6), RATE_LIMITED, CONFIG_STALE (→ agent pobiera GET /api/v1/agent/config, §3a), UPGRADE_REQUIRED (protocol major mismatch)`.

## Iteracja usług (addytywne v1, implementacja 2026-10-19)

Dokładne klucze i ograniczenia: `agent/CONTRACT.md` §11. Heartbeat dodaje
`capabilities`, `service_discovery {observed_at,complete,candidates}` oraz
`service_results`. Limit koperty 256 KiB, do 64 kandydatów i 64 wyników.
Wspólna transakcja i blokada agenta obejmują seq, metryki, discovery i wyniki.
Stary seq nie zapisuje niczego; starszy snapshot nie nadpisuje nowego.
Wynik musi należeć do agenta, aktywnego checka i dokładnej rewizji.
Przyszłe evidence ponad 30 s jest odrzucane atomowo; przyszłe przedziały
nie są naliczane do dostępności. Heartbeat aktualizuje allowlistowane caps
istniejących agentów bez ponownego enrollmentu.

`GET /agent/config` zwraca `service_checks` wyłącznie własnego agenta:
`check_id,config_revision,candidate_id,port,path,expected_statuses,interval_s,
timeout_s,enabled`. Mutacje zwiększają config_version. Agent utrwala zestaw,
odświeża przy starcie i CONFIG_STALE; jawne null/[] czyści zestaw. Czterech
workerów wykonuje sondy w tle, bez blokowania heartbeat; wyniki trafiają do
trwałej koperty przed usunięciem z bufora.

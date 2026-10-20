# Model danych

> Powiązane: [agent-protocol.md](agent-protocol.md) (v1), [security.md](security.md) (sekrety, audyt), [architecture.md](architecture.md) (retencja defaulty).
> Konwencje: `id` = `text` (`ag_`/`chk_`/`inc_`/`cmd_` + ULID); czas UTC `timestamptz`; pieniądze nie występują. Wszystkie statusy to kanoniczne enumy — te same stringi w API, DB i UI.
>
> Status implementacji: **podzbiór S1 zaimplementowany (2026-10-19)** — `users`,
> `bootstrap_state`, `sessions`, `enroll_tokens`, `agents`, `metric_samples`,
> `disk_samples`, `audit_log`. Tabele checks/incydentów/kolejek komend należą
> do faz S3/S4 (nie istnieją w schemacie S1). Dowód: [iterations/s1.md](iterations/s1.md).

## 1. Tabele (MVP)

### `users` (single-user, wiersz dokładnie 1 po bootstrapie)
| kolumna | typ | uwagi |
|---|---|---|
| `id` | text PK | `usr_…` |
| `password_hash` | text | argon2id |
| `created_at` | timestamptz | |

### `sessions`
| kolumna | typ | uwagi |
|---|---|---|
| `id` | text PK | losowe 256-bit, cookie `__Host-sp_session` |
| `user_id` | text FK → users | `ON DELETE CASCADE` |
| `created_at`, `expires_at` | timestamptz | TTL 30 dni, sliding 7 dni |
| `ip_hash`, `user_agent_hash` | text | detekcja przejęcia (ostrzeżenie, nie hard-block w LAN) |

UNIQUE (`id`). INDEX (`user_id`, `expires_at`).

### `agents`
| kolumna | typ | uwagi |
|---|---|---|
| `id` | text PK (`ag_…`) | |
| `name` | text UNIQUE | np. `nas-01` |
| `credential_hash` | text NULL | NULL = `pending`/`revoked` bez sekretu; aktywny sekret |
| `credential_hash_next` | text NULL | nowy sekret w trakcie rotacji (overlap); NULL poza rotacją; hash sekretu wygenerowanego przez agenta, przesłanego raz po TLS (agent-protocol §2) |
| `credential_overlap_until` | timestamptz NULL | do kiedy stary sekret pozostaje ważny (max +10 min od rotacji); NULL poza rotacją; po deadline job atomowo promuje `next` (nawet bez confirm) |
| `rotation_id` | text NULL | identyfikator bieżącej operacji rotacji (`rot_` + ULID, generowany przez agenta); NULL poza rotacją; retry z tym samym `rotation_id` + tym samym `next` = idempotentne `200`, inny `next` przy pending = `409 ROTATION_CONFLICT` |
| `last_rotation_id` | text NULL | identyfikator ostatnio potwierdzonej/promowanej rotacji; powtórzony `rotate_confirm` z tym samym id i Bearer zgodnym z bieżącym sekretem = idempotentne `200` |
| `status` | enum | `pending, online, stale, offline, revoked` — liczony z `last_seen_at`, nie tylko kolumna (kolumna = cache) |
| `capabilities` | text[] | `metrics, docker, restart` |
| `agent_version`, `protocol_version` | text/int | |
| `config_version` | int | |
| `last_seen_at`, `last_seq` | timestamptz/bigint | |
| `notify_on_offline` | bool default true | |
| `created_at`, `revoked_at` | timestamptz | |

### `enroll_tokens`
`token_hash` UNIQUE, `expires_at`, `used_at NULL`, `label`. CHECK (`expires_at > created_at`). Job: purge zużytych/wygasłych. Token konsumowany atomowo (single-use) wyłącznie po pomyślnym enrollment (`UPDATE … WHERE used_at IS NULL` w tej samej transakcji co utworzenie agenta); nieudana próba nie pali tokenu (licznik prób + rate-limit, patrz agent-protocol §1).

### `bootstrap_state` (dokładnie 1 wiersz `id=1`; stan pierwszego uruchomienia)

| kolumna | typ | uwagi |
|---|---|---|
| `id` | int PK CHECK (`id = 1`) | singleton |
| `token_hash` | text NULL | hash jednorazowego tokenu bootstrap; NULL po zużyciu |
| `expires_at` | timestamptz NULL | TTL 30 min od utworzenia; NULL po zużyciu |
| `used_at` | timestamptz NULL | NULL = tryb bootstrap aktywny; NOT NULL = bootstrap zakończony na zawsze |
| `created_at` | timestamptz | |

Reguły: dokładnie jeden wiersz; unikalny admin (`users` ma ≤ 1 wiersz dopóki `used_at IS NULL`; bootstrap tworzy pierwszego użytkownika atomowo `UPDATE … WHERE used_at IS NULL`). Sekret bootstrap nigdy nie trafia do zbiorczych logów (patrz security §2: stdout pierwszego startu lub plik lokalny `0600`, bez zapisu do agregowanych logów).

### `metric_samples` (surowe, retencja 48 h — DEC-004)
`(agent_id, seq)` UNIQUE — idempotencja retry (agent-protocol §4). CHECK na zakresy (`cpu 0–100`, `used ≤ total` — walidowane też w aplikacji).
INDEX BRIN (`received_at`) — append-only szereg czasowy.

| kolumna | typ |
|---|---|
| `agent_id` FK, `seq` bigint, `idempotency_key` text UNIQUE |
| `observed_at`, `received_at` timestamptz, `late` bool |
| `cpu_pct`, `load1`, `mem_used_b`, `mem_total_b`, `uptime_s` |
| `net_rx_b`, `net_tx_b` (liczniki monotoniczne; bps liczone w aplikacji) |

### `disk_samples`
`(agent_id, seq, mount)` UNIQUE. Kolumny: `mount, total_b, used_b`.

### `docker_containers` (ostatni znany stan per agent+container)
`(agent_id, container_id)` UNIQUE. `name, image, state (running/exited/paused/restarting/removing/dead/unknown), started_at, restart_count, cpu_pct, mem_used_b, mem_limit_b, seen_seq, updated_at`.

### `docker_history` (append-only zmiany stanu; retencja 1 r)
INDEX (`agent_id`, `observed_at`). Zapis tylko przy zmianie `state` lub `restart_count`.

### `metric_rollups_5m` (retencja 90 d)
`(agent_id, bucket)` UNIQUE (`bucket` = start 5-min). `avg_cpu, max_cpu, avg_mem_used, max_mem_used, rx_delta, tx_delta, samples`.

### `http_checks` (definicje)
`id (chk_…)` PK, `name UNIQUE`, `url`, `interval_s` (default 60), `timeout_s` (default 10), `failure_threshold` (default 3), `success_threshold` (default 2), `expected_status` (default 200), `allow_lan` bool default false, `enabled` bool, CHECK (`timeout_s < interval_s`).

### `http_check_results` (retencja 48 h)
`(check_id, checked_at)` UNIQUE. `ok bool, status_code NULL, latency_ms NULL, error NULL (sanitized — bez nagłówków/cookies)`.

### `incidents`
`id (inc_…)` PK. `source` enum (`http_check, agent_offline, docker, manual`). `ref_id` (check/agent/kontener). `state` enum (§5). `opened_at, acked_at, resolved_at`. `summary`. INDEX (`state`, `opened_at`).

### `commands` (kolejka; retencja 1 r)
`id (cmd_…)` PK. `agent_id` FK. `type` enum (`restart_container` — MVP tylko ten). `params` jsonb (`{container_id}`). `state` enum (§5). `outcome` text NULL (kanonika: `succeeded → 'OK'`; `failed → 'NEGATIVE' | 'AMBIGUOUS'`; `queued/claimed/running/expired/cancelled/rejected → NULL`; CHECK w DB + walidacja aplikacji; patrz §5 i agent-protocol §6–§7). `result_detail` text NULL (co dokładnie zaobserwowano; sanitowane, bez sekretów; wymagane przy `failed`, zalecane przy `succeeded`). `idempotency_key UNIQUE (=id)`. `issued_at, queue_expires_at (= issued_at + queue_ttl_s, kanonicznie 300 s), lease_s (kanonicznie 120), claimed_at, result_ttl_s (kanonicznie 600), completed_at`. `attempt_of` (link do poprzedniej próby), `playbook_run_id NULL`. INDEX (`agent_id`, `state`, `issued_at`). Częściowy UNIQUE aktywnych per cel: `UNIQUE (agent_id, (params->>'container_id')) WHERE state IN ('queued','claimed','running')` (jeden aktywny restart per kontener; nowa komenda na ten sam cel po `failed + AMBIGUOUS` wyłącznie ścieżką weryfikacyjną z agent-protocol §7; aplikacyjnie `409 COMMAND_CONFLICT`).

Kanoniczna konfiguracja kolejek (jedno miejsce, powielana bez zmian w agent-protocol §6): `queue_ttl_s=300` (`queued` → `expired` gdy `now > queue_expires_at`; `expired` wyłącznie z `queued` nigdy nie claimed/nigdy nie wystartowane), `lease_s=120` (start `claimed → running` przed końcem lease), `result_ttl_s=600` (brak wyniku po `claimed/running` w TTL → terminalne `failed + outcome='AMBIGUOUS'` + incydent weryfikacyjny; brak auto-requeue/auto-retry; spóźniony wynik o zgodnym `command_id + agent_id` przyjmowany idempotentnie wyłącznie jako dodatkowa obserwacja audytowa bez nadpisywania `AMBIGUOUS` na pewny sukces).

### `playbooks` / `playbook_runs`
Definicja: `id, name UNIQUE, enabled, trigger (incident_source), max_attempts (default 2), cooldown_s (default 300), verify_check_id NULL`. Run: `id, playbook_id, incident_id, state (running/cooldown/succeeded/escalated), attempts, audit → audit_log`.

### `audit_log` (append-only dla roli aplikacyjnej; retencja 1 rok z eksportem)
`id, at, actor (user/agent_id/system), action, target, detail jsonb (sanitized)`. INDEX (`at`, `actor`). Rola aplikacyjna Core ma wyłącznie `INSERT + SELECT` (brak `UPDATE/DELETE` — egzekwowane uprawnieniami roli + review; brak operacji modyfikujących w kodzie). Purge po 1 roku wyłącznie przez udokumentowaną procedurę maintenance (osobna rola, kroki: eksport do pliku → weryfikacja → `DELETE`; każdy purge odnotowany w odrębnym logu operacyjnym, nie w samej tabeli). Bez wyjątków „cichego" kasowania z aplikacji.

## 2. Relacje i integralność

- `agents ← metric_samples/disk_samples/docker_*` (`ON DELETE CASCADE` — usunięcie agenta czyści dane; celowa decyzja, odnotowana w UI).
- `http_checks ← http_check_results/incidents(ref)`.
- `incidents ← playbook_runs ← commands.attempt_of` (łańcuch prób).
- CHECK: `commands.type = 'restart_container'` na MVP (twardy mur w DB + walidacja aplikacji — nowy typ wymaga migracji).

## 3. Indeksy krytyczne (MVP)

- `metric_samples (agent_id, received_at DESC)`, BRIN na `received_at` (retencja/purge).
- `commands (agent_id, state) WHERE state='queued'` (polling bez seq-scan).
- `incidents (state) WHERE state IN ('open','acknowledged')` (dashboard).

## 4. Retencja i jobs DB (poglądowo; implementacja w slice S5)

| Dane | Polityka | Job |
|---|---|---|
| `metric_samples`, `disk_samples`, `http_check_results` | DELETE > 48 h | `retention_raw` co 1 h |
| `metric_rollups_5m` | DELETE > 90 d | `retention_rollups` co 6 h |
| `incidents`, `docker_history`, `commands` | 1 rok, potem purge | `retention_long` co 24 h |
| `audit_log` | 1 rok, potem eksport do pliku + purge wyłącznie procedurą maintenance (rola app bez DELETE) | `retention_long` co 24 h (eksport → weryfikacja → purge) |
| rollup | `rollup_5m` co 5 min z `metric_samples` | — |
| eskalacje/stale/offline | `state_sweeper` co 30 s (claim komend `SKIP LOCKED`, `stale/offline`, `expired`) | — |

## 5. Maszyny stanów (kanoniczne — identyczne w API/UI/kanbanie)

**Agent:** `pending → online ⇄ stale ⇄ offline → online …`; `* → revoked` (terminalny; powrót tylko przez re-enroll).

**HTTP check:** `ok ⇄ down`, `unknown` (brak danych). MVP nie ma stanu `degraded` dla latency (pole `latency_ms` w `http_check_results` jest wyświetlane, ale bez progu — próg latency wymagałby kompletnej definicji: próg + okno + agregacja, co jest odłożone na future). Dla kontenerów MVP: `running / not-running / unknown` (bez `degraded`).

**Incident:** `open → acknowledged → resolved`; `resolved` jest terminalny (reopen = nowy incydent z linkiem). Timeout ack: brak (single-user).

**Command:** `queued → claimed → running → succeeded | failed`; `queued → expired | cancelled` (`expired` wyłącznie z `queued` nigdy nie claimed / nigdy nie wystartowane, po `queue_expires_at`); `queued/claimed → rejected` (agent odrzuca nieznany typ; po `queue_expires_at` z powodem `COMMAND_EXPIRED` bez wykonywania). **Brak przejścia `claimed/running → expired`.** Timeout po claimie/starcie (przekroczony lease, brak wyniku w `result_ttl_s`, crash po potencjalnym wykonaniu bez potwierdzenia) to kanonicznie terminalne `state='failed' + outcome='AMBIGUOUS' + result_detail` (nigdy osobny stan ani `unknown`, nigdy `expired`) → trwały zakaz automatycznego retry i requeue (agent-protocol §6–§7). Spóźniony wynik o zgodnym `command_id + agent_id` po terminalnym `AMBIGUOUS` przyjmowany idempotentnie wyłącznie jako dodatkowa obserwacja audytowa (bez wznawiania retry, bez ponownego uruchamiania, bez nadpisywania `AMBIGUOUS` na pewny sukces bez weryfikacji). Nowa komenda na ten sam cel z nierozstrzygniętym `AMBIGUOUS` wyłącznie po świeżym inventory/weryfikacji HTTP albo jawnym potwierdzeniu operatora po ostrzeżeniu, przy normalnej polityce backendu i lokalnej allowliście. Wynik niejednoznaczny to kanonicznie `state='failed' + outcome='AMBIGUOUS' + result_detail` → trwały zakaz automatycznego retry (agent-protocol §7). Retry playbooka dotyczy wyłącznie `failed + outcome='NEGATIVE'` (jednoznaczna porażka przy zachowanej obserwowalności). Kanonika `outcome`: `succeeded → 'OK'`; `failed → 'NEGATIVE' | 'AMBIGUOUS'`; pozostałe stany → `NULL`.

## 6. Współbieżność i locking

- Claim komendy: `SELECT … FOR UPDATE SKIP LOCKED` w transakcji; jeden claimer; przed claimem aplikacja sprawdza częściowy UNIQUE aktywnych per cel (`queued/claimed/running` per `agent_id + container_id`) i odrzuca drugą aktywną `409 COMMAND_CONFLICT`. Agent wykonuje restart wyłącznie po konserwatywnym zapisie `started` do journala (fsync przed exec; replay z journala zamiast ponownego restartu — agent-protocol §6).
- Ingest: `ON CONFLICT (agent_id, seq) DO NOTHING` — retry bezpieczny.
- Scheduler HTTP checks: wiersz-blokada per check (`locked_by, locked_until`) albo advisory lock; na MVP single-Core wystarczy advisory lock + `state_sweeper` w jednej transakcji.
- Rollup: idempotentny po `bucket` (`ON CONFLICT DO UPDATE`).

## 7. Migracje

Prisma; reguła MVP: migracje wyłącznie addytywne (nowa tabela/kolumna NULL-able). Destrukcyjne wymagają osobnego planu + backupu. Seed: brak (bootstrap przez UI).

## Iteracja usług — tabele addytywne

Migracja `20261019100000_services` dodaje `discovered_services`, `services`,
`service_results`, `service_incidents` oraz watermark discovery agenta.
Unikalność `(agent_id,candidate_id)` zapobiega podwójnemu monitoringowi;
check_id to UUID protokołu. Wyniki są deduplikowane przez agent/check/czas,
seq dodatkowo deduplikuje całą kopertę. Historia jest trwała. Jeden otwarty
incydent na usługę wymusza częściowy indeks unikalny.

`config_revision` chroni przed wynikami starego celu; `horizon_at` zaczyna
nowy okres pomiaru po zmianie celu lub wznowieniu. Procent to ważone czasem
ukończone przedziały, bez prognozowania przyszłości; observed/unknown
pokazują pokrycie. `up_since` oznacza zaobserwowaną serię sukcesów, a
`process_started_at` osobny, opcjonalny dowód procesu. Minimalne incydenty
nie implementują jeszcze workflow ack ani recovery.

## Iteracja AI — tabele addytywne (2026-10-19)

Migracja `20261019130000_ai`. Trzy tabele per user (`users` CASCADE), brak
tabel inferencji — slice zapisuje wyłącznie konfigurację i zużycie aplikacji.

| Tabela | Klucz | Zawartość |
|---|---|---|
| `ai_settings` | `user_id` (PK, FK users) | `provider` (`AiProvider`: openrouter/openai/chatgpt/custom, NULL = brak), `model`, `auto_free`, `execution_mode` (`AiExecutionMode`, DEFAULT `approval_required`), `custom_name`, `base_url` (custom, jawne) |
| `ai_credentials` | `(user_id, provider)` | `ciphertext` (AES-256-GCM `v1.<b64url(iv‖tag‖ct)>`, plaintext = JSON; API-key: `{apiKey}`, chatgpt: obiekt tokenów SIWC), `key_hint` (maska `abcd…wxyz`), `last_checked_at` |
| `ai_usage_events` | `id` (ULID `aiu_…`) | `provider`, `model`, `kind`, `input_tokens`, `output_tokens`, `cost_usd`, `occurred_at`; indeks `(user_id, occurred_at DESC)` |

`ai_credentials.ciphertext` nigdy nie zawiera plaintextu; `key_hint` to
wyłącznie maskowany ślad do UI. `ai_usage_events` zapisuje tylko aplikacja
(rejestrator wewnętrzny, brak endpointu klienckiego) — panel zużycia pokazuje
`null`/`0`, gdy brak danych. `ai_settings.base_url` jest jawny (to adres, nie
sekret) i przeszedł walidację SSRF (http/https, bez userinfo/query/hash,
blokada metadanych chmury/link-local).

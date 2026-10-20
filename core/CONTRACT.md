# Core API contract — slice S1

> Właściciel: `core/**`. Odbiorcy: `web/**` (UI API) i `agent/**` (protokół v1).
> Podstawa: `docs/agent-protocol.md`, `docs/data-model.md`, `docs/security.md`
> oraz kontrakty `agent/CONTRACT.md` i klient `web/src/api/client.ts`.
> Ten plik **nie zmienia** protokołu — dokumentuje rozstrzygnięcia miejsc
> niejednoznacznych i kilka dodatków koniecznych do działania S1.

## 1. Koperta błędów

Każdy błąd API to JSON `{ "code": "<KOD>", "message": "<opis>" }` z kodem HTTP.
Agent traktuje **każde non-2xx** jako błąd i czyta `code` (patrz
`agent/internal/client/client.go`), dlatego kody protokołu są zwracane jako
non-2xx:

| Sytuacja | HTTP | `code` |
|---|---|---|
| zły kształt/zakresy body | 400 | `INVALID_BODY` |
| brak/zły Bearer, nieznany agent | 401 | `BAD_CREDENTIAL` |
| agent unieważniony | 401 | `AGENT_REVOKED` |
| `seq <= last_seq` | 409 | `STALE_SEQ` |
| konflikt rotacji | 409 | `ROTATION_CONFLICT` |
| rate limit | 429 | `RATE_LIMITED` (+ `Retry-After`) |
| major protokołu > 1 | 426 | `UPGRADE_REQUIRED` |
| brak sesji UI | 401 | `UNAUTHENTICATED` |
| brak/zły CSRF | 403 | `CSRF_INVALID` |
| obcy Origin/Referer | 403 | `ORIGIN_NOT_ALLOWED` |
| duplikat hostname przy enroll | 409 | `NAME_TAKEN` (dodatek S1) |
| bootstrap już wykonany | 409 | `ALREADY_INITIALIZED` |
| zły/wygasły token bootstrap | 401 | `INVALID_BOOTSTRAP_TOKEN` |

`CONFIG_STALE` **nie jest błędem HTTP**: heartbeat odpowiada `200` z
`config_changed: true` oraz (dla zgodności z docs) `code: "CONFIG_STALE"`.
Agent reaguje na `config_changed` i pobiera `GET /api/v1/agent/config`.

## 2. UI API (cookie session + CSRF)

Cookie: `__Host-sp_session` gdy `COOKIE_SECURE=true` (wymóg prefiksu
`__Host-`: Secure, Path=/, bez Domain); w lokalnym HTTP `sp_session`.
`HttpOnly`, `SameSite=Lax`, TTL 30 dni (sliding przy <7 dniach, cap 30 dni).

Mutacje sesyjne wymagają nagłówka `X-CSRF-Token` równego tokenowi z
`GET /api/v1/auth/me` oraz — gdy przeglądarka go wysyła — zgodnego
`Origin`/`Referer` (same-origin lub `ALLOWED_ORIGINS`).

| Metoda + ścieżka | Body | Odpowiedź |
|---|---|---|
| `GET /api/v1/auth/status` | — | `{ initialized: boolean }` |
| `POST /api/v1/auth/bootstrap` | `{token,email,password}` | `201 {user:{email},csrfToken}` + cookie sesji |
| `POST /api/v1/auth/login` | `{email,password}` | `200 {user:{email},csrfToken}` + cookie sesji |
| `GET /api/v1/auth/me` | — | `200 {user:{email},csrfToken}` |
| `POST /api/v1/auth/logout` | — | `204` |
| `GET /api/v1/agents` | — | `{agents:[AgentSummary]}` |
| `GET /api/v1/agents/:id/metrics?limit=` | — | `{samples:[MetricSample]}` |
| `POST /api/v1/agents/pairing-tokens` | `{label?}` | `201 {token,expiresAt}` |
| `POST /api/v1/agents/:id/revoke` | — | `200 {id,status:"revoked"}` |

```ts
type AgentSummary = {
  id: string; hostname: string;             // hostname = agents.name w DB
  status: "pending"|"online"|"stale"|"offline"|"revoked";
  lastSeenAt: string | null;
  metrics: null | {
    cpuPercent: number | null;
    memoryUsedBytes: number; memoryTotalBytes: number;
    diskUsedBytes: number;   diskTotalBytes: number;   // suma mountów
    uptimeSeconds: number;
    networkRxBytes: number;  networkTxBytes: number;
  };
};
type MetricSample = {
  sampledAt: string;                        // = observed_at agenta
  cpuPercent: number | null;
  memoryUsedBytes: number; memoryTotalBytes: number;
  diskUsedBytes: number;   diskTotalBytes: number;
  uptimeSeconds: number; networkRxBytes: number; networkTxBytes: number;
  late: boolean; receivedAt: string;        // dodatkowe pola diagnostyczne
};
```

`limit` domyślnie 100, twardy cap 500; próbki rosnąco po `seq`.
`lastSeenAt` to czas serwera (`received_at` heartbeat), nie zegar agenta.

### Rozstrzygnięcia / dodatki S1

1. **`users.email`** — `docs/data-model.md` nie wymieniał e-maila, ale kontrakt
   UI (`/auth/bootstrap`, `/auth/login`, `/auth/me`) go wymaga. Kolumna
   `email` (UNIQUE) jest addytywna; singleton użytkownika wymusza unikalny
   indeks wyrażeniowy `users ((1))`.
2. **`hostname` ↔ `agents.name`** — enroll zapisuje `hostname` do istniejącej
   kolumny `agents.name` (UNIQUE); UI dostaje `hostname`.
3. **`NAME_TAKEN`** — nowy kod dla duplikatu hostname przy enroll. Token
   enrollmentu **nie jest** wtedy zużywany (retry z innym hostname działa).
4. **Dysk w UI** — `diskUsedBytes`/`diskTotalBytes` to suma wszystkich
   mountów z najnowszej próbki. Szczegóły per mount są w DB
   (`disk_samples`).
5. **Rate limity** są in-memory (jedna instancja Core, MVP): login
   5/5 min/IP (+ wykładniczy backoff przy dalszych próbach), bootstrap
   10/10 min/IP, enroll 10/10 min/IP, rotacja 5/24 h/agent. Restart zeruje
   liczniki — ograniczenie udokumentowane w README.
6. **Sesja/CSRF** — token CSRF = `HMAC-SHA256(SESSION_SECRET, "csrf:"+session_id)`;
   brak osobnej kolumny i brak double-submit cookie.
7. **Bootstrap** ustawia sesję od razu (Web wywołuje `fetchMe()` po sukcesie).
8. **Health** — `GET /api/v1/health` to liveness; `GET /api/v1/health/ready`
   sprawdza `SELECT 1` i zwraca `503` przy niedostępnej DB.
9. **Brak komend/Dockera w S1** — `pending_commands` zawsze `[]`,
   `full_inventory` zawsze `false`; blok `docker` w heartbeat jest
   przyjmowany i ignorowany (agent wysyła `{present:false}`).

## 3. Protokół agenta (v1, bez zmian)

Prefiks `/api/v1/agent`, nagłówki `Agent-Protocol-Version: 1`,
`Authorization: Bearer`, `X-Agent-ID` (poza enroll). Body ≤ 256 KB.

| Metoda + ścieżka | Odpowiedź |
|---|---|
| `POST /enroll` | `201 {agent_id, credential, heartbeat_interval_s, config_version}` |
| `POST /heartbeat` | `200 {server_time, config_version, config_changed, pending_commands:[], full_inventory:false}` (+ `code:"CONFIG_STALE"` gdy zmiana) |
| `GET /config` | `200 {config_version, heartbeat_interval_s, queue_ttl_s:300, lease_s:120, result_ttl_s:600}` |
| `POST /rotate` | `200 {overlap_until, rotation_id}` |
| `POST /rotate_confirm` | `200 {ok:true}` |

Ingest: jedna transakcja `ReadCommitted` + `SELECT … FOR UPDATE` na wierszu
agenta; `seq` musi być `> last_seq` (persistowane w `agents.last_seq`).
`metric_samples`/`disk_samples` mają UNIQUE `(agent_id, seq[, mount])` i
`ON CONFLICT DO NOTHING`. Stary batch nigdy nie nadpisuje nowszego.

Rotacja (SP-105, opcjonalna w S1, zaimplementowana): dual-accept obecnego i
`next` do `overlap_until`; retry `rotation_id + next` jest idempotentny; inny
`next` przy pending → `409 ROTATION_CONFLICT`; po deadline `next` jest
promowany leniwie przy pierwszym żądaniu (brak joba `state_sweeper` w S1);
`rotate_confirm` promuje natychmiast; revoke czyści oba hashe bez overlap.
Promocja po deadline zachodzi także wtedy, gdy pierwsze żądanie używa starego
lub błędnego Bearera: promocja jest zatwierdzana, a stary sekret dostaje `401`.

Auth weryfikuje Argon2 poza blokadą i przenosi wewnętrznie dokładny zweryfikowany
hash. Rotacja, confirm i ingest ponownie porównują ten hash z aktualnymi hashami,
statusem, `revoked_at` i deadline pod tą samą blokadą wiersza, w transakcji zapisu.
Revoke również blokuje ten wiersz. `ReadCommitted` po uzyskaniu blokady widzi
ostatni zatwierdzony stan; wszystkie te operacje szeregują się per agent bez
błędów serializacji wymagających ponowienia transakcji. Autoryzacja sprzed
confirm/deadline nie uprawnia starego sekretu do zapisu, a revokacja jest terminalna.
Argon2 dla retry rotacji działa poza blokadą; tylko gdy równoległe żądanie właśnie
utworzyło identyczny `rotation_id`, nowo zaobserwowany hash jest sprawdzany pod
blokadą. Retry `rotate` dla już zakończonego `last_rotation_id` zwraca
`409 ROTATION_CONFLICT` bez odtworzenia pending; retry `rotate_confirm` z aktualnym
credentialem i tym samym ID nadal zwraca `200`.

## 4. Czego S1 nie zawiera

Docker discovery, HTTP checks, incydenty, kolejka komend/recovery, rollupy,
retencja, PWA service worker, AI, multi-user. `commands`/`incidents` nie
istnieją w schemacie S1 (migracje są addytywne w kolejnych slice'ach).

## 5. Iteracja usług — addytywny v1 (2026-10-19)

S1 powyżej jest historycznym zakresem slice'a. Obecny Core obsługuje
`service_discovery`, `service_results`, heartbeat capabilities oraz własne
`service_checks` w konfiguracji; dokładny wire: `agent/CONTRACT.md` §11.
Discovery/wyniki/metryki zapisują się atomowo pod istniejącą blokadą agenta
oraz dedup seq. config_version agenta i config_revision checka są różnymi
licznikami i nie muszą być równe. Obcy check, stara rewizja i disabled
check nie zapisują wyników; odrzucenie jest audytowane.

Sesyjne API: GET/POST `/services`, GET `/services/discovered`,
PATCH/DELETE `/services/:id`, GET `/services/:id/history?limit=100` (cap500).
POST zatwierdza istniejący available candidate, port pochodzi z discovery.
PATCH dopuszcza name/path/expectedStatuses/intervalSeconds/timeoutSeconds/
failureThreshold/successThreshold/enabled. POST/PATCH mają ścisły schemat.
Summary zawiera również failureThreshold, successThreshold i agentStatus;
pełne typy: `src/services/service.ts`. Minimalne incydenty N/M są trwałe,
bez ack/notifications/recovery. Dostępność to ukończone zmierzone przedziały,
minimum dwie próbki, gap >2×interval i cały silent tail są unknown.

## 6. Iteracja S4 — generyczne discovery, TCP, publiczne URL-e (2026-10-19)

Addytywne do §5; wire dla agenta: `.tmp/generic-agent-v2-handoff.md`.

- **Bez katalogu usług:** `kind` to bezpieczna etykieta `^[a-z0-9][a-z0-9-]{0,31}$`
  (nie zamknięty enum); `source` zostaje istniejącym enumem. `kind: "unknown"`
  nie oznacza „niemonitorowalne".
- **`service_discovery.candidates[]`:** opcjonalne `monitorable: boolean` i
  `name_source: exe|comm|package-json|systemd|container|fallback|fingerprint`.
  Brak `monitorable` = stara inferencja (HTTP z jawnym `suggested_path` lub
  znanym kind). Kandydat generyczny: `candidate_id = generic-<port>`.
- **`Service.transport`:** `http` (domyślnie, legacy) albo `tcp`. TCP nie ma
  ścieżki ani kodów HTTP (`path = ""`, `expected_statuses = []`). Tworzenie
  akceptuje kandydata `monitorable`, także `kind: unknown`.
- **`GET /config.service_checks[]`:** nowe pole `transport` (domyślnie `http`
  dla starego agenta). Checki TCP wysyłamy wyłącznie agentowi z capability
  `tcp_checks` (allowlista capability rozszerzona). Wynik TCP: `status_code`
  `null`, `ok` z samego połączenia.
- **Restart procesu:** zmiana `process_started_at` u monitorowanej usługi
  ustawia `last_restart_at`, zeruje `up_since`/streaki i wraca do `unknown`
  do pierwszego zdrowego pomiaru; `last_restart_at` jest osobny od `upSince`.
- **`degraded` (pochodny):** usługa `up` z `consecutiveFailures > 0` jest
  raportowana jako `degraded` — ostatni pomiar nieudany, próg awarii
  nieosiągnięty; UI nie pokazuje wtedy `up`. Brak danych/stary `lastCheckedAt`
  nadal `unknown`.
- **Public endpoints:** `GET/POST /services/:serviceId/public-endpoints`,
  `GET/PATCH/DELETE /public-endpoints/:id`, `GET …/history` (sesja + CSRF/Origin
  dla mutacji). Tylko `https://`, port 443, brak userinfo/fragmentów/literałów
  IP; świeży DNS + pin IP per sonda (SNI/host zweryfikowanego certu), brak
  proxy/redirect-follow, deadline 8 s, max 5 URL-usługę, unikalność
  `(serviceId, url)`. Sonda 2xx/3xx/401/403 = „odpowiada" (`up`; 3xx →
  `errorCode REDIRECT`, 401/403 → `AUTH_REQUIRED`), tylko błąd transportu/5xx
  = `down`. Zmiana URL/pauza czyści stary wynik. Copy UI mówi o odpowiedzi
  z serwera wind-up monitor, nigdy o dostępności z całego internetu.

## 6. Iteracja AI — addytywny v1 (2026-10-19)

Fundamenty konfiguracji AI **bez inferencji**. Pełny kontrakt:
`docs/ai-integration-contract.md`. Ścieżki pod `/api/v1/ai/*` (sesja + CSRF
mutacji jak §2): GET/PUT `settings`, PUT/DELETE `connections/:provider`
(`openrouter`/`openai`/`custom`), POST `connections/:provider/test`, GET
`usage`, ChatGPT `chatgpt/login|status|logout` + root `GET /auth/callback`
(strict ścieżka SIWC — tylko port może się zmieniać; alias API
`/api/v1/ai/chatgpt/callback` zostaje dla zgodności).

Sekrety (klucze API, tokeny SIWC) leżą w `ai_credentials` wyłącznie jako blob
AES-256-GCM z osobnego klucza `AI_CREDENTIAL_KEY`; w odpowiedziach i logach
tylko maskowany `keyHint`. Brak klucza: odczyt ustawień działa, zapis sekretu
zwraca `AI_CREDENTIAL_KEY_MISSING`. `autoFree=true` + openrouter rozstrzyga
model na `openrouter/free` (bez płatnego fallbacku). `executionMode` DEFAULT
`approval_required` — tryby pracy są tylko zapisywane, niczego nie uruchamiają.
`GET /usage` pokazuje wyłącznie zdarzenia tej aplikacji (`ai_usage_events`,
rejestrator wewnętrzny); brak danych = `requests: 0`, metryki `null`; brak
endpointu dopisującego zużycie. Custom provider (OpenAI-compatible) waliduje
base URL po stronie serwera (http/https, bez userinfo/query/hash, blokada
cloud-metadata/link-local/multicast, DNS check przed wywołaniem, bez
podążania za redirectami z credentialem); test = `GET {baseUrl}/models` bez
inferencji. `DELETE connections/custom` = pełne rozłączenie: credential +
`baseUrl`/`customName` + dezaktywacja aktywnego providera (`executionMode`
zachowany).

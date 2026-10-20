# AI integration — kontrakt backendu (fundamenty AI)

> Właściciel: `core/**` (backend fundamentów AI). Odbiorcy: `web/**` (panel AI)
> oraz wykonawca modułu ChatGPT (`core/src/ai/chatgpt.ts`).
> Stan: **obowiązuje**. Ten plik jest źródłem prawdy dla kształtu API AI;
> frontend go czyta zamiast własnych DTO.
>
> Ścieżki logiczne z ustaleń (`/api/ai/...`) są realizowane pod istniejącym
> prefiksem projektu: **finalne URL-e to `/api/v1/ai/...`**. Nie istnieje
> osobny alias `/api/ai`.

## 0. Zakres (jasne ograniczenia)

Wdrożone teraz:

- konfiguracja AI per user (provider, model, tryb pracy, custom provider),
- połączenia z dostawcami: klucz API OpenRouter, klucz API OpenAI, klucz API
  custom (OpenAI-compatible) oraz ChatGPT (login/abonament, osobny provider),
- szyfrowane przechowywanie sekretów (AES-256-GCM, osobny klucz
  `AI_CREDENTIAL_KEY`),
- test połączenia do dostawcy (bez inferencji),
- rejestrator zdarzeń zużycia i panel zużycia **wyłącznie app-side**,
- tryby pracy zapisywane, domyślny `approval_required`.

Czego **nie** ma (celowo, bez obietnic na teraz):

- **żadnej inferencji** (żadnych wywołań completions/chat ani działań agenta);
  zapisywanie konfiguracji niczego nie uruchamia ani nie naprawia,
- natywnych, niezgodnych z OpenAI formatów API — custom provider to **wyłącznie
  profil OpenAI-compatible** (`{baseUrl}/models`, w przyszłości
  `{baseUrl}/chat/completions`); nie obiecujemy obsługi dowolnych natywnych API,
- wywołań z przeglądarki do dostawcy — **klucz API nigdy nie opuszcza
  serwera**; web wysyła klucz wyłącznie do backendu (PUT connections), backend
  sam kontaktuje się z dostawcą (brak frontend proxy),
- pełnego zużycia rozliczeniowego dostawcy: pokazujemy tylko zdarzenia tej
  aplikacji. ChatGPT (SIWC) **nie ma API pozostałego limitu** — panel zużycia
  jest app-side,
- walidacji modeli wobec katalogu dostawcy (model jest polem ręcznym/tekstowym).

## 1. Sesja, CSRF, wzorzec błędów

Wszystkie endpointy wymagają sesji UI (`requireAuth`), mutacje dodatkowo
standardowego CSRF projektu (`X-CSRF-Token` + `requireOrigin`), dokładnie jak
`core/CONTRACT.md` §2. Koperta błędów: `{ "code", "message" }`.

| Sytuacja | HTTP | `code` |
|---|---|---|
| zły kształt/zakres body, zły URL, konflikt pól | 400 | `INVALID_BODY` |
| brak sesji | 401 | `UNAUTHENTICATED` |
| brak/zły CSRF | 403 | `CSRF_INVALID` |
| obcy Origin/Referer | 403 | `ORIGIN_NOT_ALLOWED` |
| zapis sekretu bez `AI_CREDENTIAL_KEY` | 500 | `AI_CREDENTIAL_KEY_MISSING` |
| endpointy ChatGPT, gdy moduł niedostępny | 503 | `CHATGPT_UNAVAILABLE` |
| błąd wewnętrzny | 500 | `INTERNAL` |

`AI_CREDENTIAL_KEY_MISSING` ma czytelny komunikat konfiguracyjny, np.
`AI_CREDENTIAL_KEY is not configured; cannot store credentials`. Brak klucza
**nie** blokuje odczytu ustawień ani zapisu trybów pracy (nie są sekretami).

## 2. DTO wspólne

```ts
type AiProvider = 'openrouter' | 'openai' | 'chatgpt' | 'custom';
type AiExecutionMode = 'monitor_only' | 'approval_required' | 'autonomous';

type AiSettings = {
  provider: AiProvider | null;
  model: string | null;
  autoFree: boolean;                    // domyślnie false
  executionMode: AiExecutionMode;       // domyślnie 'approval_required'
  customName: string | null;            // nazwa własnego dostawcy (custom)
  baseUrl: string | null;               // base URL dostawcy custom
  customBaseUrl: string | null;         // alias DTO (web/src/api/ai.ts) = baseUrl
};

type AiConnection = {
  provider: AiProvider;
  connected: boolean;
  keyHint: string | null;               // zamaskowany ślad klucza, nigdy klucz
  lastCheckedAt: string | null;         // ISO-8601, null = nie testowano
};

type AiCapabilities = {
  credentialStorage: boolean;           // AI_CREDENTIAL_KEY skonfigurowane
  chatgpt: boolean;                     // moduł ChatGPT dostępny
  chatgptReason: string | null;         // null gdy chatgpt === true
};

type AiSettingsResponse = {
  settings: AiSettings;
  connections: AiConnection[];          // zawsze 4 wpisy: openrouter, openai, chatgpt, custom
  capabilities: AiCapabilities;
};
```

`connected` = połączenie skonfigurowane: `openrouter`/`openai`/`custom` mają
zapisany klucz API lub (custom) sam `baseUrl`; `chatgpt` ma ważne tokeny SIWC.
`keyHint` to zamaskowany ślad (`abcd…wxyz`, 4+4 znaki, tylko przy długości
≥ 12; w przeciwnym razie `null`) — **klucz nigdy nie wraca w odpowiedziach**.

Wartości brakujące w metrykach to zawsze `null` / `—` — nigdy fikcyjne
statystyki.

## 3. Konfiguracja ustawień

### `GET /api/v1/ai/settings` → `AiSettingsResponse`

### `PUT /api/v1/ai/settings` (body częściowe) → `AiSettingsResponse`

Body: dowolny podzbiór `{provider, model, autoFree, executionMode, customName,
baseUrl|customBaseUrl}`; pola nieobecne zachowują wartość (`baseUrl` i
`customBaseUrl` to aliasy — podanie obu z różnymi wartościami → `INVALID_BODY`).
Po mergu obowiązują reguły:

1. `executionMode` ∈ `monitor_only | approval_required | autonomous`; brak
   wiersza w DB = `approval_required` (DEFAULT). Zapis nie uruchamia żadnych
   działań — tryby są przechowywane na przyszłość (`monitor_only` = analiza i
   sugestie, `approval_required` = działania po zatwierdzeniu, `autonomous` =
   automatyczne naprawy).
2. `provider` ∈ `openrouter | openai | chatgpt | custom | null`.
3. `model` ∈ tekst 1..200 znaków bez znaków sterujących albo `null`.
   - `provider === null` → `model` musi być `null` (inaczej `INVALID_BODY`).
   - `provider === 'chatgpt'` → `model` opcjonalny (model rozstrzyga moduł SIWC).
   - pozostałe (`openrouter` bez autoFree, `openai`, `custom`) → `model`
     wymagany, niepusty.
4. **`autoFree` (tylko OpenRouter)** — `provider === 'openrouter' && autoFree
   === true` rozstrzyga model zawsze na `'openrouter/free'`, **bez płatnego
   fallbacku**. Wtedy `model` musi być `null` albo `'openrouter/free'`
   (cokolwiek innego → `INVALID_BODY`; frontend odznacza pole modelu).
   `autoFree === true` z innym providerem jest zapisywane, ale nie wpływa na
   model (model obowiązuje ręczny).
5. `provider === 'custom'` → po mergu wymagane `baseUrl` (poprawny URL, §5).
6. `customName` ≤ 100 znaków; `baseUrl` jak w §5 albo `null` (gdy provider ≠
   `custom`, `baseUrl` może być wypełniony — konfiguracja leży odłogiem).

## 4. Połączenia (klucze API)

Klucze są zapisywane wyłącznie zaszyfrowane (§6), nigdy nie wracają w
odpowiedziach ani logach. Zapis klucza **nie** wykonuje wywołań sieciowych
(łączenie i test są rozdzielone).

### `PUT /api/v1/ai/connections/openrouter` | `.../openai` → `AiSettingsResponse`

Body: `{ "apiKey": string }` (1..512 znaków).

### `PUT /api/v1/ai/connections/custom` → `AiSettingsResponse`

Body: `{ "apiKey"?: string, "baseUrl": string, "name"?: string }`

- `baseUrl` **wymagane** (walidacja §5) → zapisywane w `settings.baseUrl`,
- `name` → `settings.customName`; nieobecne = bez zmian, `''` = wyczyszczenie
  (`null`), inaczej wartość,
- `apiKey`:
  - **nieobecne** = bez zmian klucza (rozróżnione od usunięcia),
  - `''` = **usunięcie** klucza (custom może działać bez klucza — lokalne
    serwery),
  - inaczej = podmiana klucza.

### `POST /api/v1/ai/connections/:provider/test` → `{ ok: boolean, message: string }`

- `openrouter`: `GET https://openrouter.ai/api/v1/key` z `Authorization:
  Bearer`, **bez inferencji**; 2xx → `ok:true`.
- `openai`: `GET https://api.openai.com/v1/models` z `Authorization: Bearer`,
  bez inferencji; 2xx → `ok:true`.
- `custom`: `GET {baseUrl}/models` z `Authorization: Bearer` **tylko gdy**
  klucz zapisany; 2xx → `ok:true`.
- `chatgpt`: `400 INVALID_BODY` (status daje `GET /chatgpt/status`).
- brak klucza dla `openrouter`/`openai` → `{ok:false, message:"No API key
  stored for this provider"}` (bez wywołań sieciowych); brak `baseUrl` dla
  `custom` → `400 INVALID_BODY`.
- `message` jest bezpieczny opisem statusu HTTP/typu błędu (np. `OpenRouter
  rejected the key (HTTP 401)`, `Connection failed: timeout`); **nigdy nie
  zawiera klucza** ani treści ciała błędu dostawcy dłuższej niż krótki,
  bezpieczny skrót.
- każdy test (także nieudany) aktualizuje `lastCheckedAt` połączenia.

### `DELETE /api/v1/ai/connections/:provider` → `AiSettingsResponse`

- `openrouter|openai`: usuwa zapisany klucz.
- `custom`: **pełne rozłączenie** (review LOW) — usuwa credential **oraz**
  konfigurację (`settings.baseUrl`, `settings.customName`); gdy `custom` był
  aktywnym providerem, selekcja jest spójnie dezaktywowana (`provider` i
  `model` → `null`). `executionMode` (i `autoFree`) są celowym wyborem
  operatora i zostają.
- `:provider === 'chatgpt'` → `400 INVALID_BODY` (odłączenie ChatGPT:
  `POST /api/v1/ai/chatgpt/logout`). Nieznany provider → `400 INVALID_BODY`.

## 5. Custom provider (OpenAI-compatible) — walidacja URL i SSRF

`baseUrl` musi przejść walidację **po stronie serwera** (także przy teście i
przy każdym przyszłym wywołaniu):

- tylko `http:` / `https:`, wymagany hostname, port 1..65535,
- **bez** userinfo (`user:pass@`), query i fragmentu,
- adresy literalne IP: blokowane `0.0.0.0/8`, link-local `169.254.0.0/16`
  (w tym metadane chmury `169.254.169.254`), multicast/reserved
  (`224.0.0.0/4`, `255.255.255.255`), IPv6: link-local `fe80::/10`,
  multicast `ff00::/8`, unspecified `::`; mapowane IPv4 (`::ffff:…`,
  NAT64 `64:ff9b::/96`) sprawdzane jak adres v4,
- **loopback i prywatne zakresy są dozwolone** (self-hosted lokalne serwery są
  ważnym przypadkiem użycia) — backend jest za sesją i dostęp do
  konfiguracji wymaga autoryzacji,
- hosty DNS: przed wywołaniem rozwiązywane i odrzucane, gdy którakolwiek
  odpowiedź należy do zablokowanych zakresów,
- wywołania HTTP: **bez podążania za redirectami** (3xx = błąd, klucz nie
  jest wysyłany nigdzie indziej niż ustalony URL), timeout (domyślnie 10 s),
  limit odczytu odpowiedzi (1 MB), zapytanie idzie wyłącznie do wskazanego
  hosta.

Znane ograniczenia (udokumentowane, nie ukrywane): walidacja IP przy
rozkładaniu DNS nie eliminuje w pełni DNS rebinding/TOCTOU między walidacją a
połączeniem; ryzyko jest ograniczone do instancji self-hosted, która ufa
własnemu DNS-owi operatora. Backend nie udostępnia otwartego proxy: wywołania
wychodzące inicjuje tylko zapisana konfiguracja zalogowanego użytkownika.

## 6. Szyfrowanie sekretów

- AES-256-GCM, klucz wyłącznie z env `AI_CREDENTIAL_KEY` (32-bajtowy hex/base64
  albo fraza ≥ 8 znaków hashowana SHA-256 — bez losowego fallbacku; brak klucza
  = jawny błąd konfiguracji przy zapisie sekretu).
- Format w DB: `v1.<base64url(iv ‖ tag ‖ ciphertext)>`, plaintext = JSON.
- Osobna domena klucza: `AI_CREDENTIAL_KEY` nie jest `SESSION_SECRET`.
- Odczyt ustawień działa bez klucza; odszyfrowanie istniejącego sekretu przy
  braku/błędnym kluczu = czytelny błąd konfiguracji (sekret nie jest kasowany).
- Sekrety nigdy w logach (redakcja `*.apiKey`, `*.credential`, …), audit log
  bez plaintextu.

## 7. Panel zużycia (app-side)

### `GET /api/v1/ai/usage`

```ts
{
  requests: number;                 // 0 gdy brak zdarzeń
  inputTokens: number | null;       // null gdy brak danych
  outputTokens: number | null;
  costUsd: number | null;
  since: string | null;             // ISO najstarszego zdarzenia aplikacji
  recent: Array<{
    at: string; provider: AiProvider; model: string | null;
    inputTokens: number | null; outputTokens: number | null;
    costUsd: number | null;
  }>;                               // maks. 20, najnowsze pierwsze
}
```

- wyłączne źródło: `ai_usage_events` **tej aplikacji** (rejestrator wewnętrzny
  `recordAiUsage`), nigdy statystyki klucza OpenRouter ani billing dostawcy,
- brak zdarzeń → `requests: 0`, tokeny/koszt `null`, `since: null`,
  `recent: []` — nigdy fikcyjne statystyki,
- **brak endpointu** pozwalającego klientowi dopisać/„sfałszować” zużycie;
  zdarzenia zapisuje wyłącznie backend przy przyszłych wywołaniach AI.

## 8. ChatGPT (osobny provider, login/abonament)

### `POST /api/v1/ai/chatgpt/login` → `{ authorizationUrl: string }`
### `GET /api/v1/ai/chatgpt/status` → `{ connected: boolean, pending: boolean, message: string | null }`
### `POST /api/v1/ai/chatgpt/logout` → `AiSettingsResponse` (jak GET settings)
### `GET /auth/callback` (root, poza `/api/v1`) — oficjalny loopback callback SIWC

Moduł ChatGPT (`core/src/ai/chatgpt.ts`, drugi wykonawca) używa OAuth PKCE +
loopback callback `127.0.0.1`, bez czytania `~/.codex/auth.json`. Backend (ten
zakres) udostępnia mu **storage adapter** do zaszyfrowanych tokenów per user —
uzgodnienie interfejsu w `docs/chatgpt-setup.md` (sekcja „Secret storage
adapter”).

**Ścieżka callbacku jest sztywna (review HIGH):** rejestracja SIWC przypina
scheme+host+path — tylko port może się zmieniać, `​/callback` **nie** jest
równe `/auth/callback` (oficjalny docs „Registration and sign-in”, `redirect_uri`).
Dlatego `AI_CHATGPT_REDIRECT_URI` musi mieć postać
`http://127.0.0.1:<port>/auth/callback`, a Core rejestruje handler na **root
`GET /auth/callback`** (bez prefiksu `/api/v1`). Alias
`GET /api/v1/ai/chatgpt/callback` pozostaje dla zgodności, ale nie jest
poprawnym `redirect_uri`. Callback jest GET-em z cookie sesji; query
(`code`/`state`) nie trafia do logów; sukces → `303` na `/`, błąd → statyczna
strona HTML (bez sekretów, bez redirectu na URL z query).

Integracja jest luźno sprzężona: gdy `core/src/ai/chatgpt.ts` nie istnieje lub
nie spełnia interfejsu, `capabilities.chatgpt = false` z powodem w
`chatgptReason`, a endpointy ChatGPT zwracają `503 CHATGPT_UNAVAILABLE`.
Wymagana powierzchnia modułu (propozycja dla modułu ChatGPT):

```ts
export interface ChatgptSecretStore {           // daje backend
  save(userId: string, secret: unknown, opts?: { keyHint?: string | null }): Promise<void>;
  load(userId: string): Promise<unknown | null>;
  delete(userId: string): Promise<void>;
}
export interface ChatgptIntegration {
  isAvailable(): { ok: boolean; reason: string | null };
  login(userId: string): Promise<{ authorizationUrl: string }>;
  status(userId: string): Promise<{ connected: boolean; pending: boolean; message: string | null }>;
  logout(userId: string): Promise<void>;
}
export function createChatgptIntegration(deps: {
  storage: ChatgptSecretStore;
  // env wymagane przez moduł: dokumentacja w docs/chatgpt-setup.md
}): ChatgptIntegration;
```

Backend wywołuje wyłącznie te metody; nie implementuje samego loginu SIWC.
Klauzula: `POST /chatgpt/logout` sprząta też stan `pending` po stronie modułu.

## 9. Zdarzenia zużycia (rejestrator wewnętrzny)

```ts
recordAiUsage(db, {
  userId: string; provider: AiProvider; model: string | null;
  inputTokens?: number | null; outputTokens?: number | null;
  costUsd?: number | null; kind?: string;   // np. 'chat', 'analysis'
}): Promise<void>
```

Zapisywane w `ai_usage_events` (per user, addytywnie). Przyszła integracja
inferencji wywołuje ten rejestrator; dzisiejszy zakres nie generuje zdarzeń
sztucznie.

## 10. Różnice względem ustaleń wstępnych

- Ścieżki: `/api/ai/...` → **`/api/v1/ai/...`** (prefiks projektu).
- `customName` i `baseUrl` (alias DTO **`customBaseUrl`**) mieszkają w
  `settings` — odpowiedź zawiera oba klucze z tą samą wartością, PUT akceptuje
  oba (konflikt wartości → `INVALID_BODY`); `PUT /connections/custom` zapisuje
  te same pola (`name` → `customName`).
- Enum provider rozszerzony o `'custom'` (nowy wymóg: dowolne API w granicach
  profilu OpenAI-compatible — patrz ograniczenia §0).
- Callback SIWC: **root `GET /auth/callback`** (strict; review HIGH) + alias
  `GET /api/v1/ai/chatgpt/callback` dla zgodności — patrz §8.
- `DELETE /connections/custom` = pełne rozłączenie (review LOW) — patrz §4.
- Reszta kontraktu bez zmian: kształt `settings/connections/capabilities`,
  `executionMode` DEFAULT `approval_required`, brak fikcyjnych statystyk.

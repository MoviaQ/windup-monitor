# ChatGPT subscription connector — integracja backendu

Dokument dla backend integratora. Moduł: `core/src/ai/chatgpt.ts`.
To jest wyłącznie warstwa OAuth/tokenów „Sign in with ChatGPT”. Nie wykonuje
inferencji ani żadnych akcji agenta.

Źródła oficjalne (preview):
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery

`docs/ai-integration-contract.md` **istnieje i jest źródłem prawdy** dla
kształtu API backendu. Ta notatka opisuje, jak moduł realizuje jego §8.

## 1. Eksporty modułu

```ts
import {
  // powierzchnia wymagana przez kontrakt §8
  createChatgptIntegration,
  type ChatgptIntegration,
  type ChatgptIntegrationStatus,
  type ChatgptCallbackParams,
  type ChatgptSecretStore,
  type ChatgptIntegrationDeps,
  // connector niższego poziomu (pełny stan, capability, refresh)
  ChatGptConnector,
  ChatGptError,
  CHATGPT_REQUIRED_SCOPES,
  chatGptConfigFromEnv,
  newAgentHostId,
  type ChatGptConfig,
  type ChatGptTokenStore,
  type ChatGptCapability,
  type ChatGptStatus,
  type ChatGptLoginStart,
  type ChatGptCallbackInput,
  type ChatGptErrorCode,
  type ChatGptDeployment,
} from './ai/chatgpt.js';
```

### Powierzchnia kontraktowa (`ChatgptIntegration`)

Backend powinien używać **tej** powierzchni. Jest cienką warstwą nad
connectorem; cały OAuth/PKCE/refresh zostaje w module.

```ts
const chatgpt = createChatgptIntegration({
  storage: new PrismaChatgptSecretStore(db, config.aiCredentialKey),
  env: process.env,
  // config?: Partial<ChatGptConfig> — nadpisuje wartości z env (testy/proxy)
  // enabled?, fetch?, now? — tylko testy
});

chatgpt.isAvailable(); // { ok: boolean, reason: string | null }
await chatgpt.login(userId); // { authorizationUrl }
await chatgpt.completeCallback(userId, { code, state, clientId, error });
await chatgpt.status(userId); // { connected, pending, message: string | null }
await chatgpt.refresh(userId); // { connected, pending, message }
await chatgpt.logout(userId); // void; czyści też pending
```

`completeCallback` i `refresh` są rozszerzeniem kontraktu §8 — bez callbacku
nie da się domknąć loopback OAuth; `refresh` jest potrzebny przyszłej
inferencji. Nie zmieniają istniejących metod.

### `ChatGptConnector` (niższy poziom)

```ts
new ChatGptConnector({
  config: ChatGptConfig,
  store: ChatGptTokenStore,
  enabled?: boolean,      // default true
  fetch?: FetchLike,      // tylko do testów / proxy; produkcyjnie pomiń
  now?: () => number,     // tylko do testów
});
```

Metody:

| Metoda | Sygnatura | Opis |
| --- | --- | --- |
| `capability()` | `(): ChatGptCapability` | synchroniczny stan configu; bez sekretów |
| `startLogin(userId)` | `async (string): Promise<ChatGptLoginStart>` | tworzy pending flow PKCE/state/nonce, zwraca `{ authorizationUrl, expiresAt }` |
| `completeCallback(input)` | `async (ChatGptCallbackInput): Promise<ChatGptStatus>` | konsumuje flow, wymienia code, waliduje ID token, zapisuje credential |
| `status(userId)` | `async (string): Promise<ChatGptStatus>` | stan połączenia; **żadnych tokenów** |
| `refresh(userId)` | `async (string): Promise<ChatGptStatus>` | rotuje access/refresh token; przy `invalid_grant` usuwa credential i rzuca `CHATGPT_REAUTH_REQUIRED` |
| `logout(userId)` | `async (string): Promise<void>` | usuwa pending flow i lokalny credential; brak zdalnej rewokacji |

`ChatGptCallbackInput`:

```ts
{
  userId: string;          // z sesji, nie z query
  code: string;            // ?code=
  state: string;           // ?state=
  error?: string | null;   // ?error=
  clientId?: string | null;// ?client_id= (tylko pierwsza rejestracja)
}
```

### `ChatGptStatus` (bezpieczny dla frontendu)

```ts
{
  connected: boolean;
  pending: boolean;
  message: string;
  account?: { subject: string; email?: string; name?: string };
  expiresAt?: string;         // wygaśnięcie access tokena
  refreshExpiresAt?: string;  // wygaśnięcie refresh tokena
  pendingExpiresAt?: string;  // tylko gdy pending
  planUsageGranted?: boolean; // oba scopes zasobu ChatGPT
}
```

Nigdy nie zawiera `accessToken`, `refreshToken`, `idToken`, `code`, PKCE
ani zaszyfrowanego ciphertextu.

### `ChatGptCapability`

```ts
{
  available: boolean;
  enabled: boolean;
  configured: boolean;
  missing: string[];      // np. ['AI_CHATGPT_HOST_ID']
  warnings: string[];     // błędy configu lub ostrzeżenie o remote
  redirectUri: string | null;
  loopbackCallback: boolean;
  deployment: 'local' | 'remote';
  message: string;
}
```

### `ChatGptError`

```ts
class ChatGptError extends Error {
  code: ChatGptErrorCode;
  statusCode: number;      // propozycja mapowania HTTP
  retryable: boolean;      // true dla 429/5xx/timeout
  upstreamError: string | null; // np. 'invalid_grant'; nigdy opis z tokenami
}
```

Mapowanie na odpowiedź API:

| `code` | HTTP | Uwagi |
| --- | --- | --- |
| `CHATGPT_DISABLED`, `CHATGPT_NOT_CONFIGURED` | 503 | pokaż `capability.message` |
| `CHATGPT_INVALID_USER`, `CHATGPT_FLOW_INVALID`, `CHATGPT_FLOW_EXPIRED` | 400 | poproś o ponowienie logowania |
| `CHATGPT_ACCESS_DENIED` | 403 | użytkownik odmówił |
| `CHATGPT_REGISTRATION_INCOMPLETE` | 502 | brak wydanego `client_id` |
| `CHATGPT_TOKEN_EXCHANGE_FAILED`, `CHATGPT_TOKEN_RESPONSE_INVALID`, `CHATGPT_REFRESH_FAILED` | 502 | sprawdź `retryable` |
| `CHATGPT_ID_TOKEN_INVALID` | 401 | nie ufaj tokenowi; nie zapisano credentialu |
| `CHATGPT_NOT_CONNECTED` | 409 | brak refreshu |
| `CHATGPT_REAUTH_REQUIRED` | 401 | credential usunięty; pokaż „Zaloguj ponownie” |
| `CHATGPT_STORE_ERROR`, `CHATGPT_CREDENTIAL_INVALID` | 500 | nie loguj ciphertextu |

Zwracaj klientowi tylko `{ code, message }`. Nie serializuj całego błędu
(`upstreamError` nadal bezpieczny, ale niepotrzebny frontendowi).

## 2. Kontrakt HTTP (`/api/v1/ai/...`, zgodny z §8)

| Endpoint | Metoda | Sesja/CSRF | Wywołanie modułu | Odpowiedź |
| --- | --- | --- | --- | --- |
| `/api/v1/ai/chatgpt/login` | POST | tak | `chatgpt.login(userId)` | `200 { authorizationUrl }` |
| `/api/v1/ai/chatgpt/status` | GET | tak | `chatgpt.status(userId)` | `200 { connected, pending, message }` |
| `/api/v1/ai/chatgpt/logout` | POST | tak | `chatgpt.logout(userId)` | `AiSettingsResponse` (§3 kontraktu) |
| `/auth/callback` (root, loopback) | GET | tak (cookie sesji) | `chatgpt.completeCallback(userId, { code, state, clientId, error })` | `303` na stały widok ustawień lub `200` HTML „zamknij okno” |
| `/api/v1/ai/settings` | GET | tak | `chatgpt.isAvailable()` + `chatgpt.status(userId)` | `capabilities.chatgpt` + `chatgptReason` (§2 kontraktu) |

Uwagi implementacyjne:

- **`login` zwraca wyłącznie `authorizationUrl`.** Nie zwracaj `state`, `nonce`,
  `code_verifier`, `code_challenge`, `clientId` ani tokenów. Wszystko potrzebne
  jest w URL albo w pamięci modułu.
- **`callback` musi być GET pod `/auth/callback`** na `127.0.0.1` (loopback).
  Oficjalny SIWC ustala scheme/host/path: tylko port może się zmieniać.
  Backend rejestruje root route `GET /auth/callback`, **nie** pod `/api/v1`.
  Nie przekierowuj na `redirect_uri` z query ani na dowolny URL — po sukcesie
  `303` tylko na stałą, relatywną ścieżkę aplikacji.
- **Nie loguj query callbacku.** `code` i `state` nie mogą trafić do access
  logów, `audit_log`, Sentry ani nagłówka `Location`.
- Flow jest związany z `userId` z sesji. Callback z innej sesji kończy się
  `CHATGPT_FLOW_INVALID` (celowo bez rozróżniania od złego `state`).
- `refresh()` nie ma osobnego endpointu w kontrakcie. Backend może wywołać je
  wewnętrznie przy przyszłej inferencji albo dodać endpoint później.
- `logout` czyści pending flow i lokalny credential. Rewokacja po stronie
  OpenAI odbywa się w ustawieniach ChatGPT; SIWC nie dokumentuje endpointu
  rewokacji.

### Refresh a `id_token`

- `authorization_code` **wymaga** `id_token`: bez niego moduł odrzuca odpowiedź
  (`CHATGPT_TOKEN_RESPONSE_INVALID`), bo tożsamość musi być zweryfikowana przed
  zapisem.
- `refresh_token` oficjalnie gwarantuje nowy `access_token` i replacement
  `refresh_token`; **`id_token` może nie wystąpić**. Wtedy moduł zachowuje
  tożsamość zweryfikowaną przy authorization_code i nie dekoduje nic bez
  podpisu.
- Jeżeli `refresh` zwróci `id_token`, jest on w pełni weryfikowany (podpis
  RS256/JWKS, `iss`, `aud`, `exp`, `sub`); niezgodny `sub` przerywa refresh bez
  nadpisania credentialu.

### Mapowanie wyniku na `AiSettingsResponse`

- `capabilities.chatgpt = isAvailable().ok`
- `capabilities.chatgptReason = isAvailable().reason` (null, gdy `ok`)
- `connections[chatgpt].connected = status().connected`
- brak tokenów w `AiConnection`; `keyHint` dla ChatGPT zawsze `null`.

`ChatgptIntegrationStatus` ma dokładnie `{ connected, pending, message }` —
żadnych tokenów, `account`, `expiresAt` ani ciphertextu.

## 3. Secret storage adapter (kontrakt §8)

To jest nazwa i kształt wymagane przez `docs/ai-integration-contract.md`.
Backend implementuje wyłącznie storage; szyfrowanie należy do niego, moduł
przekazuje **obiekt** credentialu, nie ciphertext.

```ts
interface ChatgptSecretStore {
  save(userId: string, secret: unknown, opts?: { keyHint?: string | null }): Promise<void>;
  load(userId: string): Promise<unknown | null>;
  delete(userId: string): Promise<void>;
}
```

Zasady:

- `save`: zaszyfruj cały obiekt AES-256-GCM kluczem `AI_CREDENTIAL_KEY` i
  zapisz jeden rekord per `userId`; format DB zgodny z §6 kontraktu:
  `v1.<base64url(iv ‖ tag ‖ ciphertext)>`. `opts.keyHint` dla ChatGPT jest
  zawsze `null` (to nie jest klucz API).
- `load`: odszyfruj i zwróć zapisany obiekt albo `null`, gdy brak rekordu.
  Adapter modułu akceptuje też JSON string (jeśli Twój storage serializuje
  przed szyfrowaniem). Błąd odszyfrowania ma być czytelnym błędem konfiguracji;
  moduł zamieni go na `CHATGPT_CREDENTIAL_INVALID`.
- `save` otrzymuje **obiekt** credentialu (`unknown`); to backend ma go
  zserializować i zaszyfrować. Nie zapisuj go jako plaintext.
- `delete`: usuń rekord; `logout` wywołuje to razem z wyczyszczeniem pending.
- Nie loguj obiektu credentialu (zawiera `accessToken`, `refreshToken`,
  `idToken`). Nie zwracaj go w żadnym DTO.
- Sugerowany schemat: `ai_chatgpt_credentials(user_id PK, ciphertext, updated_at)`
  — schema/migracja po stronie backendu.
- Nie czytaj `~/.codex/auth.json` ani żadnych cudzych tokenów. Moduł przyjmuje
  wyłącznie dane z własnego OAuth SIWC.

Kompozycja:

```ts
const chatgpt = createChatgptIntegration({
  storage: new PrismaChatgptSecretStore(db, config.aiCredentialKey),
  env: process.env,
});
```

### Niżej-poziomowy wariant (`ChatGptTokenStore`)

Jeśli backend chce sam zarządzać serializacją JSON i szyfrowaniem w adapterze,
może użyć `ChatGptConnector` bezpośrednio z adapterem:

```ts
interface ChatGptTokenStore {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
  load(userId: string): Promise<string | null>;
  save(userId: string, encrypted: string): Promise<void>;
  delete(userId: string): Promise<void>;
}

const connector = new ChatGptConnector({
  config: chatGptConfigFromEnv().config,
  store: new PrismaChatGptTokenStore(db, config.aiCredentialKey),
  enabled: chatGptConfigFromEnv().enabled,
});
```

W tym wariancie `encrypt`/`decrypt` muszą używać AES-256-GCM i tego samego
`AI_CREDENTIAL_KEY`; `load`/`save` operują na ciphertextcie. Nie mieszaj obu
adapterów dla tego samego użytkownika.

## 4. Konfiguracja

| Zmienna | Wymagane | Opis |
| --- | --- | --- |
| `AI_CHATGPT_ENABLED` | nie | `true/false`; domyślnie `true` |
| `AI_CHATGPT_AGENT_NAME` | nie | `agent_name_hint`; domyślnie `wind-up monitor`; nie zmieniaj między instalacjami |
| `AI_CHATGPT_HOST_ID` | **tak** | stabilny, nieprzejrzysty ID hosta: `urn:uuid:<UUIDv4>` (albo JWK thumbprint / `did:key`) |
| `AI_CHATGPT_REDIRECT_URI` | **tak** | `http://127.0.0.1:<port>/auth/callback`; path stały, tylko port może się zmieniać, nie `localhost`, bez query |
| `AI_CHATGPT_DEPLOYMENT` | nie | `local` (default) lub `remote` → ostrzeżenie o tunelu |
| `AI_CREDENTIAL_KEY` | **tak** | 32-bajtowy klucz base64 do adaptera szyfrowania |

Wygeneruj host ID raz i zapisz:

```bash
node -e "console.log('urn:uuid:' + require('node:crypto').randomUUID())"
# albo w kodzie: newAgentHostId()
```

### Callback w praktyce

- Core musi faktycznie nasłuchiwać na `127.0.0.1:<port>` z `AI_CHATGPT_REDIRECT_URI`.
  Jeśli Core binduje `127.0.0.1:8080`, użyj
  `http://127.0.0.1:8080/auth/callback` (root route, nie `/api/v1/...`).
  Path jest stały; zmienia się wyłącznie port.
- `deployment=remote` (Core na innym hoście niż przeglądarka): przeglądarka
  wywoła `127.0.0.1` **użytkownika**, nie serwera. Potrzebny tunel, np.
  `ssh -L 8080:127.0.0.1:8080 user@core-host`, a `AI_CHATGPT_REDIRECT_URI`
  musi wskazywać port tunelu. Bez tego flow się nie domknie — `capability()`
  to zgłasza, ale nie wykryje topologii sieci.

### Wymagania po stronie OpenAI

- SIWC „ChatGPT plan usage” jest w preview i jest opisane dla aplikacji
  open source / lokalnych. Hosting komercyjny/zdalny wymaga formularza
  zainteresowania OpenAI. Użytkownik potrzebuje ChatGPT Plus/Pro.
- Bez client secreta: pierwszy login używa `client_id=dynamic_agent_client`,
  a callback zwraca wydany `client_id`, który moduł zapisuje i używa później.
- Nie używaj cookies ChatGPT ani `chatgpt.com/backend-api`; docs wprost każą
  kierować się na `https://api.openai.com/v1`.

## 5. Brak wycieku sekretów do frontendu

- `/login` → tylko `{ authorizationUrl }`. URL zawiera publiczne parametry OAuth
  (`state`, `nonce`, `code_challenge`), ale **nie** `code_verifier`, nie tokeny
  i nie `client_secret`.
- `/status` i `/api/v1/ai/settings` → wyłącznie `ChatgptIntegrationStatus`
  (`connected`, `pending`, `message`) i `isAvailable()` (`ok`, `reason`).
- Modal logowania nigdy nie dostaje `code`; kod trafia wyłącznie do backendowego
  callbacku i jest natychmiast wymieniany.
- Frontend nie zapisuje niczego w `localStorage`/`sessionStorage`; `authorizationUrl`
  jest tylko nawigacją.
- Błędy przekazuj jako `{ code, message }`; nie zwracaj stack trace ani ciała
  odpowiedzi token endpointu.
- Nie loguj query callbacku ani nagłówków Authorization.

## 6. Testy

Testy jednostkowe z mockami (bez sieci, bez bazy, bez Postgresa):
`core/src/ai/chatgpt.test.ts` — 28 przypadków: capability, ścisły path
`/auth/callback`, PKCE/URL, state/nonce/expiry, wymiana tokenów, walidacja
podpisu/iss/aud/nonce/exp, refresh bez `id_token` i z niezgodnym `sub`,
serializacja równoległych refreshy, rotacja, logout, brak sekretów w błędach
i adapterze oraz powierzchnia kontraktu `createChatgptIntegration` /
`ChatgptSecretStore`.

To zwykłe testy Vitest i mają działać w standardowym CI. Backend integrator
dodaje `src/ai/**/*.test.ts` do `include` w `vitest.config.ts`; po tej zmianie:

```bash
cd core
npx vitest run src/ai/chatgpt.test.ts
# lub cały standardowy zestaw:
npm test
```

Weryfikacja typów: `npx tsc -p tsconfig.json --noEmit`.

Standardowy `vitest.config.ts` uruchamia `globalSetup` (migracje/test DB), więc
w CI potrzebne jest `DATABASE_URL`. Same testy `src/ai/chatgpt.test.ts` nie
dotykają bazy — korzystają wyłącznie z mocków.

**Brak E2E realnego loginu.** Testy nie łączą się z OpenAI; wymagają mocków
token endpointu i JWKS. Realny login wymaga konta ChatGPT Plus/Pro, publikacji
projektu jako OSS i spełnienia preview SIWC — nie jest obiecywany w CI.

## 7. Ograniczenia (świadome)

- Pending flow trzymany w pamięci procesu: restart Core w trakcie logowania
  unieważnia flow; użytkownik klika „Zaloguj” ponownie. Nie jest to stan
  trwały i nie zawiera sekretów utrwalanych na dysku.
- Refreshe dla tego samego użytkownika są serializowane w obrębie procesu
  (rotujący refresh token). Przy wielu instancjach Core potrzebny jest
  dodatkowo zamek w DB — poza zakresem tego modułu.
- Jeden credential na użytkownika; wybór wielu kont ChatGPT nie jest wspierany.
- Brak odczytu limitów/pozostałego zużycia subskrypcji — SIWC tego nie
  udostępnia. Status pokazuje tylko stan połączenia i `planUsageGranted`.
- Brak zdalnej rewokacji; `logout` czyści lokalnie.
- Brak inferencji i trybów pracy agenta — to osobny, przyszły modul.
- Preview: przyszłe wywołania Responses API muszą używać `store:false`,
  `stream:true`, bez `previous_response_id` i bez `temperature`/`top_p` itd.
- Przy powrocie świadomie nie wysyłamy `id_token_hint`/`login_hint`, żeby nie
  wkładać tokenu/PII do URL przeglądarki; użytkownik może zobaczyć ekran
  wyboru konta.

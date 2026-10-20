# Bezpieczeństwo

> Powiązane: [architecture.md](architecture.md) (granice komponentów), [agent-protocol.md](agent-protocol.md) (credentiale), [data-model.md](data-model.md) (audyt).
> Zasada: brak kont zewnętrznych = brak wymówek — cała odpowiedzialność za sekrety i dostęp jest po stronie wdrożenia użytkownika, więc defaulty muszą być bezpieczne.
>
> Status implementacji: **kontrole S1 zaimplementowane (2026-10-19)** — argon2id,
> sesja + CSRF + Origin, rate-limity in-memory, redakcja sekretów w logach,
> 0600 na pliki sekretów. Reset hasła CLI (SP-600), rola DB tylko-INSERT dla
> `audit_log` i 2FA należą do faz późniejszych. Dowód: [iterations/s1.md](iterations/s1.md).

## 1. Granice zaufania

| Granica | Po której stronie co stoi |
|---|---|
| Internet → Core | TLS (reverse proxy użytkownika lub wbudowany — default: Core słucha na localhost + dokumentacja reverse proxy; bezpośrednia ekspozycja wymaga jawnej flagi) |
| Agent → Core | Bearer credential (hashowany), TLS; agent ufa Core dopieropo enroll (TOFU z one-time tokenem) |
| Core → docker.sock | **ZAKAZANE** — Core nigdy nie montuje ani nie czyta socketa, nawet lokalnie |
| Agent → docker.sock | dozwolone, read + scoped `restart` (niżej) |
| Web → Core | session cookie; Web nie przechowuje sekretów |

## 2. Auth single-user i bootstrap

- Pierwsze uruchomienie: Core w trybie `bootstrap` (stan w `bootstrap_state`, data-model §1: hash tokenu + `expires_at` + atomowe single-use + unikalny admin). UI wymusza ustawienie hasła. Token bootstrap wypisywany jest RAZ na stdout pierwszego startu lub zapisywany do pliku lokalnego z modem `0600` (wybór wdrożenia); nie wolno go zapisywać do zbiorczych/agregowanych logów ani przekazywać dalej. Po ustawieniu hasła tryb bootstrap znika na zawsze (`used_at` ustawione atomowo `UPDATE … WHERE used_at IS NULL`; ponowne użycie niemożliwe).
- Hasło: argon2id (OWASP defaults), min. 12 znaków (walidacja w UI + Core).
- Sesja: losowe 256-bit ID, cookie `__Host-sp_session` (`HttpOnly, Secure, SameSite=Lax, Path=/`), TTL 30 dni + sliding 7 dni. Brak „remember me" jako osobnego mechanizmu.
- CSRF: `SameSite=Lax` + wymagany nagłówek `X-Requested-With: XMLHttpRequest` na mutacjach API (double-submit token zbędny przy SPA same-origin; gdyby Web i API miały różne originy — dołożyć synchronizer token, decyzja przy implementacji S1).
- Rate-limit logowania: 5 prób / 5 min / IP + wykładniczy backoff; log + (opcjonalnie) powiadomienie.
- Brak resetu „mailem" (brak maili w MVP) — reset przez CLI Core (`core reset-password`, wymaga dostępu do hosta/`.env`).

## 3. Sekrety

- `.env`: `DATABASE_URL`, `SESSION_SECRET` (min 32 B), brak defaultów produkcyjnych w repo (tylko `.env.example`).
- Credentiale agentów: wyłącznie hashe (argon2id) w `agents.credential_hash (+ credential_hash_next w trakcie rotacji)`; plaintext istnieje tylko w odpowiedzi enroll (raz) i w pamięci/plikach `0600` agenta. Przy rotacji sekret `next` generuje agent i zapisuje atomowo lokalnie `0600` PRZED `POST /rotate`; Core dostaje go raz po TLS i przechowuje wyłącznie hash (nigdy plaintext w DB/logach/audycie). W trakcie overlap Core akceptuje oba sekrety (dual-accept do `overlap_until` lub do confirm/promocji) — rotacja nie blokuje heartbeat/ingest. Revokacja czyści oba hashe (`current + next`) bez overlap. Audit rotacji/revokacji notuje wyłącznie `agent_id + rotation_id + timestamps + kody wyniku`, zero plaintext i zero hashy w czytelnej formie. Re-enroll wymagany wyłącznie przy utracie obu sekretów agenta; szczegóły idempotencji i promocji przy utraconej odpowiedzi: agent-protocol §2, schema: data-model §1.
- Enroll tokeny: hash w DB, TTL 15 min, single-use konsumowany atomowo wyłącznie po pomyślnym enrollment (nieudana próba nie pali tokenu; rate-limit 10 prób / 10 min / IP).
- Backup zawiera hashe — dopuszczalne; `.env` backupowany oddzielnie z uprawnieniami `0600`.
- Zakaz: sekrety w logach, w URL, w PWA cache, w `audit_log.detail` (sanityzacja przed zapisem).
- Sekrety AI (klucze API OpenRouter/OpenAI/custom, tokeny ChatGPT SIWC): wyłącznie blob AES-256-GCM (`v1.<b64url(iv‖tag‖ct)>`) w `ai_credentials.ciphertext`, klucz z osobnego `AI_CREDENTIAL_KEY` (nie `SESSION_SECRET`; brak losowego fallbacku — bez klucza zapis sekretu zwraca `AI_CREDENTIAL_KEY_MISSING`, odczyt ustawień działa). W odpowiedziach API i logach tylko maskowany `key_hint` (`abcd…wxyz`); klucz nigdy nie wraca do przeglądarki i nigdy nie wychodzi z backendu do dostawcy bez potrzeby (wywołania testowe serwer-side). Callback SIWC nie loguje query (`code`/`state`). Ograniczenie SSRF custom providerów (blokada metadanych chmury/link-local, brak redirectów z credentialem, DNS check) — patrz `docs/ai-integration-contract.md` §5.

## 4. Dostęp do Dockera: jawne ryzyko root-equivalent

Dostęp do `docker.sock` = równoważny rootowi na hoście. Dokumentujemy to wprost w UI (ekran agenta: ostrzeżenie) i w README wdrożeniowym:

- Agent działa jako osobny użytkownik w grupie `docker` (NIE jako root, o ile daemon na to pozwala).
- Agent używa socketa w trybie **read + `ContainerRestart` dla wskazanego ID**; reguła kodowa: brak `exec/create/run`, brak mountów, brak odczytu sekretów kontenerów. Egzekwowane przez allowlistę wywołań API Dockera w kodzie agenta (audytowalne `grep`em).
- `container_id` z komendy MUSI pełnoformatowo pasować do kontenera widzianego w ostatnim discovery (brak restartów „na nazwę z palca" spoza inventory).
- Core nie ma pojęcia o sockecie — gdyby Core został przejęty, atakujący dostaje co najwyżej kolejkę `restart` dla już sparowanych agentów (i to jest audytowane), a nie shella.

## 5. SSRF: HTTP checks celowo mogą bić w LAN

HTTP checks użytkownika intencjonalnie obejmują adresy LAN (`192.168.x`, routery, drukarki) — klasyczna ochrona „blokuj prywate IP" byłaby sprzeczna z produktem. Zamiast tego:

- `allow_lan: false` default; check na IP prywatne/link-local wymaga jawnego `allow_lan: true` na definicji checka.
- ZAWSZE blokowane (niezależnie od flagi): metadata endpoints chmur (`169.254.169.254`, `fd00:ec2::254`), `localhost` Core rozumiany jako sam Core? — dozwolony tylko z flagą + ostrzeżeniem; redirecty: max 3, BEZ przechodzenia ze schematu http→credentials w URL; DNS: resolve przy każdym checku z TTL-krótkim cache (brak DNS-pinningu na MVP — udokumentowane ograniczenie, atak DNS-rebinding poza modelem zagrożeń MVP dla single-user LAN).
- Fetch z twardym `timeout_s`, limitem body 1 MB, bez wysyłania nagłówków auth użytkownika (MVP: brak custom headers w ogóle — do potwierdzenia).

## 6. Agent: hardening

- Brak portu nasłuchującego (weryfikowane testem: `ss -lnt` w CI obrazu? — docelowo test integracyjny).
- Plik credentialu `0600`; po `AGENT_REVOKED` kasowanie + stop (bez pętli).
- Opcjonalny pin odcisku certyfikatu Core (`tls_fingerprint` w configu) dla wdrożeń bez publicznego CA.
- Logi agenta bez credentialu/tokenu (redakcja przy zapisie).

## 7. Logi i prywatność

- Logi Core: bez haseł/tokenów/Bearerów/nagłówków HTTP checków/cookies; token bootstrap i credentiale agentów (w tym `next` z rotacji) nigdy nie trafiają do zbiorczych logów ani do `audit_log.detail` w plaintext (dozwolone wyłącznie `agent_id/rotation_id/timestamps/kody`). `audit_log` sanitowany. Rola aplikacyjna: `INSERT + SELECT` na `audit_log` (bez `UPDATE/DELETE`); purge po 1 roku wyłącznie procedurą maintenance z eksportem (szczegóły: data-model §1 i §4).
- Zero telemetrii wychodzącej. Aktualizacje obrazów: użytkownik pulluje sam (watchtower wymieniony w docs jako OPCJA z ostrzeżeniem auto-update).
- Błędy UI: generyczne komunikaty auth („nieprawidłowe dane"), szczegóły w logu serwera.

## 8. Nagłówki i transport

Core serwuje SPA z: `Content-Security-Policy` (same-origin; bez inline scripts — Vite build to spełnia), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`. HSTS tylko za TLS (nie wymuszać na czystym LAN-HTTP, żeby nie zablokować dostępu po IP).

## 9. Otwarte decyzje

| ID | Pytanie | Rekomendowany default |
|---|---|---|
| SEC-001 | Własny TLS w Core vs tylko reverse proxy | MVP: Core słucha localhost:8080 + compose-profil z Caddy jako OPCJA; docs z przykładami |
| SEC-002 | 2FA/TOTP dla single-user | NIE w MVP (hasło 12+ + LAN/TLS wystarczą); epik future |
| SEC-003 | Custom headers w HTTP checks | NIE w MVP (redukuje wyciek sekretów) |

## Iteracja usług — lokalne sondy

Core nie pobiera URL usług. Użytkownik wybiera istniejący lokalny kandydat,
port pochodzi z discovery; edytowalna jest tylko ścieżka względna. Schematy
mutacji są ścisłe, cookie/CSRF/origin i blokady revokacji S1 nadal obowiązują.
Agent sprawdza candidate_id i port lokalnego discovery, odpytuje wyłącznie
numeryczny `127.0.0.1`, bez redirectów, proxy, cookies, auth czy nagłówków
użytkownika. Body sond nie jest czytane ani logowane. Timeout 1–10 s,
interwał 15–3600 s; limit workerów 4. Fingerprint Jellyfin jest osobnym,
ograniczonym odczytem publicznego endpointu dla już wykrytego portu 8096.

Discovery czyta `/proc/net`, fd własnego UID, comm/stat/exe; wyjątek to
wąski parser portów argv docker-proxy. Bez shella, Docker socket, env,
pełnego cmdline na wire. Reguły pewności nie stanowią kryptograficznej
identyfikacji usługi. IPv6/LAN bez dowodu loopback nie ma presetu HTTP.

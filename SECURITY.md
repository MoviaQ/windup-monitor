# Security policy — Windup Monitor

> Repo jest publiczne open source (Apache-2.0).

## Zgłaszanie podatności

**Nie zgłaszaj podatności w publicznym issue.** Użyj prywatnego kanału:
GitHub → Security → Report a vulnerability (Security Advisories, private)
na repozytorium `windup-monitor`. Podaj: wersję/tag, komponent
(core/web/agent), kroki reprodukcji, wpływ i propozycję naprawy.
Nie dołączaj prawdziwych sekretów — używaj danych testowych.

Wspierana jest wyłącznie bieżąca gałąź `main`.

## Model bezpieczeństwa (skrót)

- **Single-user, self-hosted, bez telemetrii wychodzącej.** Brak kont
  zewnętrznych; odpowiedzialność za sekrety i ekspozycję sieciową ponosi
  wdrożenie.
- **Granice:** Internet → Core (TLS reverse proxy), Agent → Core (Bearer,
  outbound-only), Web → Core (cookie sesji). Core **nigdy** nie montuje
  `docker.sock`.
- **Auth:** argon2id (OWASP defaults), hasło ≥ 12 znaków, sesja `HttpOnly`
  `SameSite=Lax` `Secure` (`__Host-` w prod), CSRF (`X-CSRF-Token`) + kontrola
  `Origin`, rate-limity logowania/enrolla.
- **Sekrety agentów:** tylko hashe argon2id w DB; plaintext wyłącznie raz w
  odpowiedzi enroll i w pliku agenta `0600`. Rotacja: agent generuje `next` i
  zapisuje lokalnie przed `POST /rotate`; Core trzyma wyłącznie hash; revoke
  czyści oba hashe bez overlap.
- **Logi:** redakcja `password`/`token`/`cookie`/`Authorization`/`credential`;
  `audit_log` nie zawiera plaintextu (dozwolone `agent_id`, `rotation_id`,
  kody, czasy).
- **Nagłówki SPA:** CSP (same-origin), `nosniff`, `no-referrer`, COOP,
  `frame-ancestors 'none'`; HSTS tylko za TLS.

Pełny opis: [`docs/security.md`](docs/security.md),
[`docs/agent-protocol.md`](docs/agent-protocol.md),
[`core/CONTRACT.md`](core/CONTRACT.md).

## `audit_log` — uprawnienia roli aplikacyjnej

`audit_log` jest append-only. Aplikacja wykonuje wyłącznie `INSERT`/`SELECT`.
W produkcji egzekwuj to osobną rolą DB (Core łączy się rolą bez `UPDATE`/
`DELETE` na `audit_log`), np.:

```sql
-- rola właściciela schematu tworzy tabelę/migracje; rola aplikacji tylko czyta/dopisuje
CREATE ROLE statuspilot_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE statuspilot TO statuspilot_app;
GRANT USAGE ON SCHEMA public TO statuspilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO statuspilot_app;
REVOKE UPDATE, DELETE ON audit_log FROM statuspilot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO statuspilot_app;
```

`DATABASE_URL` Core powinien wskazywać rolę aplikacyjną; migracje uruchamiaj
rolą właściciela. Purge po 1 roku wyłącznie udokumentowaną procedurą
maintenance z eksportem (data-model §1/§4) — nigdy „cichym” kasowaniem.

## Docker: ryzyko root-equivalent

Dostęp do `docker.sock` jest równoważny rootowi na hoście. W S1 agent **nie
używa** Dockera, a Core go nie montuje. Gdy w S2 dojdzie odczyt/restart:
agent działa jako osobny użytkownik w grupie `docker`, używa wyłącznie
allowlisty wywołań (read + `ContainerRestart`), bez `exec/create/run`.

## Zakres poza modelem zagrożeń MVP

DNS-rebinding w HTTP checks, ochrona przed przejęciem hosta, w którym działa
Core, oraz multi-tenant — poza zakresem MVP dla single-user LAN.

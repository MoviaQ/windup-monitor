# Contributing — Windup Monitor

> Repo jest publiczne open source na licencji Apache-2.0 (patrz
> [`LICENSE`](../LICENSE)). Wysyłając wkład (PR, issue, komentarz)
> zgadzasz się, że podlega on warunkom Apache-2.0 (§5 licencji).

## Zasady repo — main tylko przez PR

`main` akceptuje zmiany **wyłącznie przez pull request**. Bezpośredni
push na `main` jest odrzucany przez zdalną ochronę gałęzi (lokalny
`git push` na `main` jest technicznie możliwy, ale remote go odrzuci —
to celowe: historia `main` jest linią scaleń PR).

- Gałęzie robocze: `feat/<temat>`, `fix/<temat>`, `docs/<temat>`,
  `chore/<temat>`.
- Każdy PR: opis co/dlaczego, testy zielone, review wymagane (patrz
  [`docs/publication-policy.md`](docs/publication-policy.md)).
- CI musi być zielone przed merge; merge tylko gdy branch jest aktualny
  względem `main` (require up-to-date).

## Zasady repo

- Dokumentacja i komunikacja: **po polsku**. Kod, identyfikatory, nazwy
  komend/plików: **po angielsku**.
- Kanoniczne nazwy statusów i maszyn stanów pochodzą z
  [`docs/data-model.md`](docs/data-model.md) §5 i są powielane bez zmian w
  API, UI i testach.
- Protokół agent–Core ma wersję (nagłówek `Agent-Protocol-Version: 1`); zmiana
  niekompatybilna wymaga bumpa wersji i notki w `docs/agent-protocol.md`.
- Migracje Prisma w MVP są **wyłącznie addytywne** (nowa tabela / kolumna
  NULL-able / indeks). Zmiany destrukcyjne wymagają osobnego planu i backupu.
- Nigdy nie commituj sekretów (`.env`, tokeny, credentiale). Do konfiguracji
  używaj `.env.example`.

## Środowisko

Instrukcje uruchomienia (dev i Compose) oraz testy: [`README.md`](README.md).
W skrócie:

```sh
npm ci
./scripts/dev-db.sh && export DATABASE_URL=...
npm run lint --workspace core
npm run typecheck --workspace core
npm run test --workspace core        # wymaga prawdziwego PostgreSQL
```

## Pull request — checklista

- [ ] `lint`, `typecheck`, `build` i `test` zielone dla zmienionego pakietu.
- [ ] Testy dodane/zmienione razem z kodem (integracja na realnej DB, bez mocków
      bazy).
- [ ] Brak sekretów w kodzie, logach i `audit_log` (test redakcji przechodzi).
- [ ] Dokumentacja zaktualizowana, jeśli zmienia się kontrakt
      (`docs/*`, [`core/CONTRACT.md`](core/CONTRACT.md), `agent/CONTRACT.md`).
- [ ] Zmiana bezpieczeństwa (auth, sekrety, dostęp do Dockera) opisana w PR z
      uzasadnieniem i oceną ryzyka.

Zmiany protokołu, kolejki komend i hardeningu (S4/S6) wymagają review drugiej
osoby zgodnie z [`kanban.md`](kanban.md) §4.

## Licencja wkładu

Wkład podlega Apache-2.0. Wysyłając PR potwierdzasz, że masz prawo
udostępnić zmianę na tych warunkach.

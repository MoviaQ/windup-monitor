## Co / dlaczego

## Testy

- [ ] `npm run lint` (core + web)
- [ ] `npm run typecheck` (core + web)
- [ ] `npm run test` (core na realnym PostgreSQL + web)
- [ ] `go vet ./...` + `go test ./...` (agent, jeśli dotyczy)
- [ ] `docker compose config` (jeśli dotyczy deploy)

## Bezpieczeństwo

- [ ] Brak sekretów w kodzie, logach i `audit_log`
- [ ] Zmiana auth/sekretów opisana z uzasadnieniem i oceną ryzyka (jeśli dotyczy)

## Dokumentacja

- [ ] Zaktualizowano `docs/*` / kontrakty, jeśli zmienia się kontrakt
- [ ] Polityka `main`-tylko-PR przestrzegana (ten PR jest na gałęzi `feat|fix|docs|chore/*`)

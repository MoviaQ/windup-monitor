# Publication & branch policy — windup-monitor (public OSS, Apache-2.0)

Repo docelowe: [`MoviaQ/windup-monitor`](https://github.com/MoviaQ/windup-monitor),
**PUBLIC**. Ta polityka obowiązuje od pierwszego pushu `main` na GitHub.

> **Stan 2026-10-20 (pre-publish):** konto publikujące uwierzytelnione jako
> **`MoviaQ`** (GitHub user, scopes: `gist`, `read:org`, `repo`, `workflow`;
> `gh` 2.102.0 z `.cache/bin`). Repo `MoviaQ/windup-monitor` **jeszcze nie
> istnieje** (`gh repo view` → 404) — nic nie zostało wypchnięte, zdalne CI
> nie działa. Oczekujemy wyłącznie na techniczne potwierdzenie secret review;
> potem: create PUBLIC → pojedynczy bootstrap push `main` → ochrona z §3.
> `CODEOWNERS` wskazuje `@MoviaQ`.

## 1. Jedyna droga na `main`: pull request

- `main` akceptuje zmiany **wyłącznie przez PR** (merge, squash lub
  rebase — decyzja przy merge, domyślnie squash dla małych zmian).
- Bezpośredni push na `main` jest **odrzucany przez zdalne reguły**
  (branch protection / ruleset). Lokalnie `git push origin main`
  technicznie się wykona, ale remote odpowie odmową — to celowe.
  Lokalny commit na `main` jest dozwolony, publikacja — tylko przez PR.
- Pierwszy import na pusty remote to jedyny wyjątek bootstrapowy:
  jednorazowy push inicjalnego commita na `main`, **przed** włączeniem
  ochrony. Zaraz po nim włączamy reguły z §3.

## 2. Wymagania PR

- Minimum **1 approving review** od osoby innej niż autor.
- **Dismiss stale approvals**: nowa wersja kodu unieważnia stare akcepty.
- **Require conversation resolution**: wszystkie wątki muszą być
  rozwiązane przed merge.
- **Wymagane checki CI** (dokładne nazwy jobów z
  [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — żadnych
  wymyślonych kontekstów):
  - `core (lint, typecheck, build, real-Postgres tests)`
  - `web (lint, typecheck, test, build)`
  - `agent (vet, test, build linux amd64+arm64)`
  - `compose config validity`
- Branch musi być **up-to-date z `main`** (strict): PR wymaga rebase /
  merge `main` i ponownego zielonego CI.
- Bez signed-commit requirement (świadomie poza zakresem).

## 3. Twarda ochrona (stosowana po pierwszym pushu)

Klasyczny branch-protection payload (REST) — patrz
[`branch-protection-payload.json`](branch-protection-payload.json):

- `required_pull_request_reviews`: 1 approval, dismiss-stale,
  require-code-owner-reviews, require-conversation-resolution.
- `required_status_checks`: strict + 4 konteksty z §2.
- `enforce_admins: true` — admin też nie omija; brak wyjątków (no bypass).
- `restrictions: null` (każdy z dostępem przez PR), ale
  `allow_force_pushes: false`, `allow_deletions: false`.

Na publicznych repo kont personalnych (free) odpowiednik to **Ruleset**
(branch ruleset): reguły jak wyżej są dostępne bezpłatnie dla repo
publicznych. Jeśli UI nie oferuje klasycznej ochrony, załóż ruleset
o tej samej treści. Weryfikacja: aktualna dokumentacja GitHub
(branch protection / rulesets) przed zastosowaniem.

## 4. CI i sekrety

- Workflow ma `permissions: contents: read` (least privilege).
- Job `compose` używa wyłącznie atrap (`ci-dummy-password`,
  `ci-session-secret-…`) — żadnych sekretów repo ani fork-PR secrets.
- Testowe klucze w `core/test/*` (`sk-or-v1-…`, `local-secret-…`) to
  fikcyjne fixture — nie są prawdziwymi sekretami.

## 5. Export hygiene (co nigdy nie trafia do git)

Gitignore blokuje: `.env` / `.env.*` (poza `.env.example`), `*.pem`,
`*.key`, `bootstrap-token`, `core/data/`, `.tmp/`, `.cache/`, logi,
`dist/`, `node_modules/`, binarki Go (`agent/bin/`), `*.dump`,
`*.sql` backupy — z wyjątkiem **źródłowych migracji Prisma**
(`core/prisma/migrations/*/migration.sql`) i pointera
(`core/src/public-endpoints/migration.sql`), które są kodem.
`.env.example` trzyma wyłącznie placeholdery (`change-me-…`).
Lokalny `.tmp/s1-review-access.json` zawiera prawdziwe dane logowania
testowego — jest ignorowany i **nigdy** nie wchodzi do commita.

## 6. Po publikacji

- Każdy kolejny import/zmiana: gałąź `feat|fix|docs|chore/*` + PR.
- Równoległy task kart usług (`ServicesPage`, `PublicEndpoints`)
  ląduje jako snapshot w imporcie, potem ewentualny follow-up PR
  zgodnie z tą polityką.
- `CODEOWNERS` wskazuje właściciela konta: `* @MoviaQ` (reguła wymagana
  przez `require_code_owner_reviews` w §3).

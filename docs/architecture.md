# Architektura Windup Monitor

> Status implementacji: **slice S1 zaimplementowany (2026-10-19)** — auth/bootstrap,
> pairing, metryki hosta → PostgreSQL → dashboard. Kontrakt wykonawczy S1:
> [core/CONTRACT.md](../core/CONTRACT.md); dowód: [iterations/s1.md](iterations/s1.md).
> Docker discovery/HTTP checks/incydenty/recovery/AI/PWA z tego dokumentu to
> **plan faz S2–S7** (kanban), nie zaimplementowane — patrz „Poza S1" niżej.
> Wersja dokumentu: 0.2 (2026-10-19).
> Powiązane: [agent-protocol.md](agent-protocol.md) (protokół v1), [data-model.md](data-model.md) (schema i stany), [security.md](security.md) (granice), [ui-design.md](ui-design.md) (M3), [../kanban.md](../kanban.md) (plan).

## 1. Cel i nie-cele

**Cel (MVP):** self-hosted monitoring + deterministyczne automated recovery dla 1 użytkownika (homelab / mały VPS-fleet), bez kont zewnętrznych i bez telemetrii.

**S1 (zaimplementowany 2026-10-19):** metryki hosta (CPU/RAM/dysk/sieć/uptime/
historia) → PostgreSQL → dashboard z rozróżnieniem online/stale/offline,
auth/bootstrap, pairing, rotacja/revokacja credentialu (API+CLI; UI rotacji
w SP-105b). Dowód: [iterations/s1.md](iterations/s1.md).

**MVP docelowy (fazy S2–S4, NIE zaimplementowane):** Docker discovery/status/
uptime/restarts/resources, HTTP checks (interval/timeout/failure threshold),
incydenty + historia, ręczny scoped restart kontenera + playbooki opt-in
z cooldown/retry cap/weryfikacją/eskalacją/audytem. Monitoring działa bez
otwartego UI.

**Poza MVP (future, nie projektować na zapas):** billing/org/marketplace, multi-user/RBAC, AI BYOM (Observer → Operator → Admin, nigdy bypass policy), HA/multi-Core, agent Windows/macOS.

## 2. Komponenty (3 + infra)

```
┌─────────────┐  outbound HTTPS poll   ┌──────────────┐  SQL   ┌────────────┐
│ Agent (Go)  │ ─────────────────────► │ Core (TS)    │ ─────► │ PostgreSQL │
│ host +      │ ◄── komendy (poll) ─── │ Fastify mono │        │ 16          │
│ docker.sock │                        │ :8080        │        └────────────┘
└─────────────┘                        └──────┬───────┘
                                              │ serves SPA + API
                                              ▼
                                       ┌──────────────┐
                                       │ Web (React/ │
                                       │ TS/Vite SPA) │
                                       └──────────────┘
```

| Komponent | Rola | Czego NIE robi (granica) |
|---|---|---|
| **Core** (TS/Node, modularny monolit) | auth/session, ingest metryk, scheduler HTTP checks, silnik incydentów, kolejka komend, playbooki, serwowanie SPA/API, retencja/rollupy | NIE dotyka docker.sock (nawet gdy Core i Docker na tym samym hoście); NIE wykonuje shella; NIE dzwoni na zewnątrz poza HTTP checks i pobieraniem niczego |
| **Agent** (Go, 1 binarka) | zbiera CPU/RAM/dysk/sieć/uptime, czyta lokalny docker.sock (discovery/status/resources), wykonuje scoped `restart kontenera`, raportuje wyniki | NIE nasłuchuje na porcie; NIE przyjmuje połączeń przychodzących; NIE wykonuje dowolnych komend/shella; NIE gada z nikim poza sparowanym Core |
| **Web** (React SPA) | dashboard (online/stale/offline), historia, incydenty, akcje recovery, pairing, konfiguracja | NIE przechowuje sekretów w cache; NIE kolejkuje komend offline (read-only stale state) |
| **PostgreSQL 16** | jedyne trwałe storage (tabele: users, agents, metrics, checks, incidents, commands, audit) | — |
| Docker Compose | jedyny wspierany deploy MVP | — |

**Redis: NIE na MVP** (decyzja `DEC-001`). Scheduler in-process + kolejka komend w Postgres (`FOR UPDATE SKIP LOCKED`) wystarczą dla 1 użytkownika i ≤ ~20 agentów. Redis wraca tylko, gdy jeden proces Core przestanie wystarczać (HA) — punkt pomiaru: opóźnienie claimu komend / backlog schedulera.

## 3. Moduły Core (monolit, granice importów)

```
core/src/
  auth/        # bootstrap, login, session, CSRF, argon2id
  agents/      # pairing, registry, credentiale (hash), heartbeat/stale/offline
  ingest/      # przyjmowanie batchy metryk, idempotency, walidacja zakresów
  metrics/     # zapis próbek, rollupy 5-min, retencja
  checks/      # scheduler HTTP checks, progi, flapping guard
  incidents/   # maszyna stanów open→acknowledged→resolved, eskalacja
  commands/    # kolejka scoped restart, claim/TTL/retry cap, journaling
  playbooks/   # definicje opt-in: cooldown, verification, audit
  web/         # serwowanie builda SPA, manifest, headery bezpieczeństwa
  db/          # Prisma schema/migracje, jobs (rollup/retention/eskalacja)
```

Zasada: `checks/` i `playbooks/` nie wołają Dockera ani HTTP bezpośrednio poza zdefiniowane porty (`commands/`, outbound fetch z allowlistą). `ingest/` nie ufa zegarowi agenta (szczegóły: agent-protocol § zegary).

## 4. Przepływy (skrót; pełne sekwencje w agent-protocol i data-model)

1. **Pairing:** UI generuje one-time token (TTL 15 min, single-use) → operator wkleja do agenta → agent `POST /api/v1/agent/enroll` → dostaje `agent_id + credential` (pokazywane raz; w Core tylko hash). Rotacja/revokacja z UI.
2. **Heartbeat:** co 15 s (default) agent `POST /api/v1/agent/heartbeat` z batchą metryk + `seq` monotoniczny + wyniki komend. Core odpowiada listą `pending_commands` (long-poll opcjonalnie, max 25 s). Brak heartbeatu > 45 s → `stale`; > 5 min → `offline` (defaulty do potwierdzenia).
3. **HTTP check:** scheduler Core (co `interval`) → fetch z timeoutem → N kolejnych porażek (`failure_threshold`) → incydent `open`. Sukces → `resolved` dopiero po M kolejnych sukcesach (flap guard).
4. **Recovery:** incydent `open` + playbook opt-in → `commands` (scoped `restart_container {container_id}`) → agent claimuje przy pollingu → wykonuje → raportuje wynik z TTL → Core weryfikuje (health check) → `resolved` albo retry w limicie → eskalacja (powiadomienie) + wpis audytowy. Ręczny restart z UI przechodzi tę samą kolejkę (bez cooldownu playbooka, ale z limitem i audytem).
5. **Niejednoznaczny wynik restartu:** restart uznany za „niepotwierdzony" (agent stracił widoczność kontenera / timeout po wysłaniu sygnału) → kanonicznie `commands.state='failed' + outcome='AMBIGUOUS'` z opisem w `result_detail`; trwały zakaz automatycznego retry tej komendy; wymagana weryfikacja przez kolejny discovery lub akcję operatora. Uzasadnienie: restart nie jest idempotentny obserwacyjnie — ślepy retry może zabić świeży, zdrowy kontener (szczegóły: agent-protocol § 7, schema: data-model §1 i §5).

## 5. Proponowana struktura repo

```
.
├── README.md                  # ten plik (status planowania)
├── kanban.md                  # plan pracy
├── docs/                      # architecture.md, agent-protocol.md, data-model.md, security.md, ui-design.md
├── core/                      # Fastify + Prisma; Dockerfile
│   ├── src/ (moduły z §3)
│   ├── prisma/schema.prisma + migrations/
│   └── package.json
├── agent/                     # Go module; Dockerfile; systemd unit example
│   ├── cmd/windup-monitor-agent/
│   └── internal/{config,collect,docker,client,exec}/
├── web/                       # React + Vite + TS
│   ├── src/{tokens,components,pages,api,pwa}/
│   └── public/manifest.webmanifest + icons/
├── deploy/
│   ├── docker-compose.yml     # core + db (agent: binarka/systemd; profil kontenera agenta explicite future)
│   └── examples/agent-config.example.yaml
├── .github/workflows/ci.yml   # lint/typecheck/test/build + SBOM (future: cosign)
└── LICENSE (Apache-2.0 PROPONOWANA — do potwierdzenia)
```

Jeden obraz `core` serwuje API i SPA (mniej ruchomych części w self-hoście). Wersjonowanie: tag git = tag obrazu (`vX.Y.Z`); migracje Prisma `migrate deploy` przy starcie Core.

## 6. Uzasadnienia stacku

| Wybór | Dlaczego | Odrzucone alternatywy |
|---|---|---|
| Fastify (Node) | mały overhead, schema-validacja, jeden język z Web | Express (luźniejszy ekosystem walidacji); Go-Core (dwa języki więcej niż trzeba) |
| PostgreSQL 16 | relacje + `SKIP LOCKED` kolejka + retencja partycjonowaniem w przyszłości; jeden stateful serwis | SQLite (locki przy ingest+UI), Redis streams (kolejny stateful) |
| Prisma | migracje i typy z jednego schema; mniej ręcznego SQL na start | Drizzle (mniej konwencji migracyjnych), raw SQL (koszt utrzymania) |
| Agent w Go | 1 statyczna binarka, mały footprint, dobry dostęp do `/proc` i docker.sock | Python (runtime na hoście), Rust (koszt czasu) |
| React + Vite + TS | ekosystem, szybki build, PWA plugin | Next/SSR (niepotrzebne; Core serwuje statyki) |
| Tokeny M3 ręcznie (CSS vars) | `@material/web` jest w trybie maintenance bez implementacji Expressive na Web (źródło: m3.material.io/develop/web); MUI implementuje MD2 dla komponentów materialowych (źródło: mui.com supported-components) — żadna z tych dróg nie daje aktualnego M3 „z pudełka" na Web | MUI jako baza M3, `@material/web` jako baza Expressive |

## 7. Deploy / lifecycle / upgrade / backup / restore

- **Deploy:** `docker compose up -d` (usługi: `core`, `db`). Agent na MVP instalowany na hostach docelowych jako binarka/systemd (jedyna wspierana forma; kontener z mountem socketa explicite poza MVP — możliwy profil compose w przyszłości, po decyzji bezpieczeństwa). Konfiguracja przez `.env` (sekrety) + wolumeny `pgdata`, `core-data` (np. cache ikon — nie sekrety).
- **Upgrade:** pull obrazu → `migrate deploy` automatycznie przy starcie → healthcheck `/api/v1/health`. Migracje MVP wyłącznie addytywne i kompatybilne wstecz (nowa tabela / kolumna NULL-able / nowy indeks). Nie ma „rollbacku schematu" poleceniem — `migrate resolve` nie cofa migracji. Procedura powrotu: (a) zmiana kompatybilna → deploy poprzedniego tagu obrazu (schemat czyta dalej); (b) zmiana niekompatybilna → restore backupu (`pgdata` + `psql < dump`) wg runbooka, potem deploy tagu pasującego do przywróconego schematu.
- **Backup:** `pg_dump` (cron w hoście lub sidecar docelowo) + kopia `.env`. Restore: świeży `pgdata` + `psql < dump`. RPO/RTO: best-effort domowy (default: backup dzienny, do potwierdzenia).
- **CI/CD (open source):** GitHub Actions: `lint + typecheck + test + build` na PR; tag → build obrazów `core`/`agent` (multi-arch amd64/arm64), SBOM (Syft/Grype — proporcjonalnie), podpisywanie cosign (gdy repo publiczne). Release notes z kanbana.

## 8. MVP vs future (twarda granica)

Zrealizowany S1 (dowód: [iterations/s1.md](iterations/s1.md)): auth/bootstrap,
pairing, metryki hosta → DB → dashboard, rotacja/revokacja (API+CLI),
health/ready, SPA serwowana przez Core.

Pozostały MVP (fazy S2–S4, plan w kanbanie): metryki + Docker status + HTTP
checks + incydenty + scoped restart + playbooki + PWA read-only offline +
audit. Wszystko inne (AI BYOM, multi-user, marketplace, HA) to osobne epiki
w kanbanie (`SP-8xx`), bez kodu „na zapas" (bez abstrakcji providerów AI w MVP).

## 9. Otwarte decyzje

| ID | Pytanie | Rekomendowany default |
|---|---|---|
| DEC-001 | Redis w MVP? | NIE; próg powrotu: backlog schedulera/claimów |
| DEC-002 | ORM | Prisma |
| DEC-003 | Interwały (heartbeat 15 s / stale 45 s / offline 5 min) | jak w §4, do potwierdzenia w slice S1 |
| DEC-004 | Retencja (48 h surowe / 90 d rollupy / 1 r incydenty) | tak, szczegóły w data-model |
| DEC-005 | CI hosting | GitHub Actions |
| DEC-006 | Multi-arch obrazy od dnia 1 | TAK (amd64+arm64 — homelaby na ARM) |
| DEC-007 | Licencja Apache-2.0 | PROPOZYCJA użytkownika (default rekomendowany) do potwierdzenia przed publikacją: lokalne pliki w SP-008 (kanban S0b), rozbudowa w SP-700 |

## Iteracja usług

Agent: discovery cache → ograniczony scheduler HTTP → trwały outbox v1.
Core: uwierzytelniony heartbeat → jedna transakcja seq/metrics/discovery/results
→ stan N/M i incydenty → sesyjne API services/discovered/history.
Web: Status (metryki hosta) i Usługi (wykrywanie, zatwierdzanie i historia),
polling 15 s. Core nigdy nie odpytuje usług na zdalnym hoście. Docker
inventory i automatyczne recovery pozostają osobnymi przyszłymi etapami.

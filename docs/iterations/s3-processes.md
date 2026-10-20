# Iteracja S3 — CPU/RAM procesów usług, 2026-10-19

> Dokument historyczny: ówczesna nazwa produktu „StatusPilot”; obecnie **Windup Monitor** (UI: **wind-up monitor**). Nazwy baz/ścieżek w treści są historyczne i pozostają bez zmian dla zgodności.

Status: implementacja lokalna zweryfikowana; wdrożenie live i niezależny review
w toku. Zakres wąski: dwie metryki rzeczywistego procesu (CPU, RSS) dla
rozpoznanych usług Jellyfin/T3/OpenCode + prostsza lista wykrytych usług.
Bez publicznego statusu Jellyfin (czekamy na publiczny URL), bez Dockera,
bez shell/exec i bez nowego obrazu.

## Skąd wiemy, że usługa istnieje

Discovery pozostaje bez zmian: `/proc/net/tcp{,6}` (LISTEN) + fd → inode,
`comm`/`stat`/`exe` oraz wąski parser `docker-proxy`. `candidate_id` to
`kind-port`. Na tej podstawie kandydat ma `kind`, `confidence`, `source`
i `process_started_at`. PID właściciela jest wyłącznie lokalny (`json:"-"`)
i nigdy nie opuszcza hosta.

Metryki procesu są liczone tylko wtedy, gdy właściciel jest jednoznaczny:

- T3/OpenCode: dokładnie jeden fd-proven PID na eligibilnym bindzie
  (127.0.0.1/0.0.0.0); dwóch różnych właścicieli = brak danych;
- Jellyfin: dokładnie jeden proces `comm=jellyfin` **i** potwierdzony
  publiczny fingerprint `/System/Info/Public`; nigdy PID `docker-proxy`;
- brak uprawnień, proces zniknął, wiele procesów albo brak dowodu →
  `null` („Brak danych”), nigdy 0.

## Wire (addytywny, canonical)

`POST /api/v1/agent/heartbeat` może nieść maks. 64 wpisy:

```json
"service_process_metrics": [
  {
    "candidate_id": "jellyfin-8096",
    "process_started_at": "2026-10-19T07:00:00Z",
    "observed_at": "2026-10-19T10:00:15Z",
    "cpu_percent": 3.2,
    "memory_rss_bytes": 86432112
  }
]
```

`cpu_percent: null` przy pierwszej próbce i każdej zmianie PID/starttime;
wartość jest procentem **jednego rdzenia** i może przekraczać 100 na
wielordzeniowym hoście. `<pid>/stat` daje utime+stime/starttime/rss;
`<pid>/status VmRSS` (kB → bajty) ma pierwszeństwo, `stat.rss × page size`
jest fallbackiem. Delta ticków dzielona przez rzeczywisty czas od poprzedniej
próbki (nie stałe 15 s). Sampler czyta maks. 64 PID-ów, co najwyżej raz na
15 s; heartbeat nie czeka na discovery ani sondy HTTP.

## Core i API

Nowa migracja `20261019110000_process_metrics` tworzy
`service_process_metrics` (PK `agent_id,candidate_id`, `process_started_at`,
`observed_at`, `cpu_percent`, `memory_rss_bytes`). Ingest jest w tej samej
transakcji/blokadzie agenta co `seq`:

- scope: tylko uwierzytelniony agent i jego dostępny, znany kandydat;
- exact identity: `process_started_at` musi być równe bieżącemu discovery;
- nowszy `observed_at` wygrywa, starsze i przyszłe są ignorowane;
- wartości muszą być skończone i nieujemne; błąd kształtu = `INVALID_BODY`;
- pojedynczy brak danych procesu nie odrzuca metryk hosta.

`ServiceSummary` i `DiscoveredCandidate` mają addytywne
`processCpuPercent`, `processMemoryRssBytes`, `processMetricsAt`. API zwraca
`null` dla obserwacji starszej niż 45 s, agenta poza `online`, kandydata
niedostępnego lub niezgodnego `process_started_at`; nie utrzymuje w
nieskończoność starych wartości.

## Web

Karty monitorowanych usług pokazują dwie proste wartości: „CPU procesu”
(z tooltipem „100% = jeden rdzeń”) i „RAM procesu” w MiB; `null` to
„Brak danych”. Zakładka wykrytych renderuje wyłącznie dostępne, rozpoznane
kandydaty HTTP, które można włączyć; licznik i pusty stan liczą tę widoczną
listę, a nierozpoznane porty pozostają nietknięte w backendzie. Etykiety
rozpoznania to „Rozpoznano po procesie i porcie” albo „Rozpoznanie
częściowe” — bez zrzutu pól technicznych. Kolory pozostają na tokenach navy.

## Testy i weryfikacja

- Go: `process_metrics_test.go` (pierwsze CPU null, delta z rzeczywistego
  czasu, >100%, PID reuse reset, MiB, fallback/permissions, throttling) +
  discovery PID (jeden właściciel, ambiguous, Jellyfin fingerprint).
- Core (real PostgreSQL): nowy plik `process-metrics.test.ts` — first-null,
  >100%, reordered/stale, start mismatch, unknown candidate, scope/API null
  po 45 s, odrzucenie ujemnych/przyszłych. Dodatkowo regresyjnie
  `services.test.ts` i `heartbeat.test.ts`.
- Web: `ServicesPage.test.tsx` — filtrowanie tylko znanych HTTP, licznik,
  null „Brak danych”, 137,5% bez clampowania, etykiety rozpoznania.

## Ograniczenia

To nadal dowód o ograniczonej pewności (Jellyfin jest root-owned, fd może być
niedostępny). Brak metryk dla niejednoznacznych procesów jest celowy.
Publiczny status Jellyfin nie jest częścią tej iteracji. Bez commit/push,
bez zdalnego CI i bez przebudowy obrazu Docker.

## Dowody live (2026-10-19, review stack :18080)

Backup przed migracją: `.tmp/review/pre-s3-processes.dump` (świeży, nie
`pre-services.dump`). Migracja `20261019110000_process_metrics` zastosowana na
`statuspilot_review`; Core z nowym `dist` i Web z nowymi assetami
zrestartowane przez `.tmp/review/start-core.sh`; agent zastąpiony nową
binarką bez zmiany `agent-state` (ten sam seq/credential).

Normalne API (sesja z istniejącego pliku 0600, bez wypisywania sekretów)
zwróciło dla trzech monitorowanych usług metryki rzeczywistych procesów:

| usługa | kandydat/port | CPU procesu | RAM procesu | proces |
|---|---|---|---|---|
| Jellyfin | `jellyfin-8096` | ~0% (realny, nie null) | ~84–85 MiB | PID `jellyfin`, nie docker-proxy |
| T3 Code | `t3-code-3773` | ~15% | ~365–377 MiB | fd-proven owner |
| OpenCode | `opencode-4096` | ~3–5% | ~699–732 MiB | fd-proven owner |

`service_process_metrics` w PostgreSQL zawiera tylko `candidate_id`,
`process_started_at`, `observed_at`, `cpu_percent`, `memory_rss_bytes` — brak
kolumny PID. Kolejne próbki po 15 s zmieniały `observed_at`, CPU i RSS, więc
wartości nie są zamrożone. 32 nierozpoznane nasłuchy pozostały w backendzie,
ale UI pokazał licznik 5 (tylko dostępne znane HTTP).

Własna sanity wizualna (cached Chromium; AppArmor blokuje sandbox T3):
`node .tmp/review/s3-visual.mjs` — desktop 1440×1000 i mobile 390×844, brak
pageerror i poziomego overflow. Zrzuty:
`.tmp/review/s3-services-desktop.png`, `s3-services-mobile.png`,
`s3-discovered-desktop.png`, `s3-discovered-mobile.png`. Karty pokazują
„CPU procesu”/„RAM procesu”; lista wykrytych nie zawiera „Nierozpoznana
usługa” ani nasłuchów TCP. To sanity właściciela, nie niezależny review.

## Handoff public endpoints

`.tmp/process-resource-handoff.md` — nowy wykonawca może od razu tworzyć
wyłącznie nowe pliki `core/src/public-endpoints/**` i
`web/src/public-endpoints/**`; schema/migracje, ingest, DTO usług i
ServicesPage są zamknięte dla bieżącego zadania. Publiczny check nie jest
wdrażany; URL Jellyfin `https://filmy.moviak.quest` nie jest zaszyty w tej
iteracji.

## Uwaga o równoległym tree

W trakcie końcowej weryfikacji w drzewie pojawiły się nowe pliki
`core/src/public-endpoints/**` innego wykonawcy. Nie były edytowane przez to
zadanie i nie weszły do działającego `dist`. Przez nie pełny `npm run
typecheck`/`lint` z roota może chwilowo raportować błędy wyłącznie w tych
plikach; targeted typecheck/lint oraz build moich plików przeszedł wcześniej,
a live Core działa z zbudowanego wcześniej `dist`.

# Windup Monitor — storage na hoście deweloperskim (fakty, 2026-10-19)

> Dokument factograficzny. Powstał po zgłoszeniu „Docker build: brak miejsca
> (~0,5 GB)" i pytaniu, czy projekt leży na dysku systemowym zamiast na dysku
> danych. Nie zawiera sekretów. Liczby pochodzą z `df`/`findmnt`/`du`/`lsblk`
> wykonanych na tym hoście 2026-10-19.

## 1. Wniosek w jednym zdaniu

**Projekt NIE leży na dysku systemowym — repo i dane Dockera są już na dysku
danych (`/mnt/ai_data`, `/dev/sda1`, 458 GB).** Ograniczeniem jest mały dysk
systemowy `/` (13 GB, 98%), na którym *nie ma* kodu ani artefaktów tego
projektu. Nie wykonano żadnej migracji repo, bo była bezcelowa.

## 2. Filesystemy (stan faktyczny)

| Punkt | Urządzenie | FS | Rozmiar | Użyte | Wolne | Użycie% |
|---|---|---|---|---|---|---|
| `/` (system) | `/dev/mapper/ubuntu--vg-ubuntu--lv` (LVM na `/dev/sdb3`, ~12,5 GB) | ext4 | 13 GB | 12 GB | **340 MB** | **98%** |
| `/mnt/ai_data` (dane) | `/dev/sda1` | ext4 | 458 GB | 143 GB | 292 GB | 33% |
| repo | `/mnt/ai_data` → `/dev/sda1` | ext4 | — | — | — | — |
| `$HOME` (`/home/moviak`) | `/` → ubuntu-lv | ext4 | — | — | — | — |

- Repo: `/mnt/ai_data/opencode/t3code/data/projects/windup-monitor` →
  `findmnt -T` = `/mnt/ai_data` `/dev/sda1` (dysk danych). Zużycie repo ~608 MB.
  Stara ścieżka `.../windup-pilot` jest symlinkiem zgodności do nowej
  (istniejące skrypty/cwd działają); to ten sam katalog i to samo `.git`.
- Nazwy PostgreSQL (`statuspilot`, `statuspilot_review`), kontener dev
  `statuspilot-test-pg`, cookie sesji i legacy env `STATUSPILOT_*` pozostają
  historycznymi identyfikatorami technicznymi — rebranding ich nie zmienia
  i nie wymaga resetu/migracji danych.
- „Dysk danych 300 GB" z opisu = fizycznie `/dev/sda1` o pojemności **458 GB**
  (465,8 GB w `lsblk`), zamontowany w `/mnt/ai_data`. To ten sam dysk, na którym
  leży projekt — nie ma osobnego „300 GB".
- `sda` (465,8 GB) całkowicie zajęty przez partycję `sda1`. `sdb` (14,9 GB) to
  dysk systemowy (sdb1 EFI, sdb2 /boot, sdb3 LVM → `/`).

## 3. Docker

- `Docker Root Dir: /mnt/ai_data/docker` — **dane Dockera są na dysku danych**.
  Potwierdza to `/etc/docker/daemon.json`: `{ "data-root": "/mnt/ai_data/docker" }`.
  Warstwy kontenerów z `mount` mają ścieżki `/mnt/ai_data/docker/overlay2/...`.
- `docker system df`: Images 14,94 GB, Containers 44,2 MB, Local Volumes 83 MB,
  **Build Cache 0 B**. Nic z buildu nie zalega w cache; nie ma czego odzyskiwać
  po nieudanym `docker build`.
- Kontener Postgresa projektu: `statuspilot-test-pg` (`postgres:16-alpine`) na
  `127.0.0.1:55432`, DB `statuspilot_review` — współdzielony z wcześniejszymi
  testami. Pozostałe kontenery (qbittorrent, sonarr, radarr, jellyfin,
  nextcloud, nginx-proxy-manager, wg-easy, pihole, portainer) to **obce usługi**
  — nie ruszane.

## 4. Co realnie zajmuje dysk systemowy `/` (13 GB, 98%)

Czytelne (bez roota) pozycje `du` na `/`:

| Ścieżka | Rozmiar | Uwaga |
|---|---|---|
| `/usr` | 4,3 GB | system/pakiety |
| `/home` | 2,3 GB | HOME użytkownika (`.local` 1,3 GB, `.cache` 678 MB) |
| `/tmp` | 1,6 GB | scratch **innych** zadań (m.in. `/tmp/cross-src2` 850 MB, `/tmp/hfref` 163 MB, `/tmp/swe_verify`, `/tmp/swegym`) — z 13–16.10, nie ten projekt |
| `/var` | 0,8 GB | logi/apt/system |
| `/boot` | 97 MB | — |

Rozbieżność: `df` pokazuje ~12 GB użyte na `/`, a czytelne `du` sumuje się do
~9,1 GB. Brakujące ~2,9 GB to katalogi **tylko dla roota**, których nie da się
odczytać bez sudo (w tym `mode 0700`):

- `/var/lib/docker` (`drwx--x---` root, data 2026-04-09) — pozostałość po
  wcześniejszym `data-root`, **możliwy** rezydu wielogigabajtowy; nie da się
  potwierdzić ani odzyskać bez roota,
- `/var/lib/containerd` (`drwx------` root) — stan containerd na `/`.

`sudo` na tym hoście **wymaga hasła** (`sudo -n true` → „a password is
required"), więc powyższych katalogów ani nie zmierzono, ani nie tknięto.

### Wnioski o przyczynie „brak miejsca ~0,5 GB"

- Wolne na `/` ≈ 0,3–0,5 GB — to dokładnie rząd wielkości zgłoszenia.
- To **nie** położenie projektu ani dane Dockera (oba na `/mnt/ai_data`).
- Najbardziej prawdopodobne realne źródła: (a) system + HOME + `/tmp` innych
  zadań, (b) nieczytelne bez roota resztki `/var/lib/docker` i
  `/var/lib/containerd` na `/`. Docker build z `data-root` na danych sam z
  siebie pisze warstwy do `/mnt/ai_data` — więc nie on zapełnia `/`.

## 5. Co zmieniono (zakres tego zadania)

Projekt jest już na dysku danych → **migracji repo nie wykonano** (byłaby
bezcelowa i ryzykowna). Zamiast tego ograniczono przyszłe zużycie `/` przez ten
projekt, lokalnie i bez zmian globalnych:

- Dodano katalog cache projektu na dysku danych: `<repo>/.cache/{go-build,go-mod,npm,tmp}`
  (`findmnt -T .cache` = `/mnt/ai_data`).
- Dodano `scripts/env.sh` — źródłowany wrapper ustawiający dla **tego projektu**:
  `GOCACHE`, `GOMODCACHE`, `npm_config_cache`, `TMPDIR` na `<repo>/.cache/...`
  (dysk danych). Użycie: `. scripts/env.sh`.
- Dodano `.cache/` do `.gitignore`.

**Czego świadomie NIE ruszano:** globalnych cache współdzielonych z innymi
projektami (`~/.npm` 219 MB, `~/.cache/go-build` 428 MB, `~/go`),
cudzego `/tmp`, cudzych obrazów/wolumenów Docker, `data-root` demona Dockera,
oraz katalogów root-only na `/` (`/var/lib/docker`, `/var/lib/containerd`).

## 6. Wpływ na miejsce (before → after)

| | before | after |
|---|---|---|
| `/` avail | 340 MB (98% used) | 340 MB (98% used) |
| `/mnt/ai_data` avail | 293 GB (33%) | 292 GB (33%) |

Na `/` **nie zwolniono miejsca** — i jest to zgodne z faktami: ten projekt nie
trzyma tam swoich plików, a cudzych cache/systemu nie usuwamy. Cache buildu Go
wytworzony przy weryfikacji (71 MB) trafił na dysk danych, nie na `/`.
Jedyną realną dźwignią dla `/` byłyby root-only resztki Docker/containerd albo
cudze `/tmp` — poza zakresem i bez dostępu do sudo.

## 7. Weryfikacja działania toolchainów (po zmianach)

- Go: `. scripts/env.sh && ( cd agent && go build -o ../.tmp/... ./cmd/windup-monitor-agent )` → **OK**;
  `go env GOCACHE/GOMODCACHE` wskazują `<repo>/.cache` (dysk danych).
- npm/node: `npm config get cache` = `<repo>/.cache/npm`; `npm ls --workspace web`
  rozwiązuje drzewo zależności → **OK**. `node -v` = v22.22.1, `npm -v` = 10.9.4,
  `go` = 1.22.2.
- Runtime review: `GET /api/v1/health/ready` → **200**; realny agent Go
  `review-demo` = **online** (DB `statuspilot_review`).
- Tailscale: `tailscaled` active; `tailscale serve` działa (stan po stronie
  zadania tailscale-access — patrz kanban/artefakty tego zadania).

## 8. Ograniczenia pozostałe

- Dysk `/` nadal w ~98% — nie rozwiązano tego zadaniem projektowym (brak
  dostępu do sudo; źródła poza projektem).
- `sudo` niedostępne nieinteraktywnie → nie zmierzono/nie odzyskano
  `/var/lib/docker` i `/var/lib/containerd`.
- Nie wykonano `docker compose up --build` (budowa opcjonalna w tym zadaniu);
  `data-root` jest już na danych, więc build pisałby warstwy na `/mnt/ai_data`.
  SP-107 (pierwsza budowa obrazu + zdalne CI) pozostaje follow-upem.

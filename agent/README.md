# Agent Windup Monitor (S1)

Binarka Go (stdlib only, statyczna): zbiera CPU/RAM/dysk/sieć/uptime z Linuksa
i wysyła je do Core protokołem v1 (outbound HTTPS). Bez nasłuchu na porcie,
bez Dockera, bez wykonywania komend — to celowo poza S1. Iteracja usług
dodaje lokalne auto-discovery (Jellyfin/T3/OpenCode z `/proc`) oraz sondy
HTTP loopback wykonywane na hoście agenta (sekcja niżej).

Dokumentacja po polsku; kod i identyfikatory po angielsku (zasada repo).
Kontrakt wire: [CONTRACT.md](CONTRACT.md). Protokół: `../docs/agent-protocol.md`.

## Budowanie

```sh
cd agent
go build -o windup-monitor-agent ./cmd/windup-monitor-agent   # lokalnie
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/windup-monitor-agent-linux-amd64 ./cmd/windup-monitor-agent
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o bin/windup-monitor-agent-linux-arm64 ./cmd/windup-monitor-agent
go test ./...   # testy: parsowanie /proc z fixture'ami, auth/nagłówki,
                # retry byte-identical, 0600, bezpieczeństwo HTTP, rotacja
```

Wymaga Go ≥ 1.22. Zero zależności zewnętrznych (`go.mod` bez `require`).

## Szybki start (dev, loopback)

```sh
# 1) Token jednorazowy: z UI Core (pairing) albo zmienna na czas enrolla.
export WINDUP_MONITOR_ENROLL_TOKEN="<token z Core>"

# 2) Pairing jednorazowy (zapisuje credential 0600, potem wychodzi):
./windup-monitor-agent enroll \
  --core-url http://127.0.0.1:8080 --allow-insecure-http \
  --state-dir ~/.local/share/windup-monitor

# 3) Pętla heartbeat (Ctrl-C = graceful stop):
./windup-monitor-agent run \
  --core-url http://127.0.0.1:8080 --allow-insecure-http \
  --state-dir ~/.local/share/windup-monitor
```

Produkcja: `https://core:8080` (TLS), `--state-dir /var/lib/windup-monitor`,
token **tylko** przez env (nigdy `--enroll-token` — widać w `ps`).

## Konfiguracja

Precedencja: **flagi > `WINDUP_MONITOR_*` env > plik JSON (`--config`) > defaulty**.

| Flaga / env | Default | Opis |
|---|---|---|
| `--core-url` / `CORE_URL` | — (wymagane) | Bazowy URL Core |
| `--state-dir` / `STATE_DIR` | `/var/lib/windup-monitor` | Katalog stanu (0700, patrz niżej) |
| `--hostname` / `HOSTNAME` | hostname OS | Nazwa raportowana w enroll |
| `--interval-s` / `INTERVAL_S` | `15` | Startowy interwał; wartość serwera wygrywa |
| `--ca-file` / `CA_FILE` | — | Dodatkowy PEM CA do TLS Core |
| `--allow-insecure-http` / `ALLOW_INSECURE_HTTP` | `false` | Tylko `http://` loopback (dev) |
| `--enroll-token` / `ENROLL_TOKEN` | — | Token jednorazowy (flaga odradzana) |
| `--enroll-token-stdin` | `false` | Czytaj token z stdin (pierwsza linia) |
| `--config` | — | Plik JSON (przykład: `config.example.json`) |
| `--force` | `false` | `enroll`: nadpisz istniejący credential |
| `--shutdown-timeout-s` | `10` | Limit graceful stop |

`windup-monitor-agent rotate` — jednorazowa rotacja credentialu (generuje `next`,
zapisuje lokalnie 0600, `POST /rotate`, `POST /rotate_confirm`, promocja).

## Pliki stanu i uprawnienia

Katalog: `0700`. Wszystko w nim: `0600`, zapis atomowy (tmp + fsync + rename
+ fsync katalogu).

| Plik | Zawartość |
|---|---|
| `credential.json` | `{agent_id, credential}` |
| `rotation.json` | Oczekująca rotacja (tylko w trakcie `rotate`) |
| `seq` | Ostatni użyty numer sekwencyjny |
| `state.json` | `{config_version, heartbeat_interval_s}` |
| `outbox/*.json` | Bufor niepotwierdzonych kopert (ring, max 20) |

## Instalacja jako usługa (systemd)

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin windup-monitor
sudo mkdir -p /var/lib/windup-monitor
sudo chown windup-monitor:windup-monitor /var/lib/windup-monitor
sudo chmod 700 /var/lib/windup-monitor
sudo install -m 0755 windup-monitor-agent-linux-amd64 /usr/local/bin/windup-monitor-agent
sudo install -m 0644 systemd/windup-monitor-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
# Token jednorazowo (plik środowiskowy 0600, nie wpisuj do unita):
echo 'WINDUP_MONITOR_ENROLL_TOKEN=<token>' | sudo tee /etc/windup-monitor-agent.env >/dev/null
sudo chmod 600 /etc/windup-monitor-agent.env
sudo chown windup-monitor:windup-monitor /etc/windup-monitor-agent.env
sudo systemctl enable --now windup-monitor-agent
```

Przykład unita: [`systemd/windup-monitor-agent.service`](systemd/windup-monitor-agent.service)
(least privilege: własny użytkownik, `NoNewPrivileges`, `ProtectSystem=strict`,
`PrivateTmp`, zapis tylko do `/var/lib/windup-monitor`; bez Dockera w S1).

## Metryki i ograniczenia (Linux)

Źródła: `/proc/stat`, `/proc/loadavg`, `/proc/meminfo`, `/proc/net/dev`,
`/proc/uptime`, `/proc/mounts` + `statfs`. Wymaga czytelnego `/proc`
(standard na hoście; w kontenerze liczby opisują host/namespace — do
oceny przy S2, tu tylko dokumentujemy).

- Dysk: `/` + trwałe fs (ext4/xfs/btrfs/zfs/…) bez `/snap`, `/var/lib/docker`,
  `/var/lib/kubelet`; bez tmpfs/pseudo-fs.
- Sieć: suma interfejsów bez `lo`; `rx_bps/tx_bps` z delty (pierwsza próbka: 0).
- Restart agenta zeruje baseline CPU/sieci (pierwsza próbka po starcie ma
  realną deltę CPU dzięki 500 ms warmupowi; luka w wykresie Core to przerwa,
  nie ekstrapolacja).

## Kody wyjścia

`0` ok · `1` błąd (w tym wyczerpane `BAD_CREDENTIAL`, brak tokenu przy braku
credentialu) · `2` wymagany upgrade protokołu · `3` credential odwołany
(`AGENT_REVOKED`: pliki wyczyszczone, wymagany re-enroll).

## Auto-discovery usług i HTTP checks (iteracja usług)

Agent wykrywa lokalne usługi i bada je sondami HTTP — niezależnie od UI,
na hoście zgłaszającym (Core nigdy nie fetchuje). Szczegóły kontraktu:
[CONTRACT.md §11](CONTRACT.md).

- **Discovery** (start + co 60 s w tle, dołączane do każdego heartbeat):
  presety Jellyfin (`8096`, `/System/Info/Public` → `[200]`),
  T3 Code (`3773`, `/` → `[200]`), OpenCode (`4096`, `/` → `[200,401]`),
  reszta jako generyczne kandydaty `kind=unknown` (ID `generic-<port>`),
  nazwane z lokalnych metadanych procesu: nazwa `package.json` wrapperów
  Node, basename `exe`, `comm`, unit `systemd`/czytelny token kontenera
  z cgroup; bez procesa — etykieta `Usługa na porcie N` (TCP, bez
  sugestii HTTP, `name_source=fallback`). Monitorowalne są tylko bindy
  IPv4 `127.0.0.1`/`0.0.0.0` (`monitorable=true`; bindy LAN/IPv6 widać
  jako TCP `monitorable=false` — brak fałszywych `down`).
- **Sondy** (pula w tle, tick heartbeat nigdy nie czeka; co interwał
  checka, default 30 s, timeout default 5 s): transport `http`
  (domyślny) lub `tcp` (pojedynczy connect do `127.0.0.1:<port>`, bez
  DNS/payloadu); zawsze `127.0.0.1` + dokładny port kandydata, ścieżka
  względna, bez redirectów/proxy/cookies/auth, body odrzucane.
- **Stan:** przypisane checki w `service_checks.json` (0600, przetrwa
  restart); wyniki jadą w kopercie heartbeat (outbox + `seq` jak metryki).

Obserwacja z hosta referencyjnego: zimny Jellyfin potrafi odpowiadać
> 5 s na pierwsze zapytanie — przy flappingu podnieś `timeout_s` (max 10).

## Bezpieczeństwo (skrót)

- Domyślnie tylko HTTPS z weryfikacją; HTTP wyłącznie loopback + jawna flaga.
- Sekrety nigdy nie trafiają do logów (logowane są kody, nie treści).
- Po `AGENT_REVOKED`: stop bez retry tym sekretem.
- Szczegóły decyzji i ograniczeń: [CONTRACT.md](CONTRACT.md).

## Zgodność ze starą nazwą (StatusPilot)

Rebranding nie unieważnia istniejącej instalacji: format plików stanu,
`credential.json` i protokół są bez zmian. Stare binarium/unit nadal działają,
a agent czyta też legacy env `WINDUP_MONITOR_*` (nowe `WINDUP_MONITOR_*` ma
pierwszeństwo). Aby przejść na nowe ścieżki bez ponownego parowania:

```sh
sudo systemctl stop statuspilot-agent
sudo mv /var/lib/statuspilot /var/lib/windup-monitor
sudo chown -R windup-monitor:windup-monitor /var/lib/windup-monitor
# zainstaluj nowy unit/binarkę i uruchom windup-monitor-agent
```

Alternatywnie pozostaw `--state-dir /var/lib/statuspilot` — dane i credential
są nadal ważne. Bazy/rolki PostgreSQL (`statuspilot`, `statuspilot_review`)
pozostają historycznymi nazwami technicznymi i nie wymagają migracji.

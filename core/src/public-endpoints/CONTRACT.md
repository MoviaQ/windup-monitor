# Public endpoints — kontrakt API (dla integratora ServicesPage)

Podstawa: `POST /api/v1/services` itd. bez zmian. Nowe endpointy rejestruje
`registerPublicEndpointRoutes(api, ctx)` z `core/src/public-endpoints/routes.ts`.

## Typy (TypeScript)

```ts
type PublicEndpointStatus = "unknown" | "up" | "down" | "paused";

interface PublicEndpoint {
  id: string;               // UUID
  serviceId: string;        // FK -> services.id
  label: string | null;     // opcjonalna etykieta (max 80, bez kontrolek)
  url: string;              // kanoniczny https:// (wejście bez schematu -> https://)
  enabled: boolean;
  intervalSeconds: number;  // default 60, zakres 60..3600
  timeoutSeconds: number;   // default 8, zakres 1..10, < intervalSeconds, <= 8 (cap sondy)
  status: PublicEndpointStatus;
  lastCheckedAt: string | null; // ISO
  statusCode: number | null;
  latencyMs: number | null;
  errorCode: string | null;     // TIMEOUT | DNS_FAILED | DNS_PRIVATE |
                                // CONNECTION_FAILED | TLS_FAILED |
                                // INVALID_RESPONSE | UNEXPECTED_STATUS |
                                // REDIRECT | AUTH_REQUIRED
}

interface PublicEndpointResult {
  checkedAt: string; // ISO
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  errorCode: string | null;
}
```

## Endpointy

| Metoda | Ścieżka | Auth/CSRF | Odpowiedź |
|---|---|---|---|
| GET | `/api/v1/services/:serviceId/public-endpoints` | sesja | `{ endpoints: PublicEndpoint[] }` (404 `SERVICE_NOT_FOUND` gdy brak usługi) |
| POST | `/api/v1/services/:serviceId/public-endpoints` | sesja + CSRF + Origin | 201 `{ endpoint }`; body `{ url, label?, intervalSeconds?, timeoutSeconds? }` |
| GET | `/api/v1/public-endpoints/:id` | sesja | `{ endpoint }` |
| GET | `/api/v1/public-endpoints/:id/history?limit=` | sesja | `{ results: PublicEndpointResult[] }` (max 100) |
| PATCH | `/api/v1/public-endpoints/:id` | sesja + CSRF + Origin | `{ endpoint }`; body `{ url?, label?, enabled?, intervalSeconds?, timeoutSeconds? }` |
| DELETE | `/api/v1/public-endpoints/:id` | sesja + CSRF + Origin | 204 |

Limity: max 5 adresów na usługę (`409 ENDPOINT_LIMIT`), unikalność
`(serviceId, url)` (`409 ENDPOINT_EXISTS`). Zmiana `url` (lub wznowienie po
pauzie) czyści ostatni wynik + historię do `unknown` — stare sukcesy nigdy nie
opisują nowego celu. Pauza ustawia `status: "paused"` i pomija sondowanie.

## Semantyka statusów (copy dla UI — dokładne brzmienie)

- `up` → „Publiczny adres odpowiada" (+ kod HTTP i latency).
- `down` → „Brak odpowiedzi" (+ `errorCode` lub kod HTTP).
- `unknown` → „Jeszcze nie sprawdzono" (przed pierwszą sondą / po zmianie URL).
- `paused` → „Sprawdzanie wstrzymane".
- Odpowiedź 3xx (brak follow) → status `up` + `errorCode REDIRECT`, UI:
  „Przekierowanie (HTTP 3xx)" — adres odpowiada, ale sonda nie podąża dalej
  (każdy hop wymagałby świeżej rewalidacji DNS+pin) i nie jest to finalny health.
- 401/403 → status `up` + `errorCode AUTH_REQUIRED`; UI rozróżnia „odpowiada"
  od „zdrowy" („serwer odpowiada, wymaga logowania"). Pozostałe 4xx →
  `up` + `UNEXPECTED_STATUS`; 5xx i błąd transportu → `down`.
- Nigdy: „publicznie dostępny z całego internetu".
- Tooltip: „Sprawdzane z serwera StatusPilot, bez zewnętrznego punktu pomiarowego".

## Bezpieczeństwo (SSRF)

Tylko `https://`, port 443 (domyślny lub jawny), brak userinfo/fragmentów,
URL ≤ 2048, brak literałów IP. Każde DNS jest świeże na sondę, każdy adres
musi być global-unicast (odrzucane: prywatne, link-local, loopback, CGNAT
100.64/10, multicast, reserved, documentation, benchmarking, IPv4-mapped
prywatne, 6to4/Teredo/ISATAP z prywatnym IPv4, ULA). Połączenie dialuje
zwalidowane IP z SNI/hostname TLS oryginalnej nazwy (pin, anti-rebinding).
Brak proxy, brak redirect-follow, deadline 8 s, body 64 KiB odrzucane.

## Przykład

```http
POST /api/v1/services/svc_abc/public-endpoints
Content-Type: application/json
X-CSRF-Token: …

{ "url": "filmy.moviak.quest", "label": "Jellyfin (publiczny)" }
```

```json
{
  "endpoint": {
    "id": "…", "serviceId": "svc_abc",
    "label": "Jellyfin (publiczny)",
    "url": "https://filmy.moviak.quest/",
    "enabled": true, "intervalSeconds": 60, "timeoutSeconds": 8,
    "status": "unknown", "lastCheckedAt": null,
    "statusCode": null, "latencyMs": null, "errorCode": null
  }
}
```

Uwaga: root `https://filmy.moviak.quest/` zwraca obecnie 302
(„Przekierowanie"), a `https://filmy.moviak.quest/Health` zwraca 200.
Wybór URL należy do operatora w panelu; powyższy przykład pokazuje
normalizację `filmy.moviak.quest` → `https://…`.

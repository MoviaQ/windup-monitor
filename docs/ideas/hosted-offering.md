# Hosted panel (opcja obok OSS) — pomysł

Status: pomysł, poza obecnym MVP.
Data: 2026-10-20.
Adresat: właściciel + przyszłe rozmowy. To nie jest oferta handlowa ani porada prawna/podatkowa.

## Problem

Windup Monitor ma zostać w pełni OSS (Apache-2.0) do samodzielnego uruchomienia.
Część osób nie chce stawiać własnego Core — wolą kupić wygodę: zalogować się
z dowolnego komputera/telefonu i mieć monitoring + naprawy bez własnego serwera.

## Co dostarczamy (2 ścieżki)

1. **OSS self-host** — pełne funkcje, bez okrojenia, bez wymaganego konta cloud.
   Zawsze działa samodzielnie.
2. **Opcjonalny tani panel hosted** — wygoda dla chętnych. Subskrybent loguje się
   do kupionej apki, wybiera instalację agenta na swoim serwerze, paruje kodem
   i ma monitoring + autoryzowane naprawy self-hosted usług. Bez własnego Core.

Bez odcinania funkcji OSS. Hosted to dodatek, nie wymóg.

## Jak to ma działać (flow)

- Landing/strona główna + pobranie agenta.
- Subskrybent wybiera OS przy instalacji agenta na swoim serwerze.
- Parowanie jednorazowym kodem. Agent łączy się tylko na zewnątrz (outbound TLS),
  minimalne uprawnienia, nic nie wystawia do internetu.
- Panel w przeglądarce (PWA) — dostęp z dowolnego miejsca.
- Monitoring serwera niezależny od UI — jak padnie panel, agent dalej zbiera.
- Naprawy tylko jako typowane playbooki za wyraźną zgodą (opt-in). Nigdy surowe
  SSH / dowolny shell.
- Agent nie trzyma i nie wysyła haseł, tokenów, URL-i z sekretami ani pełnych
  logów z danymi wrażliwymi. Zero wycieków przez logi.

## Hosting — do analizy, nie obietnica

Cloudflare to kandydat do sprawdzenia, nie decyzja. Nie zakładamy przeniesienia
obecnego Core (Fastify / Postgres / Go) 1:1 do Workers. Do sprawdzenia podział:

- strona statyczna (landing),
- worker jako control plane,
- backend storage przez adaptery.

Dopiero kosztorys + testy pokażą, co się opłaca.

## Mini plany (limity + rekomendacja ceny)

Rekomendacja do walidacji (nie obietnica): **19 zł/mies lub 199 zł/rok** na start
(1 host, 5 usług, checki co 60 s), **29 zł/mies lub 279 zł/rok** standard.
Bez hasła "nielimitowane za 5 zł" — tego nie będzie. Limity finalne po testach.
Darmowy self-host (Apache-2.0) zostaje bez zmian; hosted to przyszły pomysł
na wygodę, nie wdrożona usługa napraw.

## Architektura — założenie kosztorysu

Obecny Core (Node / Fastify / Prisma / PG) liczony na VPS. Cloudflare tylko
landing + statyki + CDN. Pełny port do Workers to przepisanie (natywne
zależności, scheduler) — Hyperdrive to nie hosting PG. Nie obiecujemy
oszczędności Cloudflare vs VPS bez testów.

## Budżet miesięczny (ilustracyjny, do 100 klientów)

- VPS: 8,49 EUR netto + IPv4 0,50 EUR + backup 20% serwera = 10,688 EUR.
- Kurs ilustracyjny 4,3702 EUR/PLN (założenie, nie kurs NBP z dnia).
- VAT 23% nieodliczalny (przykład: JDG zwolniony z VAT) → 57,45 zł.
- + 25 zł ryczałt domena / poczta / backup / monitoring.
- **Razem: 82,45 zł/mies.** Ceny hostingu i kurs to szacunki z datą
  (faktury zweryfikują). Wydajność dla 100/500 klientów NIE jest zmierzona —
  bez gwarancji.

## Płatności (Stripe, ilustracyjnie)

- EEA standard 1,5% + 1 zł, Billing +0,7% → opłata = 0,022×P + 1 zł.
- Rezerwa +23% VAT od opłaty (konserwatywnie; jak księgować VAT od opłat
  Stripe — do potwierdzenia z księgową, nie twierdzimy że wszystko opodatkowane).
- Dla P=19 zł: opłata 1,74 zł (1,74414 przed zaokrągleniem).

## Scenariusze (P=19 zł, zaokrąglone do pełnych zł)

Wzory: przychód = N×19; opłaty = N×1,74414; przed podatkiem = przychód −
opłaty − 82,45; po 12% PIT + 9% zdrowotnej = ×0,79; po 32% + 9% = ×0,59.
Przykład podatkowy: skala JDG, stawki krańcowe — nie dochód "na rękę"
(próg 120 tys., ulga 30 tys., minimalna zdrowotna i roczne zaokrąglenia
robią swoje).

| N   | przychód | opłaty | przed podatkiem | po 12%+9% | po 32%+9% |
|-----|----------|--------|-----------------|-----------|-----------|
| 10  | 190      | 17     | 90              | 71        | 53        |
| 50  | 950      | 87     | 780             | 616       | 460       |
| 100 | 1900     | 174    | 1643            | 1298      | 969       |

(Dokładne: 90,1086 / 780,343 / 1643,136; po 12%: 71,1858 / 616,471 / 1298,0774;
po 32%: 53,1641 / 460,4024 / 969,4502.)

- ZUS społeczny już istnieje (nie jest kosztem tego produktu); księgowość
  i narzut ZUS trzymać osobno jako alokowane, nie przyrostowe.
- Opcjonalne +50 zł/mies administracji (jeśli kosztem): tnie gotówkę o 39,50 zł
  przy 12% krańcowym.
- Przykład 100 subskrybentów, ostrożnie: 1298 − 39,5 − 190 (rezerwa 10%
  przychodu) ≈ 1069 zł odłożonej gotówki. Rezerwa to NIE koszt podatkowy —
  samo odłożenie nie obniża podatku.
- Nie wliczone: praca właściciela, setup, prawnik, audyt bezpieczeństwa,
  HA / dyżury, marketing. Nie piszemy "wszystkie koszty pokryte".
- 10 subskrybentów ledwo styka się z kosztami: ~71 − 39,5 − 19 ≈ 13 zł reszty.
- Break-even samego progu 19 zł: 5 klientów (bez administracji i rezerwy).
  Promo 9 zł potrzebuje 11 klientów na sam próg — tylko jako promocja,
  nie cena startowa.

## Źródła (2026-10-20, do odświeżenia przed decyzją)

- PIT skala 12% do 120 tys. / 32% powyżej, kwota wolna 30 tys.:
  https://www.podatki.gov.pl/podatki-firmowe/pit/stawki-i-limity/
- Składki ZUS / zdrowotna 9% + minimalna:
  https://www.zus.pl/firmy/rozliczenia-z-zus/skladki-na-ubezpieczenia
- Zwolnienie podmiotowe VAT 2026 (limit 240 tys. dla całej firmy, nie produktu):
  https://podatki.gov.pl/podatki-firmowe/vat/poradniki-i-informatory/zwolnienie-podmiotowe-od-podatku-vat
- Cennik Stripe PL: https://stripe.com/pl/pricing ;
  VAT od opłat Stripe: https://support.stripe.com/questions/global-taxation-of-stripe-fees
- Hosting (ceny / podwyżki): https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ ;
  Workers: https://developers.cloudflare.com/workers/platform/pricing/ ;
  Hyperdrive: https://developers.cloudflare.com/hyperdrive/

Uwagi bez pewników: VAT importowy może zostać do zapłaty mimo zwolnienia
(nie podwójnie liczony, księgowa potwierdzi); sprzedaż B2C usług cyfrowych
w UE (VAT/OSS, reżim SME) do oceny bez podawania liczb progów z głowy.

## Do sprawdzenia w przyszłości (lista, bez pewników)

- izolacja tenantów,
- billing + zwroty,
- RBAC w panelu,
- audyt napraw (kto, co, kiedy),
- backupy,
- abuse / limity / rate limiting,
- RODO (rejestr, retencja, usuwanie danych).

## Pytania otwarte

- walidacja ceny: ile ktoś realnie zapłaci za wygodę vs self-host za darmo?
- dokładne limity planów po testach wydajności?
- księgowa: VAT od opłat Stripe, VAT importowy, OSS/SME przy sprzedaży w UE?

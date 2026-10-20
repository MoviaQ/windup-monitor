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

## Mini plany (cap 3 USD — cel główny)

Cel: **MAX 3 USD/mies od klienta**. Tania wygoda do OSS, nie enterprise SLA.
Kurs wyłącznie ilustracyjny **4,00 USD/PLN (założenie, nie kurs bieżący)**,
więc 3 USD = 12 zł TYLKO na potrzeby tego scenariusza.

- Limity (hosty / usługi na tenant): DO USTALENIA z load testów, nie z głowy.
  "1 host, 5 usług" to było arbitralne założenie do liczenia, NIE wymóg
  produktu. Bez hasła "nielimitowane" — fair use przeciw abuse.
- Agent zbiera metryki i lokalne proby na sprzęcie użytkownika i wysyła paczki
  raportów; backend i tak przetwarza, zapisuje i trzyma dane per host/usługa,
  a proby publicznych URL-i robi Core. Liczy się częstotliwość (15 s to 4×
  więcej niż 60 s), retencja/rollupy i tempo ingestu. Proponowane 60 s
  i krótka historia to scenariusze kosztowe przed testami.
- Podane niżej kwoty gotówkowe zakładają ten sam hosting 82,45 zł — to scenariusz,
  nie dowód że koszt nie zależy od hostów/usług.
- Naprawy jako typowane playbooki opt-in (przyszłość). Bez AI, bez SMS, bez HA.
- Opcja roczna 30 USD/rok (= 2,50 USD/mies ekwiwalentu) albo 36 USD/rok
  (nominalnie 3 USD/mies, niższe opłaty od transakcji). Rocznej nie wymuszamy
  i nie dokładamy dopłaty podatkowej powyżej capu 3 USD.
- Poprzednie progi 19/29 zł: ZASTĄPIONE (superseded) — za drogie, wypadają
  z rekomendacji. Zostają w historii gita, nie w cenniku.

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

## Płatności (Stripe, zweryfikowane 2026-10-20)

Cennik PL: karty standard EEA **1,5% + 1 zł**, premium EEA 1,9% + 1 zł,
Billing pay-as-you-go **0,7%**. Karty międzynarodowe 3,25% + 1 zł,
UK 2,5% + 1 zł, **+2% gdy wymagane przewalutowanie**; rozliczenie
wielowalutowe 1% (źródło: stripe.com/pl/pricing, pobrane 2026-10-20).

- Scenariusz bazowy (krajowe EEA): opłata = 0,022×P + 1 zł, +23% VAT od opłaty
  jako rezerwa konserwatywna (jak księgować VAT od opłat Stripe — do
  potwierdzenia z księgową). Dla P=12 zł: **opłata 1,55 zł** (1,55472).
- Scenariusz droższy (karty spoza EEA + FX): 3,95% + 1 zł + 2% FX, +23% VAT
  → dla P=12 zł opłata **2,11 zł** (2,10822). Stawek krajowych NIE przenosimy
  na karty US/globalne.
- Płatność w USD to też ryzyko kursu i regionu karty — policzone w scenariuszu
  droższym, nie zgadujemy jednego kursu na przyszłość.

## Scenariusze (P=12 zł ≈ 3 USD, miesięcznie, zaokrąglone do pełnych zł)

Wzory: przychód = N×12; opłaty krajowe = N×1,55472; przed podatkiem =
przychód − opłaty − 82,45; po 12% PIT + 9% zdrowotnej = ×0,79;
po 32% + 9% = ×0,59. Przykład podatkowy: skala JDG, stawki krańcowe —
nie dochód "na rękę" (próg 120 tys., ulga 30 tys., minimalna zdrowotna
i roczne zaokrąglenia robią swoje).

| N   | przychód | opłaty | przed podatkiem | po 12%+9% | po 32%+9% |
|-----|----------|--------|-----------------|-----------|-----------|
| 10  | 120      | 16     | 22              | 17        | 13        |
| 50  | 600      | 78     | 440             | 347       | 259       |
| 100 | 1200     | 155    | 962             | 760       | 568       |

(Dokładne: 22,0028 / 439,814 / 962,078; po 12%: 17,3822 / 347,4531 / 760,0416;
po 32%: 12,9817 / 259,4903 / 567,626.)

Scenariusz droższy (karty spoza EEA + FX, opłata 2,10822/klienta):
N=10/50/100 przed podatkiem 16,47 / 412,14 / 906,73; po 12%: 13,01 / 325,59 /
716,32; po 32%: 9,72 / 243,16 / 534,97.

- ZUS społeczny już istnieje (nie jest kosztem tego produktu); księgowość
  i narzut ZUS trzymać osobno jako alokowane, nie przyrostowe.
- Opcjonalne +50 zł/mies administracji (jeśli kosztem, osobno): tnie gotówkę
  o 39,50 zł przy 12% krańcowym. Rezerwa 10% przychodu brutto (osobno) to NIE
  koszt podatkowy — samo odłożenie nie obniża podatku.
- 100 klientów, ostrożnie: 760 − 39,5 − 120 ≈ 601 zł odłożonej gotówki.
- 10 klientów NIE styka się z narzutem: 17 − 39,5 − 12 ≈ −34 zł. Próg 3 USD
  wymaga skali albo cięcia narzutu — przy 10 klientach ledwo kryje sam hosting.
- Break-even samego hostingu: **8 płacących miesięcznie** (krajowe),
  **9 przy kartach spoza EEA**. Przed administracją i rezerwą.
- Roczne 30 USD (120 zł): jedna opłata ~4,48 zł/rok (0,37 zł/mies ekwiwalentu)
  — tańsze w opłatach, ale nie wymuszamy rocznego.
- Nie wliczone: praca właściciela, setup, prawnik, audyt bezpieczeństwa,
  HA / dyżury, marketing. To NIE jest pełny rachunek zysku.
- Model PL zwolniony z VAT to nie gwarancja sprzedaży globalnej: VAT UE/OSS
  i cena z podatkiem wliczonym muszą zmieścić się w capie 3 USD — do wyceny.

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
Fiskalnie i hostingowo to scenariusze, nie benchmarki.

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

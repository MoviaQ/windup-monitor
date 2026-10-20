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

## Mini plany (limity, bez obietnicy ceny)

Plany różnią się limitami, np. liczba hostów / częstotliwość checków /
retencja danych / użycie. Bez hasła "nielimitowane za 5 zł" — tego nie będzie.
Konkretne limity do ustalenia po walidacji kosztów. Cen nie obiecujemy w tej notatce.

## Koszty i cena — do uzupełnienia

Do uzupełnienia na podstawie aktualnego kosztorysu (osobny research + follow-up
dopisze liczby, źródła i daty do tego samego pliku).

Zmienne do policzenia:

- hosting (transfer, requesty, storage),
- płatności (prowizje operatora, wypłaty),
- VAT (stawka, kraj sprzedaży, OSS/MOSS do sprawdzenia),
- PIT (forma podatku do sprawdzenia), składka zdrowotna, księgowość,
- JDG już istnieje — rozróżnić koszty przyrostowe (ten panel) od alokowanych
  (cała firma).

Cenę brutto liczyć od tyłu: koszty zmienne + koszty stałe + marża + VAT = cena.
Gotówka (cash) osobno od wyniku księgowego.

## Do sprawdzenia w przyszłości (lista, bez pewników)

- izolacja tenantów,
- billing + zwroty,
- RBAC w panelu,
- audyt napraw (kto, co, kiedy),
- backupy,
- abuse / limity / rate limiting,
- RODO (rejestr, retencja, usuwanie danych).

## Pytania otwarte

- forma podatku przy tym przychodzie?
- VAT: stawka, miejsce świadczenia, próg?
- dokładne limity planów?
- walidacja ceny: ile ktoś realnie zapłaci za wygodę vs self-host za darmo?

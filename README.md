# Proton Auto-Expire

Browser-extensie (Chromium / Vivaldi) die een zijbalk toevoegt aan **mail.proton.me** met één-klik: *"Verwijder mail van deze afzender automatisch na N dagen"*.

De extensie bewerkt je bestaande sieve-filters (zoals je `Delete after 14 days`-filter) via dezelfde interne REST API die de Proton-webclient zelf gebruikt.

## Installatie (Vivaldi / Chrome / Brave)

1. Pak de zip uit naar een vaste map (bijv. `~/projects/proton-auto-expire`). De map is een kant-en-klare git-repo met `CLAUDE.md` voor onderhoud via Claude Code.
2. Ga naar `vivaldi://extensions` (of `chrome://extensions`).
3. Zet **Developer mode** aan (rechtsboven).
4. Klik **Load unpacked** en kies de **submap `extension/`** (niet de projectroot).
5. Herlaad het tabblad met Proton Mail.

Na een code-wijziging: herlaadknop bij de extensie op `vivaldi://extensions`, daarna het Proton Mail-tabblad verversen.

## Gebruik

1. Open een mail in Proton Mail.
2. Klik op de ⏳-knop rechtsonder → de zijbalk opent en vult de afzender automatisch in (of typ/plak zelf een adres).
3. Klik **Voeg toe** bij het gewenste filter (3 / 7 / 14 / 60 dagen — de extensie herkent automatisch alle filters die `vnd.proton.expire` + een `from`-adreslijst bevatten).
   Na het toevoegen vraagt het paneel of ook **bestaande** mail van dat adres moet vervallen: alleen het geopende bericht, alle mail van die afzender, of niets. De termijn telt vanaf dat moment (zelfde mechanisme als Protons "self-destruct"); de berichten worden dan definitief verwijderd, niet naar de prullenbak verplaatst.
4. Staat het adres al in een filter, dan toont die rij een rode **Verwijder**-knop; één klik haalt het adres er weer uit. Zo zie je meteen in welke filters het huidige adres zit.
5. Klik op de filternaam om de huidige adreslijst uit- of in te klappen; met **×** verwijder je een adres weer.
6. Zolang de zijbalk openstaat, loopt het adresveld automatisch mee met de mail die je opent. Typ je zelf een adres, dan blijft dat staan totdat je het veld leegmaakt of op **↻ afzender** klikt.
7. **+ nieuw expire-filter** maakt een nieuw sieve-filter aan met een zelfgekozen aantal dagen.

Elke wijziging wordt eerst gevalideerd via Protons eigen sieve-check-endpoint voordat hij wordt opgeslagen.

## Hoe het technisch werkt

- `inject.js` draait in de paginacontext en vangt de headers `x-pm-uid` en `x-pm-appversion` op van Protons eigen fetch-calls. De extensie slaat **geen** wachtwoorden of tokens op; de sessie-cookie (httpOnly) wordt automatisch door de browser meegestuurd omdat de calls same-origin zijn.
- `content.js` praat met:
  - `GET /api/mail/v4/filters` — filters ophalen
  - `PUT /api/mail/v4/filters/check` — sieve valideren
  - `PUT /api/mail/v4/filters/{id}` — filter bijwerken
  - `POST /api/mail/v4/filters` — filter aanmaken
  - `GET /api/mail/v4/messages` — bestaande mail van een afzender opzoeken
  - `PUT /api/mail/v4/messages/expire` — vervaldatum op bestaande berichten zetten (Protons "self-destruct")
- Endpoints en `FILTER_VERSION = 2` komen uit Protons open-source clientcode: `github.com/ProtonMail/WebClients`, `packages/shared/lib/api/filters.ts` en `packages/components/containers/filters/constants.ts`.

## Beperkingen en kanttekeningen (eerlijk)

- **Onofficiële API.** Proton documenteert deze API niet voor derden en kan hem zonder aankondiging wijzigen. Werkt het opeens niet meer: check in DevTools (Network-tab op mail.proton.me → Filters-pagina) of de paden/velden nog kloppen.
- **Afzenderdetectie is DOM-gebaseerd** en kan breken bij een UI-update van Proton. Er zijn meerdere fallback-selectors plus een handmatig invoerveld, dus je kunt altijd verder.
- **Sieve-parsing verwacht jouw template**: één `if address :is "from" [ ... ]`-blok per filter. Complexere sieve-scripts (meerdere blokken, `anyof`, etc.) worden overgeslagen of alleen het eerste blok wordt bewerkt.
- De extensie werkt op `mail.proton.me`; de filterpagina op `account.proton.me` heeft hem niet nodig maar toont wijzigingen pas na een refresh.
- Getest is de logica (sieve-parsing/-herschrijven) lokaal; de API-calls zelf kon ik hier niet live tegen jouw account testen. Eerste keer: probeer het met één testadres en controleer daarna in Instellingen → Filters of de sieve klopt.

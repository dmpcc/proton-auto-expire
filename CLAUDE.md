# Proton Auto-Expire — projectcontext voor Claude Code

## Wat dit is

Chromium-browserextensie (MV3, geladen als "unpacked" in Vivaldi) die een zijbalk toevoegt aan mail.proton.me: met een klik wordt een afzender toegevoegd aan een bestaand sieve-expire-filter ("verwijder mail van deze afzender automatisch na N dagen"). Lees `README.md` voor de gebruikersdocumentatie; die is leidend voor functionaliteit en bekende beperkingen.

## Structuur

- `extension/` — de eigenlijke extensie. Dit is de map die in Vivaldi via "Load unpacked" is geladen. Alleen hier komt shipping-code.
  - `manifest.json` — MV3, twee content scripts op `https://mail.proton.me/*`
  - `inject.js` — draait in paginacontext (`world: MAIN`), vangt `x-pm-uid` en `x-pm-appversion` headers op van Protons eigen fetch-calls
  - `content.js` — alle logica: API-calls, sieve-parsing/-herschrijven, sidebar-UI
  - `style.css` — sidebar-styling
- `upstream/filters.ts` — snapshot van Protons clientcode waarop onze API-aanroepen zijn gebaseerd (bron: `github.com/ProtonMail/WebClients`, pad `packages/shared/lib/api/filters.ts`)
- `scripts/check-upstream.sh` — haalt de actuele versie van dat bestand op en dift tegen de snapshot; eerste stap bij elk API-probleem

## Kritieke kennis (niet zelf herontdekken)

1. **De API is onofficieel.** Endpoints (`GET/PUT/POST /api/mail/v4/filters`, `PUT /api/mail/v4/filters/check`, `GET /api/mail/v4/messages`, `PUT /api/mail/v4/messages/expire`) en `FILTER_VERSION = 2` komen uit Protons open-source webclient. Proton kan dit zonder aankondiging wijzigen.
2. **Auth werkt via same-origin + opgevangen headers.** Geen tokens opslaan; de httpOnly sessie-cookie gaat automatisch mee. `inject.js` niet vervangen door hardcoded appversion-strings — die verouderen.
3. **Sieve-parsing verwacht een specifiek template**: precies één `if address :is "from" [ ... ]`-blok met een `expire "day" "N"`-actie. Regexes staan in `content.js` (`LIST_RE`, `DAYS_RE`). Complexere sieves worden bewust overgeslagen.
4. **Afzenderdetectie is DOM-gebaseerd** (`detectSender()` in `content.js`) met meerdere fallback-selectors en handmatige invoer als vangnet. Selectors zijn nooit live geverifieerd tegen Protons huidige DOM; dit is het meest waarschijnlijke breekpunt.

## Onderhoudsplaybook

**Symptoom: API-calls falen (foutmelding in de status-regel van de sidebar).**
1. Draai `scripts/check-upstream.sh`. Bij een diff: bekijk wat er in `filters.ts` upstream is veranderd, pas `content.js` aan, ververs daarna de snapshot in `upstream/`.
2. Geen diff? Controleer dan in DevTools (Network-tab op mail.proton.me, Filters-pagina in de webclient openen) welke headers en payloads Proton zelf verstuurt en vergelijk met `api()` in `content.js`.

**Symptoom: knop "afzender" vindt niets.**
Vraag de gebruiker om de DOM rond de afzendernaam (DevTools, rechtermuisknop op afzender, Inspect) en voeg een selector toe aan de lijst in `detectSender()`. Bestaande selectors laten staan als fallback.

**Testen na elke wijziging:** `vivaldi://extensions` openen, herlaadknop bij de extensie, tabblad mail.proton.me verversen, sidebar openen, met een testadres een filter bijwerken en het resultaat controleren in Proton-instellingen (Filters, Edit Sieve). Er is geen geautomatiseerde test tegen de echte API mogelijk zonder account-sessie.

## Conventies

- Documentatie en UI-teksten in het Nederlands; code, commentaar en commitberichten in het Engels.
- Geen emoji in code of documentatie.
- Vraag eerst, bouw daarna: bij nieuwe features eerst de aanpak kort voorleggen.
- Versienummer in `extension/manifest.json` ophogen bij elke functionele wijziging (semver: patch voor fixes, minor voor features).
- Geen dependencies of build-stap toevoegen; de extensie blijft vanilla JS die direct als unpacked laadt.

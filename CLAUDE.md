# Proton Auto-Expire — project context for Claude Code

## What this is

Chromium browser extension (MV3, loaded "unpacked" in Vivaldi) that adds a sidebar to mail.proton.me: one click adds a sender or domain to an existing sieve expire filter ("automatically delete mail from this sender after N days"). Read `README.md` for the user documentation; it is the source of truth for functionality and known limitations.

## Structure

- `extension/` — the actual extension. This is the directory loaded in Vivaldi via "Load unpacked". Only shipping code goes here.
  - `manifest.json` — MV3; toolbar action, background service worker, and content scripts on `https://mail.proton.me/*`
  - `inject.js` — runs in the page context (`world: MAIN`), captures the `x-pm-uid` and `x-pm-appversion` headers from Proton's own fetch calls
  - `i18n.js` — all UI strings (21 languages) plus the language preference; loaded before `content.js` in the same isolated world. Menu order is European languages first, large non-European languages last
  - `content.js` — all logic: API calls, sieve parsing/rewriting, sidebar UI
  - `background.js` — toolbar icon click: toggles the sidebar on a Proton Mail tab, opens Proton Mail elsewhere
  - `style.css` — sidebar styling
- `upstream/filters.ts` — snapshot of the Proton client code our API calls are based on (source: `github.com/ProtonMail/WebClients`, path `packages/shared/lib/api/filters.ts`)
- `scripts/check-upstream.sh` — fetches the current version of that file and diffs it against the snapshot; first step for any API problem

## Critical knowledge (do not rediscover)

1. **The API is unofficial.** Endpoints (`GET/PUT/POST /api/mail/v4/filters`, `PUT /api/mail/v4/filters/check`, `GET /api/mail/v4/messages`, `PUT /api/mail/v4/messages/expire`) and `FILTER_VERSION = 2` come from Proton's open-source web client. Proton can change this without notice.
2. **Auth works via same-origin + captured headers.** Do not store tokens; the httpOnly session cookie is sent automatically. Do not replace `inject.js` with hardcoded appversion strings — they go stale.
3. **Sieve parsing expects a specific template**: exactly one `if address :is/:matches "from" [ ... ]` block with an `expire "day" "N"` action. The regexes live in `content.js` (`LIST_RE`, `DAYS_RE`). More complex sieves are deliberately skipped. When writing, `:is` is always converted to `:matches` so that domain patterns (`*@site.com`) work; behavior for exact addresses is identical.
4. **Sender detection is DOM-based** (`detectSender()` in `content.js`). The opened message's sender carries `data-testid="recipients:sender"`; do NOT use `message-column:sender-address`, which lives on message LIST rows and returns the wrong sender. The message container exposes `data-message-id`.
5. **All UI strings live in `i18n.js`.** When adding a string, add the key to every language block; a completeness check is trivial in Node (compare key sets against `en`). Arabic and Urdu are RTL; the panel flips `dir` automatically.

## Maintenance playbook

**Symptom: API calls fail (error in the sidebar status line).**
1. Run `scripts/check-upstream.sh`. On a diff: review what changed upstream in `filters.ts`, adapt `content.js`, then refresh the snapshot in `upstream/`.
2. No diff? Check in DevTools (Network tab on mail.proton.me, open the Filters page in the web client) which headers and payloads Proton itself sends and compare with `api()` in `content.js`.

**Symptom: the sender button finds nothing or the wrong sender.**
Search Proton's open-source client (`github.com/ProtonMail/WebClients`) for the current `data-testid` on the message header components (HeaderExpanded.tsx, RecipientItemLayout.tsx) instead of asking the user to inspect the DOM. Keep existing selectors as fallbacks unless they match the wrong element.

**Testing after every change:** open `vivaldi://extensions`, click reload next to the extension, refresh the mail.proton.me tab, open the sidebar, update a filter with a test address and verify the result in Proton Settings (Filters, Edit Sieve). The pure logic (sieve parse/rewrite, `normalizeEntry`, `entryMatchesAddress`) can be copied into a throwaway Node script and asserted without a browser; the i18n key sets can be compared against `en` the same way. The live API cannot be tested without an account session.

## Conventions

- Everything in English: documentation, code, comments, commit messages. User-facing UI strings are localized via `extension/i18n.js` (English is the fallback language).
- No emoji in code or documentation (existing UI glyphs like the hourglass toggle are the exception).
- Ask first, build second: for new features, briefly propose the approach before building.
- Bump the version in `extension/manifest.json` on every functional change (semver: patch for fixes, minor for features).
- No dependencies or build step; the extension stays vanilla JS that loads directly as unpacked.
- The repository is public: never commit personal data (real names, private email addresses, screenshots). Commits use the alias `dmpcc <github.reply@dmp.cc>`.

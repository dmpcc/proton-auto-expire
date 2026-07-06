# Proton Auto-Expire

Browser extension (Chromium / Vivaldi) that adds a sidebar to **mail.proton.me** with one-click *"auto-delete mail from this sender after N days"*.

The extension edits your existing sieve expire filters through the same internal REST API the Proton web client itself uses.

## Installation (Vivaldi / Chrome / Brave)

1. Clone or download this repository to a fixed location.
2. Go to `vivaldi://extensions` (or `chrome://extensions`).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the **`extension/` subdirectory** (not the project root).
5. Reload the Proton Mail tab.

After a code change: click the reload button next to the extension on `vivaldi://extensions`, then refresh the Proton Mail tab.

## Usage

1. Open a mail in Proton Mail.
2. Click the ⏳ button at the bottom right (or the extension's toolbar icon) → the sidebar opens and fills in the sender automatically. You can also type or paste something yourself: a full address, or a domain such as `@mail.example.com` (with or without the `@`). A domain is stored as the pattern `*@mail.example.com` and matches all senders on exactly that domain — subdomains are not included; add them separately.
3. Click **Add** next to the filter you want. The extension automatically recognizes every filter that contains `vnd.proton.expire` plus a `from` address list.
   After adding, the panel asks whether **existing** mail from that entry should expire too: only the opened message, all mail from that sender/domain, or nothing. The period counts from that moment (same mechanism as Proton's own "self-destruct"); expired messages are permanently deleted, not moved to trash.
4. If the entry is already in a filter, that row shows a red **Remove** button instead; one click takes it out again. This makes it visible at a glance which filters contain the current entry.
5. Click a filter name to expand or collapse its current entry list; the **×** next to an entry removes it.
6. While the sidebar is open, the address field automatically follows the mail you open. If you typed something yourself, it stays until you clear the field or click the sender button.
7. **+ new expire filter** creates a new sieve filter with a number of days of your choice.
8. The language menu at the bottom switches the UI language (Dutch, English, and the ten most spoken world languages). The choice is remembered; the default follows your browser language.

Every change is validated through Proton's own sieve check endpoint before it is saved.

## How it works technically

- `inject.js` runs in the page context and captures the `x-pm-uid` and `x-pm-appversion` headers from Proton's own fetch calls. The extension stores **no** passwords or tokens; the (httpOnly) session cookie is sent automatically by the browser because all calls are same-origin.
- `i18n.js` holds all UI strings (11 languages) and the language preference.
- `content.js` talks to:
  - `GET /api/mail/v4/filters` — fetch filters
  - `PUT /api/mail/v4/filters/check` — validate sieve
  - `PUT /api/mail/v4/filters/{id}` — update a filter
  - `POST /api/mail/v4/filters` — create a filter
  - `GET /api/mail/v4/messages` — look up existing mail from a sender
  - `PUT /api/mail/v4/messages/expire` — set an expiration date on existing messages (Proton's "self-destruct")
- `background.js` handles the toolbar icon: it toggles the sidebar on a Proton Mail tab and opens Proton Mail from anywhere else.
- Endpoints and `FILTER_VERSION = 2` come from Proton's open-source client code: `github.com/ProtonMail/WebClients`, `packages/shared/lib/api/filters.ts` and `packages/components/containers/filters/constants.ts`.

## Limitations and caveats (honest)

- **Unofficial API.** Proton does not document this API for third parties and can change it without notice. If things suddenly stop working: check in DevTools (Network tab on mail.proton.me → open the Filters page) whether the paths/fields still match.
- **Sender detection is DOM-based** and can break when Proton updates its UI. There are fallback selectors plus a manual input field, so you can always continue.
- **Sieve parsing expects the template**: one `if address :is/:matches "from" [ ... ]` block per filter. More complex sieve scripts (multiple blocks, `anyof`, etc.) are skipped, or only the first block is edited. On first modification the extension converts a filter from `:is` to `:matches` (needed for domain patterns; behaves identically for plain addresses).
- The extension works on `mail.proton.me`; the filter page on `account.proton.me` does not need it but only shows changes after a refresh.
- The sieve parsing/rewriting logic is tested locally; the API calls cannot be tested automatically without an account session. First time: try a single test address and verify the result in Proton Settings → Filters → Edit Sieve.

## License

MIT — see [LICENSE](LICENSE).

/**
 * Proton Auto-Expire — content script (isolated world).
 *
 * Adds a small sidebar to Proton Mail with one-click
 * "auto-delete mail from this sender after N days".
 *
 * It works by editing your existing sieve filters through the same internal
 * REST API the Proton web client itself uses:
 *   GET  /api/mail/v4/filters
 *   PUT  /api/mail/v4/filters/check      (validate sieve)
 *   PUT  /api/mail/v4/filters/{id}       (update)
 *   POST /api/mail/v4/filters            (create)
 *
 * NOTE: this API is not officially documented for third parties. Endpoints
 * were taken from Proton's open-source client (github.com/ProtonMail/WebClients,
 * packages/shared/lib/api/filters.ts) and may change without notice.
 */

(() => {
  'use strict';

  const FILTER_VERSION = 2; // FILTER_VERSION in Proton's client code
  // Unanchored: used to find an address inside larger text (sender detection).
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  // Anchored: the typed input must be exactly one address, nothing around it.
  const EMAIL_EXACT_RE = new RegExp(`^${EMAIL_RE.source}$`);

  // ---------------------------------------------------------------------
  // Auth headers, captured from the page by inject.js
  // ---------------------------------------------------------------------
  const auth = { uid: null, appVersion: null };

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const d = event.data;
    if (d && d.type === 'PROTON_AUTO_EXPIRE_HEADERS' && d.uid) {
      auth.uid = d.uid;
      auth.appVersion = d.appVersion;
    }
  });
  // Ask inject.js to rebroadcast in case it captured headers before we loaded.
  window.postMessage({ type: 'PROTON_AUTO_EXPIRE_PING' }, window.location.origin);

  // ---------------------------------------------------------------------
  // API helpers
  // ---------------------------------------------------------------------
  async function api(method, path, body) {
    if (!auth.uid) {
      throw new Error(
        'Nog geen sessie-headers opgevangen. Klik eerst ergens in Proton Mail ' +
        '(bijv. open een mail) zodat de app zelf een API-call doet, en probeer opnieuw.'
      );
    }
    const headers = {
      'x-pm-uid': auth.uid,
      Accept: 'application/vnd.protonmail.v1+json',
    };
    if (auth.appVersion) headers['x-pm-appversion'] = auth.appVersion;
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* ignore */ }
    if (!res.ok || (json && json.Code && json.Code !== 1000)) {
      const msg = (json && (json.Error || json.error)) || `HTTP ${res.status}`;
      throw new Error(`Proton API: ${msg}`);
    }
    return json;
  }

  const getFilters = async () => (await api('GET', '/api/mail/v4/filters')).Filters || [];
  const checkSieve = (Sieve, Version) => api('PUT', '/api/mail/v4/filters/check', { Sieve, Version });
  const updateFilter = (f) =>
    api('PUT', `/api/mail/v4/filters/${f.ID}`, {
      Name: f.Name, Status: f.Status, Version: f.Version,
      Sieve: f.Sieve, Simple: f.Simple ?? null, Tree: f.Tree ?? null,
    });
  const createFilter = (Name, Sieve) =>
    api('POST', '/api/mail/v4/filters', { Name, Sieve, Version: FILTER_VERSION });

  // ---------------------------------------------------------------------
  // Sieve parsing / editing
  // ---------------------------------------------------------------------
  const LIST_RE = /(if\s+address\s+:is\s+"from"\s+\[)([\s\S]*?)(\])/;
  const DAYS_RE = /expire\s+"day"\s+"(\d+)"/;

  function parseExpireSieve(sieve) {
    if (!sieve || !sieve.includes('vnd.proton.expire')) return null;
    const days = sieve.match(DAYS_RE);
    const list = sieve.match(LIST_RE);
    if (!days || !list) return null;
    const addresses = [...list[2].matchAll(/"([^"]+)"/g)].map((m) => m[1].trim());
    return { days: parseInt(days[1], 10), addresses };
  }

  function sieveWithAddresses(sieve, addresses) {
    const inner = '\n' + addresses.map((a) => `"${a}"`).join(',\n') + '\n';
    return sieve.replace(LIST_RE, (_, open, __, close) => open + inner + close);
  }

  function newExpireSieve(address, days) {
    return [
      'require ["vnd.proton.expire"];',
      `# Managed by Proton Auto-Expire — permanently delete after ${days} days.`,
      'if address :is "from" [',
      `"${address}"`,
      ']',
      '{',
      `  expire "day" "${days}";`,
      '}',
      '',
    ].join('\n');
  }

  // ---------------------------------------------------------------------
  // Sender detection (DOM — selectors may break when Proton updates its UI)
  // ---------------------------------------------------------------------
  function detectSender() {
    // The opened message's sender carries data-testid="recipients:sender"
    // (set in HeaderExpanded.tsx upstream) with the address in its title.
    // Do NOT use "message-column:sender-address": that testid lives on rows
    // in the message LIST, so it returns the wrong mail's sender.
    // In a conversation several messages can be expanded; the last expanded
    // header belongs to the most recently opened message, so take the last.
    const senders = document.querySelectorAll('[data-testid="recipients:sender"]');
    if (senders.length) {
      const el = senders[senders.length - 1];
      const m = (el.getAttribute('title') || el.textContent || '').match(EMAIL_RE);
      if (m) return m[0].toLowerCase();
    }
    // Fallback: scan the last expanded message header for anything email-shaped.
    const headers = document.querySelectorAll(
      '.message-header-expanded, [data-shortcut-target="message-header-expanded"]'
    );
    if (headers.length) {
      const header = headers[headers.length - 1];
      const addr = header.querySelector(
        '[data-testid="recipient-address"], .message-recipient-item-address'
      );
      const text = (addr && (addr.getAttribute('title') || addr.textContent)) ||
        header.textContent || '';
      const m = text.match(EMAIL_RE);
      if (m) return m[0].toLowerCase();
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let panel, addressInput, filterListEl, statusEl;
  let busy = false;

  function setStatus(msg, kind = '') {
    statusEl.textContent = msg;
    statusEl.className = 'pae-status' + (kind ? ` pae-${kind}` : '');
  }

  function buildUI() {
    // Floating toggle button
    const toggle = el('button', 'pae-toggle', '⏳');
    toggle.title = 'Auto-expire afzender (Proton Auto-Expire)';
    toggle.addEventListener('click', () => {
      panel.classList.toggle('pae-open');
      if (panel.classList.contains('pae-open')) onOpen();
    });

    panel = el('aside', 'pae-panel');

    const head = el('header', 'pae-head');
    head.append(el('span', 'pae-title', 'Auto-expire'));
    const close = el('button', 'pae-close', '×');
    close.addEventListener('click', () => panel.classList.remove('pae-open'));
    head.append(close);

    const senderRow = el('div', 'pae-row');
    addressInput = el('input', 'pae-input');
    addressInput.placeholder = 'afzender@voorbeeld.nl';
    addressInput.spellcheck = false;
    const detectBtn = el('button', 'pae-btn pae-ghost', '↻ afzender');
    detectBtn.title = 'Afzender van geopende mail overnemen';
    detectBtn.addEventListener('click', fillSender);
    senderRow.append(addressInput, detectBtn);

    filterListEl = el('div', 'pae-filters');
    statusEl = el('div', 'pae-status');

    const foot = el('footer', 'pae-foot');
    const newBtn = el('button', 'pae-btn pae-ghost', '+ nieuw expire-filter');
    newBtn.addEventListener('click', onCreateFilter);
    foot.append(newBtn);

    panel.append(head, senderRow, filterListEl, statusEl, foot);
    document.body.append(toggle, panel);
  }

  function fillSender() {
    const s = detectSender();
    if (s) {
      addressInput.value = s;
      setStatus('');
    } else {
      // Clear the field so a stale address from a previous mail can never
      // be added by accident.
      addressInput.value = '';
      setStatus('Geen afzender gevonden in de geopende mail — typ of plak het adres zelf.', 'warn');
    }
  }

  async function onOpen() {
    fillSender();
    await renderFilters();
  }

  async function renderFilters() {
    filterListEl.textContent = '';
    setStatus('Filters laden…');
    let filters;
    try {
      filters = await getFilters();
    } catch (e) {
      setStatus(e.message, 'err');
      return;
    }
    setStatus('');

    const expireFilters = filters
      .map((f) => ({ filter: f, parsed: parseExpireSieve(f.Sieve) }))
      .filter((x) => x.parsed);

    if (!expireFilters.length) {
      filterListEl.append(
        el('div', 'pae-empty', 'Geen expire-filters gevonden. Maak er één aan met de knop hieronder.')
      );
      return;
    }

    expireFilters
      .sort((a, b) => a.parsed.days - b.parsed.days)
      .forEach(({ filter, parsed }) => filterListEl.append(filterRow(filter, parsed)));
  }

  function filterRow(filter, parsed) {
    const row = el('div', 'pae-filter');

    const main = el('div', 'pae-filter-main');
    const label = el('button', 'pae-filter-label');
    label.append(
      el('span', 'pae-days', `${parsed.days} dgn`),
      el('span', 'pae-name', filter.Name),
      el('span', 'pae-count', `${parsed.addresses.length}`)
    );
    const addBtn = el('button', 'pae-btn pae-add', 'Voeg toe');
    addBtn.title = `Verwijder mail van deze afzender automatisch na ${parsed.days} dagen`;
    addBtn.addEventListener('click', () => onAdd(filter, parsed));
    main.append(label, addBtn);

    const details = el('div', 'pae-addresses');
    parsed.addresses.forEach((a) => {
      const item = el('div', 'pae-address');
      item.append(el('span', null, a));
      const rm = el('button', 'pae-rm', '×');
      rm.title = 'Verwijder uit filter';
      rm.addEventListener('click', () => onRemove(filter, parsed, a));
      item.append(rm);
      details.append(item);
    });
    label.addEventListener('click', () => details.classList.toggle('pae-show'));

    row.append(main, details);
    return row;
  }

  async function saveSieve(filter, newSieve, successMsg) {
    if (busy) return;
    busy = true;
    try {
      setStatus('Valideren…');
      await checkSieve(newSieve, filter.Version || FILTER_VERSION);
      setStatus('Opslaan…');
      await updateFilter({ ...filter, Sieve: newSieve });
      setStatus(successMsg, 'ok');
      await renderFilters();
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      busy = false;
    }
  }

  async function onAdd(filter, parsed) {
    const addr = addressInput.value.trim().toLowerCase();
    if (!EMAIL_EXACT_RE.test(addr)) {
      setStatus('Vul eerst een geldig e-mailadres in (alleen het adres zelf).', 'warn');
      return;
    }
    if (parsed.addresses.includes(addr)) {
      setStatus(`${addr} staat al in "${filter.Name}".`, 'warn');
      return;
    }
    const newSieve = sieveWithAddresses(filter.Sieve, [...parsed.addresses, addr]);
    await saveSieve(filter, newSieve, `${addr} → verwijderen na ${parsed.days} dagen ✔`);
  }

  async function onRemove(filter, parsed, addr) {
    const remaining = parsed.addresses.filter((a) => a !== addr);
    if (!remaining.length) {
      setStatus('Laatste adres kan hier niet verwijderd worden (sieve zou ongeldig worden). Doe dit via de Proton-instellingen.', 'warn');
      return;
    }
    const newSieve = sieveWithAddresses(filter.Sieve, remaining);
    await saveSieve(filter, newSieve, `${addr} verwijderd uit "${filter.Name}".`);
  }

  async function onCreateFilter() {
    const addr = addressInput.value.trim().toLowerCase();
    if (!EMAIL_EXACT_RE.test(addr)) {
      setStatus('Vul eerst een e-mailadres in (alleen het adres zelf); het nieuwe filter start daarmee.', 'warn');
      return;
    }
    const daysStr = prompt('Na hoeveel dagen definitief verwijderen?', '14');
    if (!daysStr) return;
    const days = parseInt(daysStr, 10);
    if (!Number.isInteger(days) || days < 1) {
      setStatus('Ongeldig aantal dagen.', 'warn');
      return;
    }
    const name = prompt('Naam van het filter:', `Delete after ${days} days`);
    if (!name) return;
    const sieve = newExpireSieve(addr, days);
    if (busy) return;
    busy = true;
    try {
      setStatus('Valideren…');
      await checkSieve(sieve, FILTER_VERSION);
      setStatus('Aanmaken…');
      await createFilter(name, sieve);
      setStatus(`Filter "${name}" aangemaakt met ${addr}.`, 'ok');
      await renderFilters();
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
})();

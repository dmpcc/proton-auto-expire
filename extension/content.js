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
 *   GET  /api/mail/v4/messages           (list existing mail from a sender)
 *   PUT  /api/mail/v4/messages/expire    (self-destruct existing messages)
 *
 * NOTE: this API is not officially documented for third parties. Endpoints
 * were taken from Proton's open-source client (github.com/ProtonMail/WebClients,
 * packages/shared/lib/api/filters.ts) and may change without notice.
 */

(() => {
  'use strict';

  // Translation helper from i18n.js (loaded first, same isolated world).
  const t = PAE_I18N.t;

  const FILTER_VERSION = 2; // FILTER_VERSION in Proton's client code
  // How often (ms) to re-check the opened mail while the panel is open.
  const FOLLOW_INTERVAL_MS = 1000;
  const SECONDS_PER_DAY = 24 * 60 * 60;
  // Proton's "All mail" system label; used to find existing mail from a sender.
  const ALL_MAIL_LABEL_ID = '5';
  const MESSAGES_PAGE_SIZE = 150; // Proton's maximum page size
  const MAX_MESSAGE_PAGES = 20; // safety cap: at most 3000 messages per action

  // Client-side auto-archive rules: folders and sweep scheduling.
  const INBOX_LABEL_ID = '0'; // Proton's system Inbox label
  const ARCHIVE_LABEL_ID = '6'; // Proton's system Archive folder
  const CUSTOM_FOLDER_TYPE = 3; // Type=3 in core/v4/labels lists custom folders
  const ARCHIVE_RULES_KEY = 'archiveRules'; // key in chrome.storage.local
  const LAST_SWEEP_KEY = 'lastSweepAt'; // multi-tab double-run guard (ms epoch)
  // Run a first sweep this long after load, so auth headers can be captured.
  const SWEEP_STARTUP_DELAY_MS = 20 * 1000;
  const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // periodic background sweep
  // Automatic sweeps skip if another tab swept more recently than this.
  const SWEEP_MIN_GAP_MS = 13 * 60 * 1000;
  // Success status messages linger this long, then fade out.
  const FEEDBACK_FADE_DELAY_MS = 10000;
  // Inbox analysis: scan cap (pages x page size) and result list length.
  const ANALYZE_MAX_PAGES = 20; // at most 3000 inbox messages per scan
  const ANALYZE_TOP_COUNT = 15;
  // Unanchored: used to find an address inside larger text (sender detection).
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  // Anchored: the typed input must be exactly one address, nothing around it.
  const EMAIL_EXACT_RE = new RegExp(`^${EMAIL_RE.source}$`);
  // A bare (sub)domain such as "mail.anthropic.com".
  const DOMAIN_RE = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

  // Turn typed input into a sieve list entry: a full address stays as-is,
  // a domain ("@site.nl", "site.nl" or "*@site.nl") becomes the wildcard
  // pattern "*@site.nl". Returns null when the input is neither.
  function normalizeEntry(raw) {
    const s = (raw || '').trim().toLowerCase();
    if (!s) return null;
    if (EMAIL_EXACT_RE.test(s)) return s;
    let domain = s;
    if (domain.startsWith('*@')) domain = domain.slice(2);
    else if (domain.startsWith('@')) domain = domain.slice(1);
    if (DOMAIN_RE.test(domain)) return `*@${domain}`;
    return null;
  }

  // Does a sieve list entry (address or "*@domain" pattern) match an address?
  function entryMatchesAddress(entry, address) {
    if (!address) return false;
    if (entry.startsWith('*@')) return address.endsWith(entry.slice(1));
    return address === entry;
  }

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
      throw new Error(t('sessionMissing'));
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
    // Proton returns Code 1000 for single operations and 1001 for successful
    // batch operations (e.g. messages/expire, messages/label).
    const codeOk = !json || !json.Code || json.Code === 1000 || json.Code === 1001;
    if (!res.ok || !codeOk) {
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

  // List {ID, Time} of existing messages matching a sieve entry (an address or
  // a "*@domain" pattern) inside one label. Proton's From search matches
  // loosely, so results are filtered client-side against the real sender.
  // Time is the receipt time in unix seconds.
  async function listMessageMetaFrom(entry, labelId) {
    const searchTerm = entry.startsWith('*@') ? entry.slice(2) : entry;
    const metas = [];
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const q = new URLSearchParams({
        From: searchTerm,
        LabelID: labelId,
        Page: String(page),
        PageSize: String(MESSAGES_PAGE_SIZE),
      });
      const res = await api('GET', `/api/mail/v4/messages?${q}`);
      const msgs = res.Messages || [];
      for (const m of msgs) {
        const sender = ((m.Sender && m.Sender.Address) || '').toLowerCase();
        if (entryMatchesAddress(entry, sender)) metas.push({ ID: m.ID, Time: m.Time });
      }
      if (msgs.length < MESSAGES_PAGE_SIZE) break;
    }
    return metas;
  }

  // IDs of all existing messages matching an entry, across All mail; used by
  // the expire flow to apply Proton's self-destruct to existing messages.
  async function listMessagesFrom(entry) {
    const metas = await listMessageMetaFrom(entry, ALL_MAIL_LABEL_ID);
    return metas.map((m) => m.ID);
  }

  // Custom folders the user created (Type=3). Returns [{ id, name }].
  async function listFolders() {
    const q = new URLSearchParams({ Type: String(CUSTOM_FOLDER_TYPE) });
    const res = await api('GET', `/api/core/v4/labels?${q}`);
    return (res.Labels || []).map((l) => ({ id: l.ID, name: l.Name }));
  }

  // Move messages into a folder. Folders are exclusive labels, so this also
  // removes the message from the inbox. Chunked like expireMessages().
  async function moveMessagesToFolder(ids, folderId) {
    for (let i = 0; i < ids.length; i += MESSAGES_PAGE_SIZE) {
      await api('PUT', '/api/mail/v4/messages/label', {
        LabelID: folderId,
        IDs: ids.slice(i, i + MESSAGES_PAGE_SIZE),
      });
    }
  }

  // Page through inbox metadata and count messages per sender address.
  // Only metadata is read (sender, unread flag), never message content.
  // onProgress receives the number of messages scanned so far.
  async function scanInboxSenders(onProgress) {
    const bySender = new Map(); // address -> { count, unread }
    let scanned = 0;
    for (let page = 0; page < ANALYZE_MAX_PAGES; page++) {
      const q = new URLSearchParams({
        LabelID: INBOX_LABEL_ID,
        Page: String(page),
        PageSize: String(MESSAGES_PAGE_SIZE),
      });
      const res = await api('GET', `/api/mail/v4/messages?${q}`);
      const msgs = res.Messages || [];
      for (const m of msgs) {
        const sender = ((m.Sender && m.Sender.Address) || '').toLowerCase();
        if (!sender) continue;
        const stats = bySender.get(sender) || { count: 0, unread: 0 };
        stats.count += 1;
        if (m.Unread) stats.unread += 1;
        bySender.set(sender, stats);
      }
      scanned += msgs.length;
      onProgress(scanned);
      if (msgs.length < MESSAGES_PAGE_SIZE) break;
    }
    return { bySender, scanned };
  }

  // Same mechanism as Proton's own "self-destruct in x days": the messages
  // are permanently deleted (not trashed) once the timestamp passes.
  async function expireMessages(ids, days) {
    const expirationTime = Math.floor(Date.now() / 1000) + days * SECONDS_PER_DAY;
    for (let i = 0; i < ids.length; i += MESSAGES_PAGE_SIZE) {
      await api('PUT', '/api/mail/v4/messages/expire', {
        IDs: ids.slice(i, i + MESSAGES_PAGE_SIZE),
        ExpirationTime: expirationTime,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Auto-archive rules (client-side, stored in chrome.storage.local)
  //
  // Unlike expire filters (server-side sieve), these rules live only in this
  // browser and are executed by the extension while a Proton Mail tab is open.
  // A rule: { id, days, folderId, folderName, entries: string[] }.
  // ---------------------------------------------------------------------
  let archiveRules = [];

  // chrome.storage is absent in some contexts (e.g. permission denied); every
  // archive feature checks this and degrades gracefully.
  function storageAvailable() {
    return typeof chrome !== 'undefined' && chrome.storage && !!chrome.storage.local;
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (res) => {
        void chrome.runtime.lastError; // swallow, treat as empty
        resolve(res || {});
      });
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  async function loadArchiveRules() {
    if (!storageAvailable()) return;
    const res = await storageGet(ARCHIVE_RULES_KEY);
    archiveRules = Array.isArray(res[ARCHIVE_RULES_KEY]) ? res[ARCHIVE_RULES_KEY] : [];
  }

  async function saveArchiveRules() {
    if (!storageAvailable()) return;
    await storageSet({ [ARCHIVE_RULES_KEY]: archiveRules });
  }

  // Move inbox messages older than the rule's cutoff into its folder.
  // Returns the total number of messages moved across all given rules.
  async function sweepRules(rules) {
    let moved = 0;
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const rule of rules) {
      const cutoff = nowSeconds - rule.days * SECONDS_PER_DAY;
      const idsToMove = [];
      for (const entry of rule.entries) {
        const metas = await listMessageMetaFrom(entry, INBOX_LABEL_ID);
        for (const m of metas) {
          if (m.Time < cutoff) idsToMove.push(m.ID);
        }
      }
      if (idsToMove.length) {
        await moveMessagesToFolder(idsToMove, rule.folderId);
        moved += idsToMove.length;
      }
    }
    return moved;
  }

  // Orchestrates a sweep. Manual sweeps always run and report status; automatic
  // sweeps skip silently when there is nothing to do or another tab swept
  // recently. Set opts.rules to sweep a single rule (defaults to all rules).
  async function runSweep(opts = {}) {
    const manual = !!opts.manual;
    if (!storageAvailable()) {
      if (manual) setStatus(t('storageUnavailable'), 'warn');
      return;
    }
    if (!auth.uid) return; // startup: auth not captured yet, skip silently
    const rules = opts.rules || archiveRules;
    if (!rules.length) {
      if (manual) setStatus(t('sweptNone'), 'ok');
      return;
    }
    // Multi-tab double-run guard: automatic sweeps back off if another tab
    // swept recently. Manual sweeps always run.
    const store = await storageGet(LAST_SWEEP_KEY);
    const lastSweepAt = store[LAST_SWEEP_KEY] || 0;
    if (!manual && Date.now() - lastSweepAt < SWEEP_MIN_GAP_MS) return;
    if (busy) return;
    busy = true;
    await storageSet({ [LAST_SWEEP_KEY]: Date.now() }); // claim the slot at start
    try {
      setStatus(t('sweeping'));
      const moved = await sweepRules(rules);
      setStatus(moved ? t('sweptResult', { n: moved }) : t('sweptNone'), moved ? 'ok' : '');
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      busy = false;
    }
  }

  let startupSweepTimer = null;
  let sweepIntervalTimer = null;

  // Sweeps run while the tab is open, independent of the panel being open.
  function startSweepSchedule() {
    startupSweepTimer = setTimeout(() => runSweep(), SWEEP_STARTUP_DELAY_MS);
    sweepIntervalTimer = setInterval(() => runSweep(), SWEEP_INTERVAL_MS);
  }

  async function initArchive() {
    await loadArchiveRules();
    startSweepSchedule();
  }

  // ---------------------------------------------------------------------
  // Sieve parsing / editing
  // ---------------------------------------------------------------------
  const LIST_RE = /(if\s+address\s+:(?:is|matches)\s+"from"\s+\[)([\s\S]*?)(\])/;
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
    // Always write ":matches" so wildcard entries like "*@example.com" work;
    // for plain addresses ":matches" behaves exactly like ":is".
    return sieve.replace(LIST_RE, (_, open, __, close) =>
      open.replace(/:is\b/, ':matches') + inner + close);
  }

  function newExpireSieve(address, days) {
    return [
      'require ["vnd.proton.expire"];',
      `# Managed by Proton Auto-Expire — permanently delete after ${days} days.`,
      'if address :matches "from" [',
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

  // ID of the opened message, from the data-message-id attribute on the
  // message container (MessageView.tsx upstream).
  function detectOpenMessageId() {
    const headers = document.querySelectorAll(
      '.message-header-expanded, [data-shortcut-target="message-header-expanded"]'
    );
    if (!headers.length) return null;
    const container = headers[headers.length - 1].closest('[data-message-id]');
    return container ? container.getAttribute('data-message-id') : null;
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

  let panel, addressInput, filterListEl, statusEl, archiveListEl, analysisListEl;
  let expireHeaderEl, archiveHeaderEl, archiveHintEl, analyzeHeaderEl;
  let toggleBtn, detectBtn, newBtn, newRuleBtn, sweepBtn, analyzeBtn, langSelect;
  let busy = false;
  // Rendered expire-filter rows, so membership marks update without a reload.
  let rows = [];
  // Rendered archive-rule rows, same purpose.
  let archiveRows = [];
  // Last value we auto-filled; lets us tell auto-filled from hand-typed input.
  let lastAutoFill = null;
  let followTimer = null;
  // Inline "apply to existing mail?" prompt, shown after a successful add.
  let offerEl = null;
  // Inline destination-folder picker, shown while creating an archive rule.
  let pickerEl = null;

  // Collapsible sections: state is persisted per browser in localStorage so
  // the sidebar stays as compact as the user left it.
  const SECTION_LABELS = {
    expire: 'expireSection',
    archive: 'archiveSection',
    analyze: 'analyzeSection',
  };
  const COLLAPSED_KEY = 'pae-collapsed';
  let collapsed = {};
  try {
    collapsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || {};
  } catch (_) {
    collapsed = {};
  }
  const sectionHeaders = {};
  const sectionBodies = {};

  function toggleSection(key) {
    collapsed[key] = !collapsed[key];
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch (_) { /* ignore */ }
    applySectionState();
  }

  function applySectionState() {
    for (const key of Object.keys(SECTION_LABELS)) {
      const isCollapsed = !!collapsed[key];
      sectionHeaders[key].textContent =
        `${isCollapsed ? '▸' : '▾'} ${t(SECTION_LABELS[key])}`;
      sectionBodies[key].classList.toggle('pae-hidden', isCollapsed);
    }
  }

  let statusFadeTimer = null;

  function setStatus(msg, kind = '') {
    if (!statusEl) return; // sweeps may fire before the panel is built
    if (statusFadeTimer) {
      clearTimeout(statusFadeTimer);
      statusFadeTimer = null;
    }
    statusEl.textContent = msg;
    statusEl.className = 'pae-status' + (kind ? ` pae-${kind}` : '');
    // Success messages fade out by themselves; warnings and errors stay.
    if (kind === 'ok') {
      statusFadeTimer = setTimeout(() => {
        statusEl.classList.add('pae-fade-out');
      }, FEEDBACK_FADE_DELAY_MS);
    }
  }


  function togglePanel() {
    panel.classList.toggle('pae-open');
    if (panel.classList.contains('pae-open')) {
      onOpen();
      startFollowing();
    } else {
      stopFollowing();
    }
  }

  function buildUI() {
    // Floating toggle button
    toggleBtn = el('button', 'pae-toggle', '⏳');
    toggleBtn.addEventListener('click', togglePanel);

    panel = el('aside', 'pae-panel');

    const head = el('header', 'pae-head');
    head.append(el('span', 'pae-title', 'Auto-expire'));
    const close = el('button', 'pae-close', '×');
    close.addEventListener('click', () => {
      panel.classList.remove('pae-open');
      stopFollowing();
    });
    head.append(close);

    const senderRow = el('div', 'pae-row');
    addressInput = el('input', 'pae-input');
    addressInput.spellcheck = false;
    addressInput.addEventListener('input', updateMembership);
    detectBtn = el('button', 'pae-btn pae-ghost');
    detectBtn.addEventListener('click', fillSender);
    senderRow.append(addressInput, detectBtn);

    // Scrollable body holds the sections; the language select stays in the
    // fixed footer. Each section is a clickable header plus a collapsible body.
    const body = el('div', 'pae-body');

    const sectionHeader = (key) => {
      const btn = el('button', 'pae-section');
      btn.addEventListener('click', () => toggleSection(key));
      sectionHeaders[key] = btn;
      return btn;
    };
    const sectionBody = (key, ...children) => {
      const wrap = el('div', 'pae-section-body');
      wrap.append(...children);
      sectionBodies[key] = wrap;
      return wrap;
    };

    // Auto-expire (server-side sieve filters).
    expireHeaderEl = sectionHeader('expire');
    filterListEl = el('div', 'pae-filters');
    newBtn = el('button', 'pae-btn pae-ghost');
    newBtn.addEventListener('click', onCreateFilter);
    const newFilterRow = el('div', 'pae-section-actions');
    newFilterRow.append(newBtn);

    // Auto-archive (client-side rules).
    archiveHeaderEl = sectionHeader('archive');
    archiveHintEl = el('div', 'pae-hint');
    archiveListEl = el('div', 'pae-filters');
    newRuleBtn = el('button', 'pae-btn pae-ghost');
    newRuleBtn.addEventListener('click', onCreateRule);
    sweepBtn = el('button', 'pae-btn pae-ghost');
    sweepBtn.addEventListener('click', () => runSweep({ manual: true }));
    const archiveActions = el('div', 'pae-section-actions');
    archiveActions.append(newRuleBtn, sweepBtn);

    // Inbox analysis (on-demand snapshot of the busiest senders).
    analyzeHeaderEl = sectionHeader('analyze');
    analyzeBtn = el('button', 'pae-btn pae-ghost');
    analyzeBtn.addEventListener('click', onAnalyzeInbox);
    const analyzeActions = el('div', 'pae-section-actions');
    analyzeActions.append(analyzeBtn);
    analysisListEl = el('div', 'pae-filters');

    body.append(
      expireHeaderEl, sectionBody('expire', filterListEl, newFilterRow),
      archiveHeaderEl, sectionBody('archive', archiveHintEl, archiveListEl, archiveActions),
      analyzeHeaderEl, sectionBody('analyze', analyzeActions, analysisListEl)
    );

    statusEl = el('div', 'pae-status');

    const foot = el('footer', 'pae-foot');
    langSelect = el('select', 'pae-lang');
    PAE_I18N.LANGUAGES.forEach(({ code, name }) => {
      const option = el('option', null, name);
      option.value = code;
      if (code === PAE_I18N.getLang()) option.selected = true;
      langSelect.append(option);
    });
    langSelect.addEventListener('change', onLanguageChange);
    foot.append(langSelect);

    panel.append(head, senderRow, body, statusEl, foot);
    document.body.append(toggleBtn, panel);
    applyStaticTexts();
    initArchive();
  }

  // Set every fixed label in the current language; called on build and on
  // every language change.
  function applyStaticTexts() {
    toggleBtn.title = t('toggleTitle');
    addressInput.placeholder = t('placeholder');
    detectBtn.textContent = `↻ ${t('detectBtn')}`;
    detectBtn.title = t('detectTitle');
    newBtn.textContent = t('newFilterBtn');
    archiveHintEl.textContent = t('archiveHint');
    newRuleBtn.textContent = t('newRuleBtn');
    sweepBtn.textContent = t('sweepBtn');
    analyzeBtn.textContent = t('analyzeBtn');
    langSelect.title = t('langTitle');
    panel.dir = PAE_I18N.isRTL() ? 'rtl' : 'ltr';
    applySectionState(); // section headers carry the collapse chevron + label
  }

  function onLanguageChange() {
    PAE_I18N.setLang(langSelect.value);
    applyStaticTexts();
    hideOffer();
    hidePicker();
    setStatus('');
    // Analysis results contain per-row translated labels; clear the snapshot.
    analysisListEl.textContent = '';
    if (panel.classList.contains('pae-open')) {
      renderFilters();
      renderArchiveRules();
    }
  }

  function fillSender() {
    const s = detectSender();
    if (s) {
      addressInput.value = s;
      lastAutoFill = s;
      setStatus('');
    } else {
      // Clear the field so a stale address from a previous mail can never
      // be added by accident.
      addressInput.value = '';
      lastAutoFill = null;
      setStatus(t('noSender'), 'warn');
    }
    updateMembership();
  }

  // While the panel is open, keep the address field in sync with whatever
  // mail is opened — but never overwrite something the user typed themselves.
  function followSender() {
    const s = detectSender();
    if (!s || s === lastAutoFill) return;
    const untouched = !addressInput.value || addressInput.value === lastAutoFill;
    lastAutoFill = s;
    if (untouched) {
      addressInput.value = s;
      setStatus('');
      updateMembership();
    }
  }

  function startFollowing() {
    stopFollowing();
    followTimer = setInterval(followSender, FOLLOW_INTERVAL_MS);
  }

  function stopFollowing() {
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
  }

  async function onOpen() {
    hideOffer();
    hidePicker();
    // The analysis is a snapshot; start each panel session fresh.
    analysisListEl.textContent = '';
    fillSender();
    await renderFilters();
    // Reload rules so changes made in another tab are reflected.
    await loadArchiveRules();
    renderArchiveRules();
  }

  // -------------------------------------------------------------------
  // "Apply to existing mail?" prompt
  // -------------------------------------------------------------------
  function hideOffer() {
    if (offerEl) {
      offerEl.remove();
      offerEl = null;
    }
  }

  function hidePicker() {
    if (pickerEl) {
      pickerEl.remove();
      pickerEl = null;
    }
  }

  function showExpireOffer(addr, days) {
    hideOffer();
    offerEl = el('div', 'pae-offer');
    offerEl.append(
      el('div', 'pae-offer-text', t('offerText', { entry: addr, d: days }))
    );
    const row = el('div', 'pae-offer-row');
    const oneBtn = el('button', 'pae-btn pae-ghost', t('offerOne'));
    oneBtn.title = t('offerOneTitle');
    oneBtn.addEventListener('click', () => onExpireOne(addr, days));
    const allBtn = el('button', 'pae-btn pae-ghost', t('offerAll'));
    allBtn.title = t('offerAllTitle');
    allBtn.addEventListener('click', () => onExpireAll(addr, days));
    const noBtn = el('button', 'pae-btn pae-ghost', t('offerNo'));
    noBtn.addEventListener('click', hideOffer);
    row.append(oneBtn, allBtn, noBtn);
    offerEl.append(row);
    panel.insertBefore(offerEl, statusEl);
  }

  async function onExpireOne(addr, days) {
    if (busy) return;
    if (!entryMatchesAddress(addr, detectSender())) {
      setStatus(t('staleMessage'), 'warn');
      return;
    }
    const id = detectOpenMessageId();
    if (!id) {
      setStatus(t('noMessageId'), 'err');
      return;
    }
    busy = true;
    try {
      setStatus(t('settingExpiration'));
      await expireMessages([id], days);
      hideOffer();
      setStatus(t('oneExpires', { d: days }), 'ok');
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      busy = false;
    }
  }

  async function onExpireAll(addr, days) {
    if (busy) return;
    busy = true;
    try {
      setStatus(t('searchingExisting'));
      const ids = await listMessagesFrom(addr);
      if (!ids.length) {
        hideOffer();
        setStatus(t('noExisting'), 'warn');
        return;
      }
      setStatus(t('settingExpirationMany', { n: ids.length }));
      await expireMessages(ids, days);
      hideOffer();
      setStatus(t('manyExpire', { n: ids.length, d: days }), 'ok');
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      busy = false;
    }
  }

  async function renderFilters() {
    filterListEl.textContent = '';
    rows = [];
    setStatus(t('loadingFilters'));
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
      filterListEl.append(el('div', 'pae-empty', t('noFilters')));
      return;
    }

    expireFilters
      .sort((a, b) => a.parsed.days - b.parsed.days)
      .forEach(({ filter, parsed }) => filterListEl.append(filterRow(filter, parsed)));
    updateMembership();
  }

  // Reflect in each row whether the current address is already in that filter:
  // the action button flips between "Voeg toe" and "Verwijder".
  function updateMembership() {
    const entry = normalizeEntry(addressInput.value);
    for (const { parsed, actionBtn } of rows) {
      const present = entry != null && parsed.addresses.includes(entry);
      actionBtn.textContent = present ? t('removeBtn') : t('addBtn');
      actionBtn.classList.toggle('pae-del', present);
      actionBtn.classList.toggle('pae-add', !present);
      actionBtn.title = present ? t('presentTitle') : t('addTitle', { d: parsed.days });
    }
    for (const { rule, actionBtn } of archiveRows) {
      const present = entry != null && rule.entries.includes(entry);
      actionBtn.textContent = present ? t('removeBtn') : t('addBtn');
      actionBtn.classList.toggle('pae-del', present);
      actionBtn.classList.toggle('pae-add', !present);
      actionBtn.title = present
        ? t('presentTitle')
        : t('archiveAddTitle', { folder: rule.folderName, d: rule.days });
    }
  }

  function filterRow(filter, parsed) {
    const row = el('div', 'pae-filter');

    const main = el('div', 'pae-filter-main');
    const label = el('button', 'pae-filter-label');
    label.append(
      el('span', 'pae-days', t('daysShort', { d: parsed.days })),
      el('span', 'pae-name', filter.Name),
      el('span', 'pae-count', `${parsed.addresses.length}`)
    );
    // One button that adapts: "add" normally, "remove" when the entry in the
    // input field is already in this filter's list.
    const actionBtn = el('button', 'pae-btn pae-add', t('addBtn'));
    actionBtn.addEventListener('click', () => {
      const entry = normalizeEntry(addressInput.value);
      if (entry && parsed.addresses.includes(entry)) {
        onRemove(filter, parsed, entry);
      } else {
        onAdd(filter, parsed);
      }
    });
    main.append(label, actionBtn);
    rows.push({ parsed, actionBtn });

    const details = el('div', 'pae-addresses');
    parsed.addresses.forEach((a) => {
      const item = el('div', 'pae-address');
      item.append(el('span', null, a));
      const rm = el('button', 'pae-rm', '×');
      rm.title = t('removeEntryTitle');
      rm.addEventListener('click', () => onRemove(filter, parsed, a));
      item.append(rm);
      details.append(item);
    });
    label.addEventListener('click', () => details.classList.toggle('pae-show'));

    row.append(main, details);
    return row;
  }

  async function saveSieve(filter, newSieve, successMsg) {
    if (busy) return false;
    busy = true;
    try {
      setStatus(t('validating'));
      await checkSieve(newSieve, filter.Version || FILTER_VERSION);
      setStatus(t('saving'));
      await updateFilter({ ...filter, Sieve: newSieve });
      setStatus(successMsg, 'ok');
      await renderFilters();
      return true;
    } catch (e) {
      setStatus(e.message, 'err');
      return false;
    } finally {
      busy = false;
    }
  }

  async function onAdd(filter, parsed) {
    const entry = normalizeEntry(addressInput.value);
    if (!entry) {
      setStatus(t('invalidEntry'), 'warn');
      return;
    }
    if (parsed.addresses.includes(entry)) {
      setStatus(t('alreadyIn', { entry, name: filter.Name }), 'warn');
      return;
    }
    const newSieve = sieveWithAddresses(filter.Sieve, [...parsed.addresses, entry]);
    const saved = await saveSieve(filter, newSieve, t('addedOk', { entry, d: parsed.days }));
    // The filter only affects incoming mail; offer to expire existing mail too.
    if (saved) showExpireOffer(entry, parsed.days);
  }

  async function onRemove(filter, parsed, addr) {
    const remaining = parsed.addresses.filter((a) => a !== addr);
    if (!remaining.length) {
      setStatus(t('lastAddress'), 'warn');
      return;
    }
    const newSieve = sieveWithAddresses(filter.Sieve, remaining);
    await saveSieve(filter, newSieve, t('removedOk', { entry: addr, name: filter.Name }));
  }

  async function onCreateFilter() {
    const addr = normalizeEntry(addressInput.value);
    if (!addr) {
      setStatus(t('createNeedsEntry'), 'warn');
      return;
    }
    const daysStr = prompt(t('promptDays'), '14');
    if (!daysStr) return;
    const days = parseInt(daysStr, 10);
    if (!Number.isInteger(days) || days < 1) {
      setStatus(t('invalidDays'), 'warn');
      return;
    }
    const name = prompt(t('promptName'), t('defaultFilterName', { d: days }));
    if (!name) return;
    const sieve = newExpireSieve(addr, days);
    if (busy) return;
    busy = true;
    try {
      setStatus(t('validating'));
      await checkSieve(sieve, FILTER_VERSION);
      setStatus(t('creating'));
      await createFilter(name, sieve);
      setStatus(t('filterCreated', { name, entry: addr }), 'ok');
      await renderFilters();
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------------
  // Auto-archive UI
  // ---------------------------------------------------------------------
  function renderArchiveRules() {
    archiveListEl.textContent = '';
    archiveRows = [];
    if (!storageAvailable()) {
      archiveListEl.append(el('div', 'pae-empty', t('storageUnavailable')));
      return;
    }
    archiveRules
      .slice()
      .sort((a, b) => a.days - b.days)
      .forEach((rule) => archiveListEl.append(archiveRow(rule)));
    updateMembership();
  }

  function archiveRow(rule) {
    const row = el('div', 'pae-filter');

    const main = el('div', 'pae-filter-main');
    const label = el('button', 'pae-filter-label');
    label.append(
      el('span', 'pae-days', t('daysShort', { d: rule.days })),
      el('span', 'pae-name', `→ ${rule.folderName}`),
      el('span', 'pae-count', `${rule.entries.length}`)
    );
    // Same adaptive button as expire rows: "add" normally, "remove" when the
    // input entry is already in this rule.
    const actionBtn = el('button', 'pae-btn pae-add', t('addBtn'));
    actionBtn.addEventListener('click', () => {
      const entry = normalizeEntry(addressInput.value);
      if (entry && rule.entries.includes(entry)) {
        onArchiveRemove(rule, entry);
      } else {
        onArchiveAdd(rule);
      }
    });
    main.append(label, actionBtn);
    archiveRows.push({ rule, actionBtn });

    const details = el('div', 'pae-addresses');
    rule.entries.forEach((e) => {
      const item = el('div', 'pae-address');
      item.append(el('span', null, e));
      const rm = el('button', 'pae-rm', '×');
      rm.title = t('removeEntryTitle');
      rm.addEventListener('click', () => onArchiveRemove(rule, e));
      item.append(rm);
      details.append(item);
    });
    label.addEventListener('click', () => details.classList.toggle('pae-show'));

    row.append(main, details);
    return row;
  }

  async function onArchiveAdd(rule) {
    if (!storageAvailable()) {
      setStatus(t('storageUnavailable'), 'warn');
      return;
    }
    const entry = normalizeEntry(addressInput.value);
    if (!entry) {
      setStatus(t('invalidEntry'), 'warn');
      return;
    }
    if (rule.entries.includes(entry)) {
      setStatus(t('alreadyIn', { entry, name: rule.folderName }), 'warn');
      return;
    }
    rule.entries.push(entry);
    await saveArchiveRules();
    renderArchiveRules();
    // Moves are reversible, so sweep this rule right away without confirming.
    runSweep({ manual: true, rules: [rule] });
  }

  async function onArchiveRemove(rule, entry) {
    if (!storageAvailable()) {
      setStatus(t('storageUnavailable'), 'warn');
      return;
    }
    rule.entries = rule.entries.filter((e) => e !== entry);
    if (!rule.entries.length) {
      // Removing the last entry deletes the whole rule.
      archiveRules = archiveRules.filter((r) => r.id !== rule.id);
      await saveArchiveRules();
      renderArchiveRules();
      setStatus(t('ruleDeleted'), 'ok');
      return;
    }
    await saveArchiveRules();
    renderArchiveRules();
    setStatus(t('removedOk', { entry, name: rule.folderName }), 'ok');
  }

  async function onCreateRule() {
    if (!storageAvailable()) {
      setStatus(t('storageUnavailable'), 'warn');
      return;
    }
    const entry = normalizeEntry(addressInput.value);
    if (!entry) {
      setStatus(t('createNeedsEntry'), 'warn');
      return;
    }
    const daysStr = prompt(t('promptArchiveDays'), '7');
    if (!daysStr) return;
    const days = parseInt(daysStr, 10);
    if (!Number.isInteger(days) || days < 1) {
      setStatus(t('invalidDays'), 'warn');
      return;
    }
    if (busy) return;
    busy = true;
    let folders = [];
    try {
      folders = await listFolders();
    } catch (e) {
      setStatus(e.message, 'err');
      busy = false;
      return;
    }
    busy = false;
    showFolderPicker(entry, days, folders);
  }

  // Inline destination-folder picker, styled like the expire "offer" block.
  // System Archive is always offered first, then the user's custom folders.
  function showFolderPicker(entry, days, folders) {
    hidePicker();
    pickerEl = el('div', 'pae-offer');
    pickerEl.append(el('div', 'pae-offer-text', t('pickFolder')));
    if (!folders.length) {
      pickerEl.append(el('div', 'pae-hint', t('noFolders')));
    }
    const list = el('div', 'pae-picker-list');
    const archiveBtn = el('button', 'pae-btn pae-ghost', t('archiveFolderName'));
    archiveBtn.addEventListener('click', () =>
      onPickFolder(entry, days, ARCHIVE_LABEL_ID, t('archiveFolderName')));
    list.append(archiveBtn);
    for (const f of folders) {
      const btn = el('button', 'pae-btn pae-ghost', f.name);
      btn.addEventListener('click', () => onPickFolder(entry, days, f.id, f.name));
      list.append(btn);
    }
    pickerEl.append(list);
    const cancel = el('button', 'pae-btn pae-ghost', t('cancelBtn'));
    cancel.addEventListener('click', hidePicker);
    pickerEl.append(cancel);
    panel.insertBefore(pickerEl, statusEl);
  }

  async function onPickFolder(entry, days, folderId, folderName) {
    hidePicker();
    const rule = {
      id: crypto.randomUUID(),
      days,
      folderId,
      folderName,
      entries: [entry],
    };
    archiveRules.push(rule);
    await saveArchiveRules();
    renderArchiveRules();
    setStatus(t('ruleCreated', { d: days, folder: folderName }), 'ok');
    // Apply the new rule to existing inbox mail immediately.
    runSweep({ manual: true, rules: [rule] });
  }

  // ---------------------------------------------------------------------
  // Inbox analysis UI
  // ---------------------------------------------------------------------
  async function onAnalyzeInbox() {
    if (busy) return;
    busy = true;
    analysisListEl.textContent = '';
    try {
      const { bySender, scanned } = await scanInboxSenders((n) =>
        setStatus(t('analyzing', { n })));
      if (!scanned) {
        setStatus(t('analysisEmpty'), 'warn');
        return;
      }
      [...bySender.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, ANALYZE_TOP_COUNT)
        .forEach(([address, stats]) => analysisListEl.append(senderRow(address, stats)));
      setStatus(t('analysisDone', { n: scanned, s: bySender.size }), 'ok');
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      busy = false;
    }
  }

  // One clickable result row. Clicking puts the address in the input field,
  // so the add/remove buttons above immediately show where it can go.
  function senderRow(address, stats) {
    const row = el('button', 'pae-sender');
    row.title = t('analysisUseTitle');
    row.append(el('span', 'pae-sender-count', String(stats.count)));
    row.append(el('span', 'pae-sender-addr', address));
    if (stats.unread) {
      row.append(el('span', 'pae-sender-unread', t('unreadCount', { u: stats.unread })));
    }
    row.addEventListener('click', () => {
      addressInput.value = address;
      // Treat it as hand-typed: the auto-follow must not overwrite it.
      lastAutoFill = null;
      updateMembership();
      setStatus('');
      // Also search this sender in Proton itself, so the actual mails are
      // visible next to the panel. Proton reads search parameters from the
      // URL hash (extractSearchParameters in mailboxUrl.ts upstream).
      window.location.hash = `from=${encodeURIComponent(address)}`;
    });
    return row;
  }

  // ---------------------------------------------------------------------
  // The toolbar button (see background.js) toggles the panel too.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'PAE_TOGGLE_PANEL' && panel) togglePanel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
})();

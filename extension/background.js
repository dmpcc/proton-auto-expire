/**
 * Proton Auto-Expire — background service worker.
 *
 * Having an "action" in the manifest gives the extension a permanent,
 * pinnable toolbar icon (without one, Chromium-based browsers only show a
 * transient icon that tends to disappear after reloads). Clicking it toggles
 * the sidebar on a Proton Mail tab, or opens Proton Mail from anywhere else.
 */
const MAIL_URL = 'https://mail.proton.me/';

chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null && tab.url && tab.url.startsWith(MAIL_URL)) {
    chrome.tabs.sendMessage(tab.id, { type: 'PAE_TOGGLE_PANEL' }, () => {
      // Swallow "no receiving end" when the content script is not loaded yet.
      void chrome.runtime.lastError;
    });
  } else {
    chrome.tabs.create({ url: MAIL_URL });
  }
});

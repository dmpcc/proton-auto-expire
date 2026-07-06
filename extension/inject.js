/**
 * Runs in the page context (world: MAIN).
 *
 * Proton's web client authenticates API calls with an httpOnly session cookie
 * plus two request headers: `x-pm-uid` and `x-pm-appversion`. We cannot read
 * the cookie (httpOnly, sent automatically anyway), but we can observe the
 * headers on the app's own fetch() calls and hand them to the content script.
 * This way the extension never stores credentials and always uses whatever
 * app version string Proton currently expects.
 */
(() => {
  const originalFetch = window.fetch;
  let sent = { uid: null, appVersion: null };

  const extractHeaders = (input, init) => {
    try {
      let headers;
      if (init && init.headers) {
        headers = new Headers(init.headers);
      } else if (input instanceof Request) {
        headers = input.headers;
      } else {
        return;
      }
      const uid = headers.get('x-pm-uid');
      const appVersion = headers.get('x-pm-appversion');
      if (uid && (uid !== sent.uid || appVersion !== sent.appVersion)) {
        sent = { uid, appVersion };
        window.postMessage(
          { type: 'PROTON_AUTO_EXPIRE_HEADERS', uid, appVersion },
          window.location.origin
        );
      }
    } catch (_) {
      /* never break the page */
    }
  };

  window.fetch = function (input, init) {
    extractHeaders(input, init);
    return originalFetch.apply(this, arguments);
  };

  // Content script can ask for a (re)broadcast after it loads.
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === 'PROTON_AUTO_EXPIRE_PING' && sent.uid) {
      window.postMessage(
        { type: 'PROTON_AUTO_EXPIRE_HEADERS', uid: sent.uid, appVersion: sent.appVersion },
        window.location.origin
      );
    }
  });
})();

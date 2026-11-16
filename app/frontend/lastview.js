// Last view: the page / view last shown in this browser (path + query + hash, e.g. a board, or Today
// with an open calendar / mail view) is kept in localStorage `last-view`. A fresh start of the app on
// the plain start page goes back there before the first paint:
// - browser: new tab / window (no `app-session` marker in sessionStorage yet), not reached by a link
//   inside the app;
// - Home-Screen app (standalone): every launch — a navigation that is no reload / back-forward and has
//   no same-origin referrer. iOS may keep sessionStorage across app relaunches, so the marker can't tell.
// Independent of the login: a lost session shows the login dialog on the restored page.
// `window._lastViewDebug` holds the decision for the ?vpdebug=1 overlay (viewport.js).

/** Only app pages; never the one-shot add-to-inbox form (/today?inbox). Pure. */
function _lvRestorable(v) {
  return typeof v === 'string' && /^\/(today|board\/[a-z0-9-]+)(?=[?#]|$)/.test(v) && !/[?&]inbox(?=[=&#]|$)/.test(v);
}

/**
 * Whether a page load goes to the last view, and why (not). Pure.
 * navType = PerformanceNavigationTiming.type ('navigate' | 'reload' | 'back_forward' | 'prerender'), null if unknown.
 */
function _lvShouldRestore({ standalone, navType, fromApp, fresh, path, last }) {
  if (path !== '/today')                       return { restore: false, reason: 'not the plain start page' };
  if (!_lvRestorable(last) || last === '/today') return { restore: false, reason: 'no other last view' };
  if (fromApp)                                 return { restore: false, reason: 'opened from inside the app' };
  if (standalone && navType)                   return navType === 'navigate'
    ? { restore: true, reason: 'app launch' } : { restore: false, reason: `${navType}, not a launch` };
  return fresh ? { restore: true, reason: 'new session' } : { restore: false, reason: 'session already running' };
}

(function () {
  const base = document.querySelector('meta[name="base-path"]')?.getAttribute('content') || '';
  const current = () => {
    let p = location.pathname;
    if (base && p.startsWith(base)) p = p.slice(base.length) || '/';
    return p + location.search + location.hash;
  };
  try {
    const fresh = !sessionStorage.getItem('app-session');
    sessionStorage.setItem('app-session', '1');
    const standalone = navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
    const navType = performance.getEntriesByType?.('navigation')?.[0]?.type || null;
    const fromApp = !!document.referrer && document.referrer.startsWith(location.origin);
    const last = localStorage.getItem('last-view');
    const decision = _lvShouldRestore({ standalone, navType, fromApp, fresh, path: current(), last });
    window._lastViewDebug = { standalone, navType, referrer: document.referrer, fresh, path: current(), last,
      savedAt: localStorage.getItem('last-view-at'), ...decision };
    if (decision.restore) { location.replace(base + last); return; }
  } catch { /* storage blocked: always the start page */ }

  const save = () => {
    try {
      const v = current();
      if (!_lvRestorable(v)) return;
      localStorage.setItem('last-view', v);
      localStorage.setItem('last-view-at', new Date().toISOString());
    } catch { /* ignore */ }
  };
  // Views change the URL via the History API (calendar / mail view, ?mid= dropped, #card: / #note:)
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...args) { const r = orig.apply(this, args); save(); return r; };
  }
  addEventListener('popstate', save);
  addEventListener('hashchange', save);
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  save();
})();

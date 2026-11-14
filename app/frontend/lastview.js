// Last view: the page / view last shown in this browser (path + query + hash, e.g. a board, or Today
// with an open calendar / mail view) is kept in localStorage `last-view`. A fresh start of the app on
// the plain start page — new tab / window or reopened Home-Screen app (no `app-session` marker in
// sessionStorage yet), not reached by a link inside the app — goes back there before the first paint.
// Independent of the login: a lost session shows the login dialog on the restored page.
(function () {
  const base = document.querySelector('meta[name="base-path"]')?.getAttribute('content') || '';
  const current = () => {
    let p = location.pathname;
    if (base && p.startsWith(base)) p = p.slice(base.length) || '/';
    return p + location.search + location.hash;
  };
  // Only app pages; never the one-shot add-to-inbox form (/today?inbox)
  const restorable = v => typeof v === 'string' && /^\/(today|board\/[a-z0-9-]+)(?=[?#]|$)/.test(v) && !/[?&]inbox(?=[=&#]|$)/.test(v);
  try {
    const fresh = !sessionStorage.getItem('app-session');
    sessionStorage.setItem('app-session', '1');
    const fromApp = document.referrer && document.referrer.startsWith(location.origin);
    if (fresh && !fromApp && current() === '/today') {
      const last = localStorage.getItem('last-view');
      if (restorable(last) && last !== '/today') { location.replace(base + last); return; }
    }
  } catch { /* storage blocked: always the start page */ }

  const save = () => {
    try { const v = current(); if (restorable(v)) localStorage.setItem('last-view', v); } catch { /* ignore */ }
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

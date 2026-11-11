// Applies the skin cached in this browser before the first paint (no flash of the default look).
// The server value (GET /api/appearance) is synced after login — loadAppearance() in settings.js.
(function () {
  try {
    const skin = localStorage.getItem('app-skin');
    if (skin && skin !== 'default') document.documentElement.dataset.skin = skin;
  } catch { /* storage blocked: default skin until the server value arrives */ }
})();

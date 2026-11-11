// iOS Home-Screen web app (display: standalone, status bar "black-translucent", viewport-fit=cover):
// on affected iOS versions the layout viewport ends short of the screen bottom by about the status-bar
// height, so everything sized to the viewport (body 100dvh, fixed overlays with bottom: 0) leaves an
// empty band at the bottom. The gap is measured here and exposed as --vp-gap on <html> (0 everywhere
// else); base.css / overlay.css / calview.css / mailview.css extend the page and the full-screen
// overlays by it. Loaded in <head>. ?vpdebug=1 shows the measured values (for checking on a device).

/** Missing height in CSS px — only for an iOS standalone app, only a plausible band (1–100 px). Pure. */
function _vpGap({ standalone, ios, screenW, screenH, innerW, innerH }) {
  if (!standalone || !ios) return 0;
  // iOS reports screen.width / height in portrait regardless of the orientation
  const expected = innerW > innerH ? Math.min(screenW, screenH) : Math.max(screenW, screenH);
  const gap = Math.round(expected - innerH);
  return gap > 0 && gap <= 100 ? gap : 0;
}

(function () {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const debug = /[?&]vpdebug=1\b/.test(location.search);
  let box = null;

  function apply() {
    const m = { standalone, ios, screenW: screen.width, screenH: screen.height, innerW: innerWidth, innerH: innerHeight };
    const gap = _vpGap(m);
    const root = document.documentElement;
    root.style.setProperty('--vp-gap', `${gap}px`);
    root.classList.toggle('vp-gap', gap > 0);
    if (!debug) return;
    if (!box) {
      box = document.createElement('pre');
      box.style.cssText = 'position:fixed;left:8px;top:50%;z-index:9999;margin:0;padding:8px;font:11px/1.4 monospace;'
        + 'background:#000c;color:#0f0;border:1px solid #0f0;border-radius:6px;pointer-events:none;white-space:pre';
      (document.body || root).appendChild(box);
    }
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;bottom:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);visibility:hidden';
    root.appendChild(probe);
    const cs = getComputedStyle(probe);
    box.textContent = [
      `standalone ${standalone}  ios ${ios}`,
      `screen ${screen.width}x${screen.height}`,
      `inner ${innerWidth}x${innerHeight}`,
      `visualViewport ${Math.round(visualViewport?.width || 0)}x${Math.round(visualViewport?.height || 0)}`,
      `fixed inset:0 height ${probe.getBoundingClientRect().height}`,
      `safe top ${cs.paddingTop} bottom ${cs.paddingBottom}`,
      `--vp-gap ${gap}px`,
    ].join('\n');
    probe.remove();
  }

  apply();
  addEventListener('resize', apply);
  addEventListener('orientationchange', () => setTimeout(apply, 300));
  if (debug) addEventListener('DOMContentLoaded', apply);
})();

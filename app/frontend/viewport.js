// iOS Home-Screen web app (display: standalone, status bar "black-translucent", viewport-fit=cover):
// on affected iOS versions the viewport ends short of the screen bottom by about the status-bar height,
// so everything sized to it leaves an empty band at the bottom. iOS is not consistent about which
// measure is short — innerHeight, the fixed-position layer (inset: 0) and 100dvh can each be short or
// already full height — so each is measured on its own against the screen height:
//   --vp-gap      what fixed overlays (bottom: 0) miss → overlay.css / calview.css / mailview.css / today.css
//   --vp-dvh-gap  what 100dvh misses                   → body height (base.css)
// Extending by a gap that isn't there pushed page and view bottoms off the screen. Both are 0 everywhere
// else. Loaded in <head>. ?vpdebug=1 shows the measured values (for checking on a device).

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

  /** Height of a hidden probe element (position + height given as CSS). */
  function probe(css) {
    const el = document.createElement('div');
    el.style.cssText = `${css};left:0;width:1px;visibility:hidden;pointer-events:none`;
    document.documentElement.appendChild(el);
    const h = el.getBoundingClientRect().height;
    el.remove();
    return h;
  }

  function apply() {
    const root = document.documentElement;
    let fixedH = innerHeight, dvhH = innerHeight;
    if (standalone && ios) {
      fixedH = probe('position:fixed;top:0;bottom:0') || innerHeight;
      dvhH = probe('position:absolute;top:0;height:100dvh') || innerHeight;
    }
    const base = { standalone, ios, screenW: screen.width, screenH: screen.height, innerW: innerWidth };
    const gap = _vpGap({ ...base, innerH: fixedH });
    const dvhGap = _vpGap({ ...base, innerH: dvhH });
    root.style.setProperty('--vp-gap', `${gap}px`);
    root.style.setProperty('--vp-dvh-gap', `${dvhGap}px`);
    root.classList.toggle('vp-gap', gap > 0 || dvhGap > 0);
    if (!debug) return;
    if (!box) {
      box = document.createElement('pre');
      box.style.cssText = 'position:fixed;left:8px;top:50%;z-index:9999;margin:0;padding:8px;font:11px/1.4 monospace;'
        + 'background:#000c;color:#0f0;border:1px solid #0f0;border-radius:6px;pointer-events:none;white-space:pre';
      (document.body || root).appendChild(box);
    }
    const safe = document.createElement('div');
    safe.style.cssText = 'position:fixed;top:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);visibility:hidden';
    root.appendChild(safe);
    const cs = getComputedStyle(safe);
    box.textContent = [
      `standalone ${standalone}  ios ${ios}`,
      `screen ${screen.width}x${screen.height}`,
      `inner ${innerWidth}x${innerHeight}`,
      `visualViewport ${Math.round(visualViewport?.width || 0)}x${Math.round(visualViewport?.height || 0)}`,
      `fixed inset:0 height ${probe('position:fixed;top:0;bottom:0')}`,
      `100dvh ${probe('position:absolute;top:0;height:100dvh')}`,
      `safe top ${cs.paddingTop} bottom ${cs.paddingBottom}`,
      `--vp-gap ${gap}px  --vp-dvh-gap ${dvhGap}px`,
    ].join('\n');
    safe.remove();
  }

  apply();
  addEventListener('resize', apply);
  addEventListener('orientationchange', () => setTimeout(apply, 300));
  addEventListener('pageshow', apply);
  if (debug) addEventListener('DOMContentLoaded', apply);
})();

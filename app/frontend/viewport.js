// iOS Home-Screen web app (display: standalone, status bar "black-translucent", viewport-fit=cover):
// on affected iOS versions the viewport ends short of the screen bottom by about the status-bar height,
// so everything sized to it leaves an empty band at the bottom. iOS is not consistent about which
// measure is short — innerHeight, the fixed-position layer (inset: 0) and 100dvh can each be short or
// already full height — so each is measured on its own against the screen height:
//   --vp-gap      what fixed overlays (bottom: 0) miss → overlay.css / calview.css / mailview.css / today.css
//   --vp-dvh-gap  what 100dvh misses                   → body height (base.css)
// Extending by a gap that isn't there pushed page and view bottoms off the screen. Both are 0 everywhere
// else. Loaded in <head>. ?vpdebug=1 shows the measured values (for checking on a device).
//
// Keyboard: opening the on-screen keyboard in the standalone app can shrink the viewport for good — after the
// keyboard is gone a dark band stays at the bottom (and the document may stay scrolled up). When an editable
// field loses focus and no other one takes it, heal() scrolls the document back and, if a measure is shorter
// than it was before the keyboard (_vpShrunk), re-lays out the page (body display toggled in one task — no
// paint in between, scroll positions restored), then measures again.

/** Missing height in CSS px — only for an iOS standalone app, only a plausible band (1–100 px). Pure. */
function _vpGap({ standalone, ios, screenW, screenH, innerW, innerH }) {
  if (!standalone || !ios) return 0;
  // iOS reports screen.width / height in portrait regardless of the orientation
  const expected = innerW > innerH ? Math.min(screenW, screenH) : Math.max(screenW, screenH);
  const gap = Math.round(expected - innerH);
  return gap > 0 && gap <= 100 ? gap : 0;
}

/** True when a viewport measure ({ inner, fixed, dvh } in px) is shorter than the tallest one seen at this
 *  width without the keyboard — the shrink the keyboard leaves behind (4 px tolerance). Pure. */
function _vpShrunk(tallest, now) {
  if (!tallest) return false;
  return ['inner', 'fixed', 'dvh'].some(k => tallest[k] - now[k] > 4);
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

  /** Text input in progress (the keyboard is up or about to be) */
  function editing() {
    const a = document.activeElement;
    return !!a && (a.isContentEditable || (a.matches?.('textarea, select, input') && !/^(checkbox|radio|button|submit|reset|range|color|file)$/.test(a.type)));
  }

  /** Viewport measures in px: innerHeight, the fixed-position layer, 100dvh */
  function measure() {
    let fixed = innerHeight, dvh = innerHeight;
    if (standalone && ios) {
      fixed = probe('position:fixed;top:0;bottom:0') || innerHeight;
      dvh = probe('position:absolute;top:0;height:100dvh') || innerHeight;
    }
    return { inner: innerHeight, fixed, dvh };
  }

  const tallest = new Map();   // innerWidth → tallest measures without the keyboard (the width doesn't change with it)
  function remember(m) {
    if (editing()) return;
    const t = tallest.get(innerWidth) || { inner: 0, fixed: 0, dvh: 0 };
    tallest.set(innerWidth, { inner: Math.max(t.inner, m.inner), fixed: Math.max(t.fixed, m.fixed), dvh: Math.max(t.dvh, m.dvh) });
  }

  function apply() {
    const root = document.documentElement;
    const m = measure();
    remember(m);
    const fixedH = m.fixed, dvhH = m.dvh;
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
      `tallest ${JSON.stringify(tallest.get(innerWidth) || {})}  scrollY ${scrollY}`,
    ].join('\n');
    safe.remove();
  }

  /** After the keyboard: scroll the document back and undo a viewport shrink it left behind */
  function heal() {
    if (editing() || !document.body) return;
    if (scrollX || scrollY) scrollTo(0, 0);
    const se = document.scrollingElement;
    if (se && (se.scrollTop || se.scrollLeft)) { se.scrollTop = 0; se.scrollLeft = 0; }
    if (_vpShrunk(tallest.get(innerWidth), measure())) {
      const saved = [];
      for (const el of document.body.querySelectorAll('*')) {
        if (el.scrollTop || el.scrollLeft) saved.push([el, el.scrollTop, el.scrollLeft]);
      }
      const st = document.body.style, prev = st.display;
      st.display = 'none';
      void document.body.offsetHeight;   // forces the layout without the page
      st.display = prev;
      void document.body.offsetHeight;
      for (const [el, top, left] of saved) { el.scrollTop = top; el.scrollLeft = left; }
      const now = measure();   // didn't help: accept the new height, don't re-lay out on every blur
      if (_vpShrunk(tallest.get(innerWidth), now)) tallest.set(innerWidth, now);
    }
    apply();
  }
  let healTimers = [];
  function scheduleHeal() {
    healTimers.forEach(clearTimeout);
    healTimers = [150, 600].map(ms => setTimeout(heal, ms));   // keyboard slide-out takes ~250 ms
  }

  apply();
  addEventListener('resize', apply);
  if (standalone && ios) {
    // focusout bubbles; the next field (if any) is focused by the time the timers run — heal() checks
    document.addEventListener('focusout', scheduleHeal, true);
    visualViewport?.addEventListener('resize', () => { if (!editing()) scheduleHeal(); });
  }
  addEventListener('orientationchange', () => setTimeout(apply, 300));
  addEventListener('pageshow', apply);
  if (debug) addEventListener('DOMContentLoaded', apply);
})();

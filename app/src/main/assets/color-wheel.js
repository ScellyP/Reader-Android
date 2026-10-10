/* Colour wheel picker for the Reading panel (replaces the native <input type="color"> dialog).
   The native inputs stay in the page as the source of truth (.value + 'input'/'change' events),
   so reader.js, recent swatches and presets keep working unchanged.

   Performance notes:
   - The wheel is pure CSS (conic + radial gradient); brightness is a black overlay's opacity.
     Nothing is drawn per pixel in JS.
   - Dragging only moves the marker (transform) once per animation frame.
   - The app-wide recolour (applyReadingColors + saving) is debounced: it runs when the finger
     pauses (or every 0.5 s at most) and once more on release, not on every pointer move.
   - Transitions/blur are switched off while the sheet is open so recolouring is instant. */
(function () {
  'use strict';
  const IDLE_MS = 100, MAX_WAIT_MS = 500;   // recolour the app when the finger pauses, or at most every 0.5 s
  let sheet = null, p = null, active = null, dirty = false;
  let rect = null, raf = 0, px = 0, py = 0, applyTimer = 0, firstQueued = 0;
  const hsv = { h: 0, s: 0, v: 1 };

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    return { h: (h + 360) % 360, s: max ? d / max : 0, v: max };
  }
  const toHex = rgb => '#' + rgb.map(n => n.toString(16).padStart(2, '0')).join('');
  function parseHex(str) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(str).trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const currentHex = () => toHex(hsvToRgb(hsv.h, hsv.s, hsv.v));

  function build() {
    const back = document.createElement('div');
    back.className = 'cw-backdrop';
    back.innerHTML =
      '<div class="cw-sheet" role="dialog" aria-modal="true" aria-label="Colour wheel">' +
        '<div class="cw-head"><span class="cw-title"></span><span class="cw-preview"></span></div>' +
        '<div class="cw-wheel-wrap"><div class="cw-wheel"></div><div class="cw-shade"></div>' +
          '<div class="cw-marker"><span class="cw-bubble"></span></div></div>' +
        '<label class="cw-row"><span>Saturation</span><input class="cw-slider cw-sat" type="range" min="0" max="100" step="1"></label>' +
        '<label class="cw-row"><span>Brightness</span><input class="cw-slider cw-val" type="range" min="0" max="100" step="1"></label>' +
        '<div class="cw-foot"><input class="cw-hex" type="text" maxlength="7" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Hex colour">' +
          '<button type="button" class="cw-done">Done</button></div>' +
      '</div>';
    document.body.appendChild(back);
    const q = s => back.querySelector(s);
    p = { back, title: q('.cw-title'), preview: q('.cw-preview'), wrap: q('.cw-wheel-wrap'), shade: q('.cw-shade'),
          marker: q('.cw-marker'), bubble: q('.cw-bubble'), sat: q('.cw-sat'), val: q('.cw-val'), hex: q('.cw-hex'), done: q('.cw-done') };
    sheet = back;

    // Taps inside must not reach the document-level "tap outside closes the panel" handlers.
    ['click', 'pointerdown', 'touchstart'].forEach(t => back.addEventListener(t, e => e.stopPropagation()));
    back.addEventListener('click', e => { if (e.target === back) close(); });
    p.done.addEventListener('click', close);

    p.sat.addEventListener('input', () => { hsv.s = p.sat.value / 100; update(); });
    p.val.addEventListener('input', () => { hsv.v = p.val.value / 100; update(); });
    p.hex.addEventListener('input', () => {
      const rgb = parseHex(p.hex.value);
      if (!rgb) return;
      const next = rgbToHsv(rgb[0], rgb[1], rgb[2]);
      hsv.h = next.s ? next.h : hsv.h; hsv.s = next.s; hsv.v = next.v;
      update(true);
    });

    p.wrap.addEventListener('pointerdown', e => {
      p.wrap.setPointerCapture(e.pointerId);
      const r = p.wrap.getBoundingClientRect();         // measured once per touch, not per move
      rect = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: r.width / 2 };
      p.wrap.classList.add('dragging');
      px = e.clientX; py = e.clientY; frame();
      e.preventDefault();
    });
    p.wrap.addEventListener('pointermove', e => {
      if (!rect) return;
      px = e.clientX; py = e.clientY;
      if (!raf) raf = requestAnimationFrame(frame);
    });
    const end = () => { rect = null; p.wrap.classList.remove('dragging'); flushApply(); };
    p.wrap.addEventListener('pointerup', end);
    p.wrap.addEventListener('pointercancel', end);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet.classList.contains('open')) close(); });
  }

  function frame() {
    raf = 0;
    if (!rect) return;
    const dx = px - rect.cx, dy = py - rect.cy;
    hsv.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    hsv.s = clamp(Math.hypot(dx, dy) / rect.R, 0, 1);
    update();
  }

  // Cheap, per-frame UI sync (marker transform + a few style strings).
  function update(fromHex) {
    const hex = currentHex(), a = hsv.h * Math.PI / 180, R = p.wrap.offsetWidth / 2;
    p.marker.style.transform = 'translate(' + (Math.cos(a) * hsv.s * R).toFixed(1) + 'px,' + (Math.sin(a) * hsv.s * R).toFixed(1) + 'px)';
    p.marker.style.color = hex;
    p.preview.style.background = hex;
    p.shade.style.opacity = (1 - hsv.v).toFixed(3);
    p.sat.value = Math.round(hsv.s * 100);
    p.val.value = Math.round(hsv.v * 100);
    p.sat.style.background = 'linear-gradient(to right,' + toHex(hsvToRgb(hsv.h, 0, hsv.v)) + ',' + toHex(hsvToRgb(hsv.h, 1, hsv.v)) + ')';
    p.val.style.background = 'linear-gradient(to right,#000,' + toHex(hsvToRgb(hsv.h, hsv.s, 1)) + ')';
    if (!fromHex) p.hex.value = hex;
    queueApply();
  }

  // Debounced hand-off to the app: applyReadingColors repaints the whole UI, so it must not run
  // on every pointer move. It runs once the finger pauses, and at least every MAX_WAIT_MS.
  function queueApply() {
    if (!active) return;
    const now = performance.now();
    if (!firstQueued) firstQueued = now;
    clearTimeout(applyTimer);
    applyTimer = setTimeout(flushApply, Math.min(IDLE_MS, Math.max(0, MAX_WAIT_MS - (now - firstQueued))));
  }
  function flushApply() {
    clearTimeout(applyTimer); applyTimer = 0; firstQueued = 0;
    if (!active) return;
    const hex = currentHex();
    if (active.value.toLowerCase() === hex) return;
    active.value = hex; dirty = true;
    active.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function open(input) {
    if (!sheet) build();
    active = input; dirty = false; firstQueued = 0;
    const rgb = parseHex(input.value) || [0, 0, 0], next = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    hsv.h = next.h; hsv.s = next.s; hsv.v = next.v;
    const label = document.querySelector('label[for="' + input.id + '"]');
    p.title.textContent = (label ? label.textContent : 'Colour') + ' colour';
    document.body.classList.add('cw-open');
    sheet.classList.add('open');
    update();
    clearTimeout(applyTimer); applyTimer = 0; firstQueued = 0;   // opening must not re-apply the colour it started with
  }

  function close() {
    if (!sheet || !sheet.classList.contains('open')) return;
    flushApply();
    sheet.classList.remove('open');
    document.body.classList.remove('cw-open');
    const input = active, changed = dirty;
    active = null; dirty = false; rect = null;
    if (input && changed) input.dispatchEvent(new Event('change', { bubbles: true })); // remembers it in recents
  }

  function attach(input) {
    input.addEventListener('click', e => { e.preventDefault(); open(input); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(input); } });
  }
  document.querySelectorAll('.theme-panel-row input[type="color"]').forEach(attach);
  window.NovelColorWheel = { open, close };
})();

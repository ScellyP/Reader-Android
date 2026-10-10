/* Colour wheel picker for the Reading panel (replaces the native <input type="color"> dialog).
   The native inputs stay in the page as the source of truth (.value + 'input'/'change' events),
   so reader.js, recent swatches and presets keep working unchanged.

   Nothing in the app changes while you pick: the choice is only applied when you tap Done
   (Cancel, tapping outside or Escape discards it). The wheel itself is pure CSS (conic + radial
   gradient) and only the marker moves while dragging, so it stays smooth. */
(function () {
  'use strict';
  let sheet = null, p = null, active = null;
  let rect = null, raf = 0, px = 0, py = 0;
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
          '<button type="button" class="cw-cancel">Cancel</button><button type="button" class="cw-done">Done</button></div>' +
      '</div>';
    document.body.appendChild(back);
    const q = s => back.querySelector(s);
    p = { back, title: q('.cw-title'), preview: q('.cw-preview'), wrap: q('.cw-wheel-wrap'), shade: q('.cw-shade'),
          marker: q('.cw-marker'), bubble: q('.cw-bubble'), sat: q('.cw-sat'), val: q('.cw-val'), hex: q('.cw-hex'), done: q('.cw-done'), cancel: q('.cw-cancel') };
    sheet = back;

    // Taps inside must not reach the document-level "tap outside closes the panel" handlers.
    ['click', 'pointerdown', 'touchstart'].forEach(t => back.addEventListener(t, e => e.stopPropagation()));
    back.addEventListener('click', e => { if (e.target === back) close(false); });
    p.done.addEventListener('click', () => close(true));
    p.cancel.addEventListener('click', () => close(false));

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
    const end = () => { rect = null; p.wrap.classList.remove('dragging'); };
    p.wrap.addEventListener('pointerup', end);
    p.wrap.addEventListener('pointercancel', end);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet.classList.contains('open')) close(false); });
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
    p.sat.value = Math.round(hsv.s * 100);
    p.val.value = Math.round(hsv.v * 100);
    p.sat.style.background = 'linear-gradient(to right,' + toHex(hsvToRgb(hsv.h, 0, hsv.v)) + ',' + toHex(hsvToRgb(hsv.h, 1, hsv.v)) + ')';
    p.val.style.background = 'linear-gradient(to right,#000,' + toHex(hsvToRgb(hsv.h, hsv.s, 1)) + ')';
    if (!fromHex) p.hex.value = hex;
  }

  function open(input) {
    if (!sheet) build();
    active = input;
    const rgb = parseHex(input.value) || [0, 0, 0], next = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    hsv.h = next.h; hsv.s = next.s; hsv.v = next.v;
    const label = document.querySelector('label[for="' + input.id + '"]');
    p.title.textContent = (label ? label.textContent : 'Colour') + ' colour';
    sheet.classList.add('open');
    update();
  }

  // apply = true only for Done: that is the single moment the app's colours change.
  function close(apply) {
    if (!sheet || !sheet.classList.contains('open')) return;
    sheet.classList.remove('open');
    const input = active, hex = currentHex();
    active = null; rect = null;
    if (!apply || !input || input.value.toLowerCase() === hex) return;
    input.value = hex;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));   // remembers it in recent colours
  }

  function attach(input) {
    input.addEventListener('click', e => { e.preventDefault(); open(input); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(input); } });
  }
  document.querySelectorAll('.theme-panel-row input[type="color"]').forEach(attach);
  window.NovelColorWheel = { open, close };
})();

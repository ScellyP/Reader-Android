/* Colour wheel picker: replaces the native <input type="color"> dialog for the Reading panel.
   The native inputs stay in the DOM as the source of truth (their .value, 'input' and 'change'
   events are what reader.js already uses), so everything else keeps working unchanged. */
(function () {
  'use strict';
  const SIZE = 232;                 // CSS px
  let sheet = null, parts = null, active = null, dirty = false;
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
        '<div class="cw-title"></div>' +
        '<div class="cw-wheel-wrap"><canvas class="cw-wheel"></canvas><div class="cw-marker"></div></div>' +
        '<label class="cw-row"><span>Brightness</span><input class="cw-val" type="range" min="0" max="100" step="1"></label>' +
        '<div class="cw-row"><span class="cw-preview"></span>' +
          '<input class="cw-hex" type="text" maxlength="7" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Hex colour"></div>' +
        '<button type="button" class="cw-done">Done</button>' +
      '</div>';
    document.body.appendChild(back);
    parts = {
      back, sheet: back.firstChild, title: back.querySelector('.cw-title'),
      wrap: back.querySelector('.cw-wheel-wrap'), canvas: back.querySelector('.cw-wheel'),
      marker: back.querySelector('.cw-marker'), val: back.querySelector('.cw-val'),
      preview: back.querySelector('.cw-preview'), hex: back.querySelector('.cw-hex'), done: back.querySelector('.cw-done')
    };
    sheet = back;
    // Clicks here must not reach the document-level "tap outside closes the panel" handlers.
    ['click', 'pointerdown', 'touchstart'].forEach(t => back.addEventListener(t, e => e.stopPropagation()));
    back.addEventListener('click', e => { if (e.target === back) close(); });
    parts.done.addEventListener('click', close);
    parts.val.addEventListener('input', () => { hsv.v = parts.val.value / 100; drawWheel(); commit(true); });
    parts.hex.addEventListener('input', () => {
      const rgb = parseHex(parts.hex.value);
      if (!rgb) return;
      const next = rgbToHsv(rgb[0], rgb[1], rgb[2]);
      hsv.h = next.s ? next.h : hsv.h; hsv.s = next.s; hsv.v = next.v;
      drawWheel(); commit(true, true);
    });
    const R = SIZE / 2;
    function pick(e) {
      const rect = parts.wrap.getBoundingClientRect();
      const dx = e.clientX - rect.left - R, dy = e.clientY - rect.top - R, r = Math.hypot(dx, dy);
      hsv.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      hsv.s = clamp(r / (R - 1), 0, 1);
      commit(true);
    }
    parts.wrap.addEventListener('pointerdown', e => { parts.wrap.setPointerCapture(e.pointerId); parts.wrap.dataset.drag = '1'; pick(e); e.preventDefault(); });
    parts.wrap.addEventListener('pointermove', e => { if (parts.wrap.dataset.drag) pick(e); });
    const end = e => { delete parts.wrap.dataset.drag; };
    parts.wrap.addEventListener('pointerup', end);
    parts.wrap.addEventListener('pointercancel', end);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet && sheet.classList.contains('open')) close(); });
  }

  function drawWheel() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), px = Math.round(SIZE * dpr), c = parts.canvas;
    if (c.width !== px) { c.width = px; c.height = px; c.style.width = c.style.height = SIZE + 'px'; }
    const ctx = c.getContext('2d'), img = ctx.createImageData(px, px), d = img.data, R = px / 2;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = x + .5 - R, dy = y + .5 - R, r = Math.hypot(dx, dy);
        if (r > R) continue;
        const rgb = hsvToRgb((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, Math.min(1, r / (R - 1)), hsv.v), i = (y * px + x) * 4;
        d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = Math.round(255 * clamp(R - r, 0, 1));
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function syncUi(skipHex) {
    const R = SIZE / 2, hex = currentHex(), a = hsv.h * Math.PI / 180;
    parts.marker.style.left = (R + Math.cos(a) * hsv.s * (R - 1)) + 'px';
    parts.marker.style.top = (R + Math.sin(a) * hsv.s * (R - 1)) + 'px';
    parts.marker.style.background = hex;
    parts.val.value = Math.round(hsv.v * 100);
    parts.val.style.background = 'linear-gradient(to right,#000,' + toHex(hsvToRgb(hsv.h, hsv.s, 1)) + ')';
    parts.preview.style.background = hex;
    if (!skipHex) parts.hex.value = hex;
  }

  function commit(live, skipHex) {
    syncUi(skipHex);
    if (!active) return;
    const hex = currentHex();
    if (active.value.toLowerCase() === hex) return;
    active.value = hex;
    dirty = true;
    active.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function open(input) {
    if (!sheet) build();
    active = input; dirty = false;
    const rgb = parseHex(input.value) || [0, 0, 0], next = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    hsv.h = next.h; hsv.s = next.s; hsv.v = next.v;
    const label = document.querySelector('label[for="' + input.id + '"]');
    parts.title.textContent = (label ? label.textContent : 'Colour') + ' colour';
    sheet.classList.add('open');
    drawWheel(); syncUi();
  }

  function close() {
    if (!sheet || !sheet.classList.contains('open')) return;
    sheet.classList.remove('open');
    const input = active, changed = dirty;
    active = null; dirty = false;
    if (input && changed) input.dispatchEvent(new Event('change', { bubbles: true })); // remembers it in recents
  }

  function attach(input) {
    input.addEventListener('click', e => { e.preventDefault(); open(input); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(input); } });
  }
  document.querySelectorAll('.theme-panel-row input[type="color"]').forEach(attach);
  window.NovelColorWheel = { open, close };
})();

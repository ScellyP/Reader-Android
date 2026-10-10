/*!
 * ShatterGlass — procedural shattered-glass overlay (Canvas 2D, no dependencies)
 *
 *   const glass = new ShatterGlass(containerEl, { seed: 7 });
 *   glass.trigger();   // animated reveal (impact flash, cracks, facets, optional shake)
 *   glass.reset();     // clear the overlay
 *   glass.update({ density: 1.2 });   // rebuild geometry / restyle
 *   glass.destroy();
 *
 * - Geometry is built once from a seed in a fixed 360x800 virtual space, so the
 *   pattern is identical on every redraw/resize (it is scaled to the container).
 * - The canvas has pointer-events:none, so it never blocks the UI underneath.
 * - rAF runs only while the reveal animates; afterwards the canvas bitmap is static.
 */
(function (root) {
  'use strict';

  var VW = 360, VH = 800;          // virtual coordinate space
  var REACH = 400;                 // facets: distance (virtual px) at which the reveal ends
  var REACH_CRACK = 640;           // cracks run ahead of the facets
  var FADE = 0.14;                 // facet fade-in length (fraction of timeline)

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ---------- Bowyer–Watson Delaunay (runs once per build) ---------- */
  function triangulate(pts) {
    var n = pts.length, minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, i;
    for (i = 0; i < n; i++) {
      var p = pts[i];
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    var dm = Math.max(maxX - minX, maxY - minY) * 20, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    var v = pts.slice();
    v.push([mx - dm, my - dm], [mx, my + dm], [mx + dm, my - dm]);

    function mk(a, b, c) {
      var ax = v[a][0], ay = v[a][1], bx = v[b][0], by = v[b][1], cx = v[c][0], cy = v[c][1];
      var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(d) < 1e-9) d = 1e-9;
      var a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
      var ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
      var uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
      return { a: a, b: b, c: c, x: ux, y: uy, r: (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy) };
    }

    var tris = [mk(n, n + 1, n + 2)];
    for (i = 0; i < n; i++) {
      var px = v[i][0], py = v[i][1], keep = [], edges = new Map();
      for (var k = 0; k < tris.length; k++) {
        var t = tris[k], dx = px - t.x, dy = py - t.y;
        if (dx * dx + dy * dy < t.r) {
          var es = [[t.a, t.b], [t.b, t.c], [t.c, t.a]];
          for (var e = 0; e < 3; e++) {
            var a = es[e][0], b = es[e][1], key = a < b ? a + '_' + b : b + '_' + a;
            if (edges.has(key)) edges.delete(key); else edges.set(key, es[e]);
          }
        } else keep.push(t);
      }
      tris = keep;
      edges.forEach(function (ed) { tris.push(mk(ed[0], ed[1], i)); });
    }
    return tris.filter(function (t) { return t.a < n && t.b < n && t.c < n; });
  }

  /* ---------- Pure geometry + styling data (testable without a DOM) ---------- */
  function buildGeometry(seed, o) {
    var rng = mulberry32(seed | 0);
    var density = o.density, nImp = clamp(o.impacts | 0, 1, 5);

    // Impact anchors tuned to the reference: left edge, right edge, top, bottom, lower right.
    var anchors = [[4, 300], [356, 175], [225, 8], [130, 790], [352, 600]];
    var impacts = [];
    for (var i = 0; i < nImp; i++) {
      impacts.push({
        x: anchors[i][0] + (rng() - 0.5) * 36,
        y: anchors[i][1] + (rng() - 0.5) * 60,
        power: 190 + rng() * 150,
        delay: 0
      });
    }
    // Progress mode: impacts land one after another in a seeded random order.
    var stagger = !!o.stagger, SPAN = stagger ? 0.5 : 0.78;
    if (stagger) {
      var order = [];
      for (i = 0; i < nImp; i++) order.push(i);
      for (i = order.length - 1; i > 0; i--) { var jj = Math.floor(rng() * (i + 1)), tmp = order[i]; order[i] = order[jj]; order[jj] = tmp; }
      for (i = 0; i < nImp; i++) impacts[i].delay = order[i] * (0.36 / Math.max(1, nImp - 1));
    }

    var P = [];
    function add(x, y, minD) {
      if (x < -70 || x > VW + 70 || y < -70 || y > VH + 70) return false;
      var m2 = minD * minD;
      for (var j = 0; j < P.length; j++) {
        var dx = P[j][0] - x, dy = P[j][1] - y;
        if (dx * dx + dy * dy < m2) return false;
      }
      P.push([x, y]); return true;
    }

    // Outer margin ring so the visible rectangle is fully covered.
    var M = 60, x, y;
    add(-M, -M, 1); add(VW + M, -M, 1); add(VW + M, VH + M, 1); add(-M, VH + M, 1);
    for (x = 70; x < VW; x += 110 + rng() * 40) { add(x, -M + rng() * 14, 20); add(x, VH + M - rng() * 14, 20); }
    for (y = 90; y < VH; y += 120 + rng() * 50) { add(-M + rng() * 14, y, 20); add(VW + M - rng() * 14, y, 20); }

    // Dense, irregular rings around each impact (small shards near the core, big further out).
    impacts.forEach(function (im) {
      add(im.x, im.y, 0.1);
      var r = 5 + rng() * 4, k = 0;
      while (r < im.power * 1.7) {
        var cnt = Math.max(4, Math.round((5 + k * 0.7) * density));
        var off = rng() * 6.2832;
        for (var j = 0; j < cnt; j++) {
          var a = off + ((j + (rng() - 0.5) * 0.75) / cnt) * 6.2832;
          var rr = r * (0.75 + rng() * 0.5);
          add(im.x + Math.cos(a) * rr, im.y + Math.sin(a) * rr, Math.max(3.5, r * 0.3));
        }
        r *= 1.36 + rng() * 0.18; k++;
      }
    });

    // Long, wandering, branching cracks (these also seed triangulation points).
    var cracks = [];
    function ray(im, ox, oy, ang, len, depth, travel0) {
      var cx = ox, cy = oy, a = ang, travel = 0;
      while (travel < len) {
        var step = 26 + rng() * 80 * (1 + travel / 380);
        a += (rng() - 0.5) * 0.4;
        var nx = cx + Math.cos(a) * step, ny = cy + Math.sin(a) * step;
        var d0 = travel0 + travel;
        travel += step;
        cracks.push({
          x0: cx, y0: cy, x1: nx, y1: ny,
          t0: Math.max(0, im.delay + clamp(d0 / REACH_CRACK, 0, 1) * (stagger ? 0.45 : 0.7) - 0.04),
          a: clamp(0.7 * Math.exp(-(travel0 + travel) / 420) + 0.05, 0.05, 0.75) * (depth ? 0.65 : 1),
          w: depth ? 0.7 : 1
        });
        cx = nx; cy = ny;
        if (depth === 0) add(cx, cy, 11);
        if (depth < 2 && travel > 40 && rng() < 0.2) {
          ray(im, cx, cy, a + (rng() < 0.5 ? -1 : 1) * (0.45 + rng() * 0.6),
            (len - travel) * (0.25 + rng() * 0.35) + 30, depth + 1, travel0 + travel);
        }
        if (cx < -90 || cx > VW + 90 || cy < -90 || cy > VH + 90) break;
      }
    }
    impacts.forEach(function (im) {
      var nR = Math.round((6 + rng() * 4) * (0.7 + density * 0.3)), gaps = [], sum = 0, j;
      for (j = 0; j < nR; j++) { var g = Math.pow(rng(), 1.5) + 0.25; gaps.push(g); sum += g; }
      var ang = rng() * 6.2832;
      for (j = 0; j < nR; j++) {
        ang += (gaps[j] / sum) * 6.2832;
        ray(im, im.x, im.y, ang, 240 + rng() * 640, 0, 0);
      }
    });

    // Sparse background points -> large facets far from impacts.
    for (y = -30; y < VH + 30; y += 105) {
      for (x = -30; x < VW + 30; x += 105) add(x + rng() * 90, y + rng() * 90, 38);
    }

    // Triangulate and turn triangles into styled facets.
    var tris = triangulate(P), facets = [];
    for (i = 0; i < tris.length; i++) {
      var t = tris[i], A = P[t.a], B = P[t.b], C = P[t.c];
      var cxx = (A[0] + B[0] + C[0]) / 3, cyy = (A[1] + B[1] + C[1]) / 3;
      if (cxx < -15 || cxx > VW + 15 || cyy < -15 || cyy > VH + 15) continue;
      var area = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
      if (area < 1.5) continue;

      var dmin = 1e9, glow = 0, tReveal = 1e9;
      for (var m = 0; m < impacts.length; m++) {
        var ddx = cxx - impacts[m].x, ddy = cyy - impacts[m].y, d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d < dmin) dmin = d;
        var tr = impacts[m].delay + clamp(d / REACH, 0, 1) * SPAN;
        if (tr < tReveal) tReveal = tr;
        glow += Math.exp(-d / (impacts[m].power * 0.62));
      }
      glow = Math.min(glow, 1.2);

      var TONES = [54, 64, 78, 94, 114, 142, 178];
      var ti = Math.floor(rng() * rng() * 5.2 + glow * 3.2 + rng() * 1.2);
      var L = TONES[Math.min(TONES.length - 1, ti)];
      var alpha = 0.17 + (ti / 6) * 0.26 + rng() * 0.05;
      var s0 = Math.floor(rng() * 3), vs = [A, B, C], V0 = vs[s0], V1 = vs[(s0 + 1) % 3], V2 = vs[(s0 + 2) % 3];
      facets.push({
        x0: A[0], y0: A[1], x1: B[0], y1: B[1], x2: C[0], y2: C[1],
        area: area,
        t0: tReveal + rng() * 0.04,
        // gradient: light at one vertex, dark toward the opposite edge
        gx0: V0[0], gy0: V0[1], gx1: (V1[0] + V2[0]) / 2, gy1: (V1[1] + V2[1]) / 2,
        L0: L * 1.05, L1: L * 0.95, a0: alpha, a1: alpha,
        hl: rng() < 0.24 + glow * 0.25 ? Math.floor(rng() * 3) : -1,
        ha: 0.3 + glow * 0.35 + rng() * 0.2
      });
    }

    // Cap: drop the smallest facets if over budget (they are the sub-pixel ones near cores).
    var cap = o.maxFacets | 0;
    if (facets.length > cap) {
      facets.forEach(function (f) { f.score = f.area * (0.6 + rng() * 0.8); });
      facets.sort(function (a, b) { return b.score - a.score; });
      facets.length = cap;
    }
    facets.sort(function (a, b) { return b.area - a.area; }); // big panes underneath, shards on top

    return { impacts: impacts, facets: facets, cracks: cracks, points: P.length };
  }

  function rgba(L, a) {
    var r = clamp(L * 0.93, 0, 255) | 0, g = clamp(L * 0.97, 0, 255) | 0, b = clamp(L * 1.07, 0, 255) | 0;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + clamp(a, 0, 0.88).toFixed(3) + ')';
  }

  /* ---------- Renderer ---------- */
  function ShatterGlass(container, opts) {
    this.o = Object.assign({
      seed: 7, density: 1, impacts: 4, maxFacets: 800, intensity: 1, speed: 1,
      shake: true, flash: true, shakeTarget: null, onDone: null,
      progressMode: false, stagger: false
    }, opts || {});
    this.container = container;
    this.state = 'idle';
    this.stats = { facets: 0, cracks: 0, buildMs: 0, drawMs: 0 };

    var cv = this.canvas = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:block';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(cv);
    this.ctx = cv.getContext('2d');

    var self = this;
    this._tick = function (now) { self._frame(now); };
    this._build();
    this._resize();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(function () { self._resize(); });
      this._ro.observe(container);
    } else {
      this._onWin = function () { self._resize(); };
      window.addEventListener('resize', this._onWin);
    }
  }

  ShatterGlass.prototype._build = function () {
    var t0 = performance.now(), o = this.o, c = this.ctx;
    this.geo = buildGeometry(o.seed, o);
    var I = o.intensity;
    this.geo.facets.forEach(function (f) {
      var g = c.createLinearGradient(f.gx0, f.gy0, f.gx1, f.gy1);
      g.addColorStop(0, rgba(f.L0, f.a0 * I));
      g.addColorStop(1, rgba(f.L1, f.a1 * I));
      f.g = g;
    });
    var dim = c.createRadialGradient(VW / 2, VH / 2, 90, VW / 2, VH / 2, 520);
    dim.addColorStop(0, 'rgba(4,5,8,0.06)');
    dim.addColorStop(1, 'rgba(2,3,6,0.2)');
    this.dim = dim;
    this.stats.facets = this.geo.facets.length;
    this.stats.cracks = this.geo.cracks.length;
    this.stats.buildMs = +(performance.now() - t0).toFixed(1);
  };

  ShatterGlass.prototype._resize = function () {
    var w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.sx = this.canvas.width / VW;
    this.sy = this.canvas.height / VH;
    this.k = (w / VW + h / VH) / 2;        // css px per virtual px
    if (this.o.progressMode) { if (this.state === 'progress') this._drawProgress(); }
    else if (this.state === 'shattered') this._draw(2);
    else if (this.state === 'animating') this._draw(Math.min((performance.now() - this._start) / this.dur, 1.2));
  };

  ShatterGlass.prototype._draw = function (T) {
    var t0 = performance.now(), c = this.ctx, o = this.o, geo = this.geo, lw = 0.8 / this.k, i, f;
    c.setTransform(this.sx, 0, 0, this.sy, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.clearRect(0, 0, VW, VH);
    if (T <= 0) return;

    // Progress mode (tap-driven): p in [0,1]; the last 18% turns the glass into the
    // inverse-colour terminal fill (white in dark theme, black in light); cracks fade out with it, leaving a plain frame.
    var pm = o.progressMode && this._prog, fill = 0, dark = true;
    if (pm) {
      var ft = clamp((pm.p - 0.82) / 0.18, 0, 1);
      fill = ft * ft * (3 - 2 * ft);
      dark = pm.dark !== false;
    }
    c.globalAlpha = Math.min(1, T / 0.35) * Math.min(1, o.intensity) * (dark ? 1 : 0.3);
    c.fillStyle = this.dim;
    c.fillRect(0, 0, VW, VH);
    if (fill > 0) {
      c.globalAlpha = fill; c.fillStyle = dark ? '#fff' : '#000'; c.fillRect(0, 0, VW, VH);
    }
    var keep = 1 - fill;

    // facets: translucent gradient fill + dark edge
    c.lineWidth = lw * 1.25; c.lineJoin = 'miter'; c.strokeStyle = '#12141a';
    var F = geo.facets;
    for (i = 0; i < F.length; i++) {
      f = F[i];
      var a = (T - f.t0) / FADE;
      if (a <= 0) continue;
      if (a > 1) a = 1;
      c.globalAlpha = a * keep;
      c.fillStyle = f.g;
      c.beginPath(); c.moveTo(f.x0, f.y0); c.lineTo(f.x1, f.y1); c.lineTo(f.x2, f.y2); c.closePath();
      c.fill();
      c.globalAlpha = a * 0.7 * keep;
      c.stroke();
    }

    // pale highlight on selected edges
    c.strokeStyle = '#dfe5f5'; c.lineWidth = lw * 0.9;
    for (i = 0; i < F.length; i++) {
      f = F[i];
      if (f.hl < 0) continue;
      var ah = (T - f.t0) / FADE;
      if (ah <= 0) continue;
      c.globalAlpha = Math.min(ah, 1) * f.ha * keep;
      c.beginPath();
      if (f.hl === 0) { c.moveTo(f.x0, f.y0); c.lineTo(f.x1, f.y1); }
      else if (f.hl === 1) { c.moveTo(f.x1, f.y1); c.lineTo(f.x2, f.y2); }
      else { c.moveTo(f.x2, f.y2); c.lineTo(f.x0, f.y0); }
      c.stroke();
    }

    // long cracks: dark groove + thin pale bevel
    var C = geo.cracks, off = 0.5 / this.k;
    for (i = 0; i < C.length; i++) {
      var s = C[i], ra = (T - s.t0) / 0.06;
      if (ra <= 0) continue;
      if (ra > 1) ra = 1;
      c.globalAlpha = ra * s.a * 0.35 * keep;
      c.strokeStyle = '#000'; c.lineWidth = lw * 1.7 * s.w;
      c.beginPath(); c.moveTo(s.x0, s.y0); c.lineTo(s.x1, s.y1); c.stroke();
      c.globalAlpha = ra * s.a * 0.4 * keep;
      c.strokeStyle = '#e8edff'; c.lineWidth = lw * 0.6 * s.w;
      c.beginPath(); c.moveTo(s.x0 + off, s.y0 + off); c.lineTo(s.x1 + off, s.y1 + off); c.stroke();
    }

    // brief impact flash
    if (o.flash && T < 1.2 && !(fill > 0.5)) {
      var fmax = 0;
      c.globalCompositeOperation = 'lighter';
      for (i = 0; i < geo.impacts.length; i++) {
        var im = geo.impacts[i], fl = 1 - (T - im.delay) / 0.2;
        if (fl <= 0 || fl > 1) continue;
        if (fl > fmax) fmax = fl;
        var rg = c.createRadialGradient(im.x, im.y, 0, im.x, im.y, 150);
        rg.addColorStop(0, 'rgba(255,255,255,' + (0.5 * fl * fl * keep).toFixed(3) + ')');
        rg.addColorStop(1, 'rgba(255,255,255,0)');
        c.globalAlpha = 1; c.fillStyle = rg; c.fillRect(im.x - 150, im.y - 150, 300, 300);
      }
      if (!pm && fmax > 0) {
        c.fillStyle = 'rgba(255,255,255,' + (0.06 * fmax).toFixed(3) + ')';
        c.fillRect(0, 0, VW, VH);
      }
      c.globalCompositeOperation = 'source-over';
    }
    c.globalAlpha = 1;
    var ms = performance.now() - t0;
    this.stats.drawMs = this.stats.drawMs ? this.stats.drawMs * 0.8 + ms * 0.2 : ms;
  };

  ShatterGlass.prototype._frame = function (now) {
    var el = now - this._start, T = el / this.dur, tgt = this.o.shakeTarget;
    this._draw(Math.min(T, 1.2));
    var shaking = this._shake && tgt && el < 380;
    if (shaking) {
      var amp = 5 * Math.pow(1 - el / 380, 2);
      tgt.style.transform = 'translate(' + (Math.sin(el * 0.09) * amp).toFixed(2) + 'px,' + (Math.cos(el * 0.13) * amp * 0.8).toFixed(2) + 'px)';
    } else if (this._shake && tgt && tgt.style.transform) {
      tgt.style.transform = this._prevTransform;
    }
    if (T < 1.2) { this._raf = requestAnimationFrame(this._tick); return; }
    this.state = 'shattered';
    this._raf = 0;
    this._draw(2);
    if (this.o.onDone) this.o.onDone(this);
  };

  /* Progress mode: the caller drives reveal with p in [0,1] (e.g. taps). No rAF is used. */
  ShatterGlass.prototype._drawProgress = function () {
    var p = this._prog ? this._prog.p : 0;
    this._draw(clamp(p / 0.82, 0, 1));
  };
  ShatterGlass.prototype.begin = function (seed) {
    if (seed !== undefined) this.o.seed = seed;
    this._build();
    this._resize();
    this.state = 'progress';
    this._prog = { p: 0, dark: true };
    this._drawProgress();
  };
  ShatterGlass.prototype.setProgress = function (p, dark) {
    this.state = 'progress';
    this._prog = { p: clamp(p, 0, 1), dark: dark !== false };
    this._drawProgress();
  };

  ShatterGlass.prototype.trigger = function () {
    this.reset(true);
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { this.state = 'shattered'; this._draw(2); if (this.o.onDone) this.o.onDone(this); return; }
    this.state = 'animating';
    this.dur = 1200 / this.o.speed;
    var tgt = this.o.shakeTarget;
    this._shake = this.o.shake && tgt;
    this._prevTransform = tgt ? tgt.style.transform : '';
    this._start = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  };

  ShatterGlass.prototype.reset = function (keepCanvasState) {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    var tgt = this.o.shakeTarget;
    if (tgt && this._shake) tgt.style.transform = this._prevTransform || '';
    this._shake = false;
    this.state = 'idle';
    this._prog = null;
    this._draw(0);
  };

  ShatterGlass.prototype.update = function (patch) {
    Object.assign(this.o, patch);
    this._build();
    if (this.state === 'shattered') this._draw(2);
    return this.stats;
  };

  ShatterGlass.prototype.destroy = function () {
    this.reset();
    if (this._ro) this._ro.disconnect();
    if (this._onWin) window.removeEventListener('resize', this._onWin);
    this.canvas.remove();
  };

  ShatterGlass.buildGeometry = buildGeometry;
  if (typeof module !== 'undefined' && module.exports) module.exports = ShatterGlass;
  else root.ShatterGlass = ShatterGlass;
})(typeof window !== 'undefined' ? window : this);

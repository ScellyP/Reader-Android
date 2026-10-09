/**
 * Glass-crack system, adapted from the "Glass Crack Effect" canvas pen
 * (bseth99's web-of-cracks algorithm): impact points -> radial lines at jittered
 * angles -> concentric ring points -> segments (radial + ring links + diagonals),
 * each drawn as a slightly bent quadratic curve with fracture shards and fine scratches.
 *
 * Differences for the lock screen:
 *  - impacts sit on the SCREEN EDGES and the web grows inward,
 *  - every segment has a progress window [start, end], so the cracks scale with
 *    progress = taps / target and reach everywhere at progress 1,
 *  - everything is batched into a few SVG path strings (cheap for react-native-svg).
 */
export interface Pt { x: number; y: number }
export interface Piece { u: number; d: string }          // revealed once the segment is grown past u
export interface Seg {
  p1: Pt; p2: Pt; cp: Pt;
  start: number; end: number;                             // progress window (0..1)
  web: number;
  full: string;
  shards: Piece[];
  scratches: Piece[];
}
export interface Web { cx: number; cy: number; rmax: number; delay: number }
export interface GlassSystem { w: number; h: number; webs: Web[]; segs: Seg[] }

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const f1 = (n: number) => n.toFixed(1);
const DEG = Math.PI / 180;

export const quadPoint = (s: { p1: Pt; p2: Pt; cp: Pt }, t: number): Pt => {
  const m = 1 - t;
  return {
    x: m * m * s.p1.x + 2 * m * t * s.cp.x + t * t * s.p2.x,
    y: m * m * s.p1.y + 2 * m * t * s.cp.y + t * t * s.p2.y,
  };
};
const quadTangent = (s: { p1: Pt; p2: Pt; cp: Pt }, t: number): Pt => ({
  x: 2 * (1 - t) * (s.cp.x - s.p1.x) + 2 * t * (s.p2.x - s.cp.x),
  y: 2 * (1 - t) * (s.cp.y - s.p1.y) + 2 * t * (s.p2.y - s.cp.y),
});

/** Sub-curve [0..t] of a quadratic Bezier (de Casteljau). */
function subQuadPath(s: Seg, t: number): string {
  if (t >= 1) return s.full;
  const a = { x: s.p1.x + (s.cp.x - s.p1.x) * t, y: s.p1.y + (s.cp.y - s.p1.y) * t };
  const b = { x: s.cp.x + (s.p2.x - s.cp.x) * t, y: s.cp.y + (s.p2.y - s.cp.y) * t };
  const c = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  return `M${f1(s.p1.x)} ${f1(s.p1.y)}Q${f1(a.x)} ${f1(a.y)} ${f1(c.x)} ${f1(c.y)}`;
}

function makeSeg(rnd: () => number, p1: Pt, p2: Pt, web: number, wb: Web, level: number): Seg | null {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const dl = Math.hypot(dx, dy);
  if (dl < 3) return null;
  const sx = dx / dl, sy = dy / dl, tx = dy / dl, ty = -dx / dl;
  const mpl1 = dl * (0.3 + rnd() * 0.5);
  const ll = Math.log(dl * Math.E);
  const cma = rnd() * ll * 1.5 - (ll * 1.5) / 2;               // bend, as in the pen
  const cp = { x: p1.x + sx * mpl1 + tx * cma, y: p1.y + sy * mpl1 + ty * cma };

  const rIn = Math.min(Math.hypot(p1.x - wb.cx, p1.y - wb.cy), Math.hypot(p2.x - wb.cx, p2.y - wb.cy));
  const rOut = Math.max(Math.hypot(p1.x - wb.cx, p1.y - wb.cy), Math.hypot(p2.x - wb.cx, p2.y - wb.cy));
  const span = (1 - wb.delay) * 0.94;
  let start = wb.delay + (span * rIn) / wb.rmax;
  start = Math.min(start, 0.97);
  const end = Math.min(1, Math.max(start + 0.01, start + (span * Math.max(rOut - rIn, 0.05 * wb.rmax)) / wb.rmax));

  const seg: Seg = {
    p1, p2, cp, start, end, web,
    full: `M${f1(p1.x)} ${f1(p1.y)}Q${f1(cp.x)} ${f1(cp.y)} ${f1(p2.x)} ${f1(p2.y)}`,
    shards: [], scratches: [],
  };

  // Fracture shards: little kites standing on the line (the pen's "fractures" layer).
  const nShards = dl < 24 ? 0 : Math.min(2, Math.floor(dl / 26));
  for (let i = 0; i < nShards; i++) {
    const u = 0.1 + rnd() * 0.75;
    const wU = (1.5 + rnd() * 2.5) / dl;
    const a = quadPoint(seg, u), c = quadPoint(seg, Math.min(1, u + wU));
    const tan = quadTangent(seg, u + wU / 2);
    const tl = Math.hypot(tan.x, tan.y) || 1;
    const nx = tan.y / tl, ny = -tan.x / tl;
    const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
    const h1 = 2 + rnd() * 9, h2 = 2 + rnd() * 9, skew = (rnd() - 0.5) * 8;
    const ax = mid.x + nx * h1 + (tan.x / tl) * skew, ay = mid.y + ny * h1 + (tan.y / tl) * skew;
    const bx = mid.x - nx * h2 - (tan.x / tl) * skew, by = mid.y - ny * h2 - (tan.y / tl) * skew;
    seg.shards.push({ u, d: `M${f1(a.x)} ${f1(a.y)}L${f1(ax)} ${f1(ay)}L${f1(c.x)} ${f1(c.y)}L${f1(bx)} ${f1(by)}Z` });
  }

  // Scratches: tiny hairlines around the main line (the pen's "noise" layer).
  const nScr = dl < 16 ? 0 : 2;
  for (let i = 0; i < nScr; i++) {
    const u = 0.05 + rnd() * 0.9;
    const q = quadPoint(seg, u);
    const tan = quadTangent(seg, u);
    const tl = Math.hypot(tan.x, tan.y) || 1;
    const off = (2 + rnd() * 7) * (rnd() < 0.5 ? -1 : 1);
    const x0 = q.x + (tan.y / tl) * off, y0 = q.y - (tan.x / tl) * off;
    const ang = Math.atan2(tan.y, tan.x) + (rnd() - 0.5) * 1.2, len = 4 + rnd() * 9;
    seg.scratches.push({ u, d: `M${f1(x0)} ${f1(y0)}L${f1(x0 + Math.cos(ang) * len)} ${f1(y0 + Math.sin(ang) * len)}` });
  }
  void level;
  return seg;
}

/** Deterministic glass web for a w x h screen. Impacts are on the edges, cracks grow inward. */
export function generateGlass(w: number, h: number, seed: number, webCount = 7, rays = 18): GlassSystem {
  const rnd = mulberry32(seed);
  const perimeter = 2 * (w + h);

  // shuffled start order so the first cracks appear on different sides
  const order = Array.from({ length: webCount }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const webs: Web[] = [];
  const segs: Seg[] = [];

  for (let wi = 0; wi < webCount; wi++) {
    const d = ((wi + 0.15 + rnd() * 0.7) / webCount) * perimeter;
    const inset = 3 + rnd() * 5;
    let cx: number, cy: number, inward: number; // inward = angle of the edge's inward normal
    if (d < w) { cx = d; cy = inset; inward = 90; }
    else if (d < w + h) { cx = w - inset; cy = d - w; inward = 180; }
    else if (d < 2 * w + h) { cx = w - (d - w - h); cy = h - inset; inward = 270; }
    else { cx = inset; cy = h - (d - 2 * w - h); inward = 0; }

    const rmax = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.05;
    const wb: Web = { cx, cy, rmax, delay: order[wi] * 0.06 };
    webs.push(wb);

    // ring radii (the pen grows r multiplicatively), last ring reaches rmax
    const radii: number[] = [];
    for (let r = 14; r < rmax; r += r < 60 ? r * (0.4 + rnd() * 0.3) : 38 + rnd() * 30) radii.push(r); // short steps = short, glass-like facets
    radii.push(rmax);

    const inside = (p: Pt) => p.x > 0 && p.x < w && p.y > 0 && p.y < h;
    const clampPt = (p: Pt): Pt => ({ x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) });
    // a ray point; `out` = it left the screen (it is clamped to the border and the ray stops there)
    type RP = { angle: number; pt: Pt; out: boolean } | null;
    const rings: RP[][] = [[]];
    for (let i = 0; i < rays; i++) {
      const a = inward - 100 + (200 / (rays - 1)) * i + (rnd() - 0.5) * 4;
      const pt = { x: cx + 5 * Math.cos(a * DEG), y: cy + 5 * Math.sin(a * DEG) };
      rings[0].push({ angle: a, pt: clampPt(pt), out: !inside(pt) });
    }
    for (let l = 1; l <= radii.length; l++) {
      rings[l] = [];
      for (let i = 0; i < rays; i++) {
        const prev = rings[l - 1][i];
        if (prev && !prev.out) {
          const a = prev.angle + (rnd() - 0.5) * 12;           // wander: cracks kink instead of ruling straight
          const r = radii[l - 1] * (0.88 + rnd() * 0.24);
          const raw = { x: cx + r * Math.cos(a * DEG), y: cy + r * Math.sin(a * DEG) };
          rings[l].push({ angle: a, pt: clampPt(raw), out: !inside(raw) });
        } else rings[l].push(null);
      }
    }
    for (let l = 1; l < rings.length; l++) {
      for (let g = 0; g < rays; g++) {
        const a = rings[l - 1][g], b = rings[l][g];
        if (!a || !b) continue;
        const s1 = makeSeg(rnd, a.pt, b.pt, wi, wb, l);                 // radial line
        if (s1) segs.push(s1);
        if (b.out) continue;
        if (g + 1 < rays && rnd() < 0.6) {                               // ring link (both ends on screen)
          const n = rings[l][g + 1];
          if (n && !n.out) { const s2 = makeSeg(rnd, b.pt, n.pt, wi, wb, l); if (s2) segs.push(s2); }
        }
        if (g + 1 < rays && l + 1 < rings.length && rnd() < 0.3) {       // diagonal to the next ring
          const n = rings[l + 1][g + 1];
          if (n && !n.out) { const s3 = makeSeg(rnd, b.pt, n.pt, wi, wb, l); if (s3) segs.push(s3); }
        }
      }
    }
  }
  return { w, h, webs, segs };
}

/** Grown fraction (0..1) of a segment at overall progress p, eased. */
export function crackFraction(s: { start: number; end: number }, p: number) {
  const f = clamp01((p - s.start) / Math.max(1e-6, s.end - s.start));
  return 1 - (1 - f) * (1 - f);
}

/** Full-screen fill that guarantees total coverage at p = 1. */
export const fillOpacity = (p: number) => smoothstep(0.82, 1, p);
/** Hairline (base-colour) cracks fade in as the screen turns to the inverse colour. */
export const coreOpacity = (p: number) => 0.15 + 0.85 * smoothstep(0.3, 0.9, p);
/** Strokes get bolder as progress rises. */
export const strokeScale = (p: number) => 1 + 1.2 * p;

export interface Pool { cx: number; cy: number; r: number; alpha: number }
export interface GlassLayers {
  lines: string;       // all grown segments, one path
  shards: string;      // fracture kites
  scratches: string;   // fine hairlines
  pools: Pool[];       // soft inverse-colour glow spreading from each impact
  fillOpacity: number;
  coreOpacity: number;
  scale: number;
  segCount: number;
}

export function crackLayers(sys: GlassSystem, p: number): GlassLayers {
  const lines: string[] = [], shards: string[] = [], scratches: string[] = [];
  let n = 0;
  for (const s of sys.segs) {
    const f = crackFraction(s, p);
    if (f <= 0) continue;
    n++;
    lines.push(subQuadPath(s, f));
    for (const sh of s.shards) if (f >= sh.u) shards.push(sh.d);
    for (const sc of s.scratches) if (f >= sc.u) scratches.push(sc.d);
  }
  const pools: Pool[] = [];
  for (const w of sys.webs) {
    const g = clamp01((p - w.delay) / (1 - w.delay));
    if (g <= 0) continue;
    pools.push({ cx: w.cx, cy: w.cy, r: g * w.rmax * 0.62, alpha: 0.9 * smoothstep(0.05, 0.85, g) });
  }
  return {
    lines: lines.join(""), shards: shards.join(""), scratches: scratches.join(""),
    pools, fillOpacity: fillOpacity(p), coreOpacity: coreOpacity(p), scale: strokeScale(p), segCount: n,
  };
}

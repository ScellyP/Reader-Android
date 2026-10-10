import { MOON_PHASES, moonLitPath, phaseIndexForCount } from "../src/moonPhase";
import {
  generateGlass, crackLayers, crackFraction, fillOpacity, quadPoint, strokeScale, renderProgress, facetOpacity,
  terminalPalette, shakeAmplitude, impactFlash, visibleSegmentCount, visibleFacetCount,
} from "../src/cracks";
import { TapProgress } from "../src/cheatCode";

let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`); };

// ---- moon phases ----
ok("8 phases in strict order", MOON_PHASES.join("|") ===
  "New Moon|Waxing Crescent|First Quarter|Waxing Gibbous|Full Moon|Waning Gibbous|Last Quarter|Waning Crescent");
ok("tap 0 New, 1 Waxing Crescent, 4 Full, 7 Waning Crescent, 8 wraps",
  MOON_PHASES[phaseIndexForCount(0)] === "New Moon" && MOON_PHASES[phaseIndexForCount(1)] === "Waxing Crescent" &&
  MOON_PHASES[phaseIndexForCount(4)] === "Full Moon" && MOON_PHASES[phaseIndexForCount(7)] === "Waning Crescent" &&
  phaseIndexForCount(8) === 0);
ok("new moon has no lit path, others do", moonLitPath(0, 50, 50, 40) === "" && [1,2,3,4,5,6,7].every(k => moonLitPath(k, 50, 50, 40).length > 0));

// ---- glass cracks ----
const W = 390, H = 844;
const sys = generateGlass(W, H, 20261010);
ok("deterministic per seed", JSON.stringify(sys) === JSON.stringify(generateGlass(W, H, 20261010)));
ok("different seed differs", JSON.stringify(sys) !== JSON.stringify(generateGlass(W, H, 7)));
ok("impacts are on the screen edges", sys.webs.every(w => Math.min(w.cx, W - w.cx, w.cy, H - w.cy) <= 9));
ok("exactly 4 webs, 26 rays each", sys.webs.length === 4 && sys.rayCount === 26);
ok("one impact per side, in top/right/bottom/left slots",
  sys.webs.map(w => w.side).join() === "top,right,bottom,left" &&
  sys.webs.every(w => w.side === "top" ? w.cy <= 8 : w.side === "right" ? W - w.cx <= 8 : w.side === "bottom" ? H - w.cy <= 8 : w.cx <= 8));
ok("stagger ranks are a permutation of 0..3", sys.webs.map(w => w.stagger).sort().join() === "0,1,2,3");
ok("first crack can come from any side",
  new Set(Array.from({ length: 24 }, (_, i) => generateGlass(120, 180, 100 + i).webs.find(w => w.stagger === 0)!.side)).size === 4);
ok("each web reaches past the screen diagonal", sys.webs.every(w => w.rmax >= Math.hypot(W / 2, H / 2) * 1.14));
ok("impacts spread over all four sides",
  [sys.webs.some(w => w.cy < 10), sys.webs.some(w => W - w.cx < 10), sys.webs.some(w => H - w.cy < 10), sys.webs.some(w => w.cx < 10)].every(Boolean));
ok("segment windows valid (0<=start<end<=1)", sys.segs.every(s => s.start >= 0 && s.end <= 1 && s.end > s.start));
ok("all segments fully grown at p=1", sys.segs.every(s => crackFraction(s, 1) === 1));
ok("fraction monotone in p", sys.segs.every(s => [0,.2,.4,.6,.8,1].every((p,i,a) => i === 0 || crackFraction(s,p) >= crackFraction(s,a[i-1]))));

const samples = (p: number) => {
  const pts: { x: number; y: number }[] = [];
  for (const s of sys.segs) {
    const f = crackFraction(s, p);
    if (f <= 0) continue;
    for (let t = 0; t <= f + 1e-9; t += 0.2) pts.push(quadPoint(s, Math.min(t, f)));
  }
  return pts;
};
const edgeDist = (q: { x: number; y: number }) => Math.min(q.x, W - q.x, q.y, H - q.y);
const lowMax = Math.max(...samples(0.1).map(edgeDist));
ok("early cracks hug the edges (p=0.1)", lowMax < 0.3 * W, `max dist to edge ${lowMax.toFixed(0)}px`);

const midMax = Math.max(...samples(0.5).map(edgeDist));
const lowMed = [...samples(0.1).map(edgeDist)].sort((a,b)=>a-b);
ok("reach grows with progress", midMax > lowMax, `${lowMax.toFixed(0)} -> ${midMax.toFixed(0)}px`);

const coverage = (p: number, cell = 40) => {
  const hit = new Set<string>();
  for (const q of samples(p)) if (q.x >= 0 && q.x < W && q.y >= 0 && q.y < H) hit.add(`${Math.floor(q.x / cell)},${Math.floor(q.y / cell)}`);
  return hit.size / (Math.ceil(W / cell) * Math.ceil(H / cell));
};
const c = [0.1, 0.3, 0.5, 0.7, 0.9, 1].map(p => coverage(p));
ok("crack coverage rises with progress", c.every((v, i) => i === 0 || v >= c[i - 1]), c.map(v => (v * 100).toFixed(0) + "%").join(" "));
ok("cracks touch >=85% of 40px cells by p=1", c[5] >= 0.85);

const n = (p: number) => crackLayers(sys, p).segCount;
ok("segment count grows", n(0.2) <= n(0.5) && n(0.5) <= n(0.9) && n(0.9) <= n(1));
ok("strokes bolder with progress", strokeScale(0.2) < strokeScale(0.8));
ok("fill 0 early, 1 at the end", fillOpacity(0.5) === 0 && fillOpacity(1) === 1);
ok("glass layer string size ok at p=1", crackLayers(sys, 1).lines.length < 150000, `${crackLayers(sys,1).lines.length} chars, ${sys.segs.length} segs`);

// ---- facets ----
ok("facets exist in all three brightness levels", new Set(sys.facets.map(f => f.level)).size === 3, `${sys.facets.length} facets`);
ok("facet count stays bounded", sys.facets.length < 10000 && sys.segs.length < 10000);
ok("facets pop in with progress", visibleFacetCount(sys, .2) <= visibleFacetCount(sys, .5) && visibleFacetCount(sys, .5) <= visibleFacetCount(sys, 1));
ok("segment count grows (helper)", visibleSegmentCount(sys, .2) <= visibleSegmentCount(sys, .6));
ok("facets are hidden under the terminal fill", sys.facets.every(f => facetOpacity(f, 1, true) === 0) && crackLayers(sys, 1).facetCount === 0);
const mid = crackLayers(sys, .5);
ok("batched tiers all populated at p=.5", mid.facets.every(t => t.length > 0));
const tilted = sys.facets.filter(f => f.tilt !== 0);
ok("some, not most, facets are displaced", tilted.length > 0 && tilted.length < sys.facets.length * 0.4 && tilted.every(f => Math.abs(f.tilt) <= 0.15));

// ---- feedback + terminal ----
ok("renderProgress never reaches 1 early, keeps 1 exact", renderProgress(.999) < 1 && renderProgress(1) === 1);
ok("terminal palette: dark = white+black, light = black+white",
  terminalPalette(true).fill === "#ffffff" && terminalPalette(true).crack === "#000000" &&
  terminalPalette(false).fill === "#000000" && terminalPalette(false).crack === "#ffffff");
ok("shake grows with progress", shakeAmplitude(.8) > shakeAmplitude(.2) && shakeAmplitude(0) > 0);
const w0 = sys.webs.find(w => w.stagger === 0)!;
ok("impact flash waits for its stagger, then scales", impactFlash(w0, 0) === null && impactFlash(w0, .5)!.radius > impactFlash(w0, .1)!.radius);
ok("flash count follows the staggered webs", crackLayers(sys, .05).flashes.length <= crackLayers(sys, .9).flashes.length && crackLayers(sys, .9).flashes.length === 4);

// ---- progress drives both ----
const tp = new TapProgress(10);
for (let i = 0; i < 5; i++) tp.tap();
ok("5/10 taps = 0.5 progress, phase index 5", tp.state.progress === 0.5 && tp.state.phaseIndex === 5);
for (let i = 0; i < 5; i++) tp.tap();
ok("10/10 => progress 1 and done", tp.state.progress === 1 && tp.state.done);
process.exit(fail ? 1 : 0);

const assert = require('node:assert/strict');

// Load the browser module in a small no-DOM environment; its pure state and
// procedural-geometry helpers are exported only when running under Node.
global.window = global;
global.document = { getElementById: () => null };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.crypto = { getRandomValues: values => { values[0] = 0x12345678; return values; } };
const moon = require('../app/src/main/assets/moon-lock.js');

const d = day => new Date(`${day}T12:00:00`);
assert.equal(moon.isCheatDay(d('2026-10-11')), true, 'Sunday is active');
assert.equal(moon.isCheatDay(d('2026-10-03')), true, 'first Saturday is active');
assert.equal(moon.isCheatDay(d('2026-10-17')), true, 'third Saturday is active');
assert.equal(moon.isCheatDay(d('2026-10-31')), true, 'fifth Saturday is active');
assert.equal(moon.isCheatDay(d('2026-10-24')), false, 'fourth non-holiday Saturday is inactive');
assert.equal(moon.isCheatDay(d('2026-10-10')), true, 'listed holiday overrides Saturday rule');

assert.equal(moon.phasePath(0, 60, 60, 50), '', 'new moon has no lit path');
assert.ok([1,2,3,4,5,6,7].every(i => moon.phasePath(i,60,60,50).length > 0), 'lit phases draw paths');
assert.ok(Array.from({length:50}, () => moon.randomTarget()).every(t => t >= 50 && t <= 100), 'target stays in 50..100');
assert.equal(moon.renderProgress(.999),.975,'render quantization cannot enter terminal mode early');
assert.equal(moon.renderProgress(1),1,'terminal frame is preserved exactly');

const taps = { count: 0, target: 3 };
assert.equal(moon.advanceTap(taps).progress, 1/3, 'tap progress is count divided by target');
moon.advanceTap(taps);
assert.equal(moon.advanceTap(taps).done, true, 'target tap completes progress');
assert.equal(moon.advanceTap(taps).count, 3, 'extra taps do not overshoot target');
assert.equal(moon.advanceTap(taps).phaseIndex, 3, 'phase index follows tap count');
const lowerBoundTarget={count:0,target:50};
for(let i=0;i<50;i++)moon.advanceTap(lowerBoundTarget);
assert.equal(moon.advanceTap(lowerBoundTarget).done,true,'50 taps reaches the minimum target cleanly');

const width = 390, height = 844, sys = moon.generateGlass(width, height, 20261010);
assert.deepEqual(sys.webs.map(w => w.side), ['top','right','bottom','left'], 'one impact is placed on each side');
assert.ok(sys.webs.every(w => w.side==='top'?w.cy<=8:w.side==='right'?width-w.cx<=8:w.side==='bottom'?height-w.cy<=8:w.cx<=8), 'impact origins sit on their assigned screen edges');
assert.equal(sys.rayCount, 26, 'each web uses 26 rays');
assert.equal(new Set(sys.webs.map(w => w.stagger)).size, 4, 'webs receive a shuffled sequence');
assert.deepEqual(sys.webs.map(w => w.stagger).sort(), [0,1,2,3], 'stagger ranks are consecutive');
assert.ok(sys.webs.every(w => w.delay >= 0 && w.delay <= .54), 'stagger delays stay in range');
assert.ok(sys.webs.every(w => w.rmax >= Math.hypot(width/2,height/2)*1.14), 'web reach extends beyond the screen diagonal');
assert.deepEqual(sys, moon.generateGlass(width,height,20261010), 'geometry is deterministic for a seed');
assert.ok(sys.segs.every(s => s.start >= 0 && s.end <= 1 && s.end > s.start), 'segment progress windows are valid');
assert.ok(sys.segs.length < 10000 && sys.facets.length < 10000, 'phone-sized geometry stays bounded for canvas redraws');
assert.ok(sys.facets.length > 0 && sys.facets.every(f => f.points.length === 6 && f.level >= 0 && f.level <= 2), 'facets are compact shaded triangles in three levels');
assert.deepEqual(new Set(sys.facets.map(f => f.level)), new Set([0,1,2]), 'all three facet brightness levels are generated');
assert.ok(moon.visibleSegmentCount(sys,.2) <= moon.visibleSegmentCount(sys,.5), 'crack count grows with progress');
assert.ok(moon.visibleFacetCount(sys,.2) <= moon.visibleFacetCount(sys,.5), 'facet count grows with progress');
assert.ok(moon.visibleFacetCount(sys,.5) <= moon.visibleFacetCount(sys,1), 'facet visibility tracks progress');
assert.equal(moon.facetOpacity(sys.facets[0],1,true), 0, 'facets clear beneath the terminal inversion');
assert.ok(moon.strokeScale(.8) > moon.strokeScale(.2), 'stroke weight grows with progress');
assert.equal(moon.fillOpacity(.5), 0, 'terminal fill does not appear early');
assert.equal(moon.fillOpacity(1), 1, 'terminal fill reaches full coverage');
assert.deepEqual(moon.terminalPalette(true), {fill:'#fff',crack:'#000'}, 'dark mode inverts to white glass with black cracks');
assert.deepEqual(moon.terminalPalette(false), {fill:'#000',crack:'#fff'}, 'light mode inverts to black glass with white cracks');
assert.ok(moon.shakeAmplitude(.8)>moon.shakeAmplitude(.2), 'screen shake intensifies with progress');
assert.equal(moon.impactFlash(sys.webs.find(w=>w.stagger===0),0).progress,0, 'impact flash waits for its web stagger');
assert.ok(moon.impactFlash(sys.webs.find(w=>w.stagger===0),.5).radius>moon.impactFlash(sys.webs.find(w=>w.stagger===0),.1).radius, 'impact flash scales with web progress');
const possibleStarts=new Set(Array.from({length:24},(_,i)=>{
  const sample=moon.generateGlass(120,180,100+i);
  return sample.webs.find(w=>w.stagger===0).side;
}));
assert.deepEqual(possibleStarts,new Set(['top','right','bottom','left']), 'random order can start at every screen side');

console.log(`Moon-lock geometry: ${sys.segs.length} segments, ${sys.facets.length} facets at ${width}x${height}.`);
console.log('Moon-lock state and rendering geometry checks passed.');

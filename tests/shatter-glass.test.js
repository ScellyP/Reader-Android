const assert = require('node:assert/strict');

// shatter-glass.js exports its pure geometry builder under Node (no DOM needed).
const ShatterGlass = require('../app/src/main/assets/shatter-glass.js');
const opts = { density: 1, impacts: 4, maxFacets: 650, stagger: true };

const a = ShatterGlass.buildGeometry(20261010, opts);
const b = ShatterGlass.buildGeometry(20261010, opts);
assert.deepEqual(a.facets.map(f => [f.x0, f.y0, f.t0]), b.facets.map(f => [f.x0, f.y0, f.t0]), 'geometry is deterministic for a seed');
assert.notDeepEqual(a.facets.map(f => f.x0), ShatterGlass.buildGeometry(7, opts).facets.map(f => f.x0), 'different seeds differ');
assert.ok(a.facets.length > 200 && a.facets.length <= 650, 'facet count is bounded by maxFacets');
assert.ok(a.facets.every(f => [f.x0, f.y0, f.x1, f.y1, f.x2, f.y2, f.t0, f.L0, f.L1, f.a0].every(Number.isFinite)), 'no NaN in facet data');
assert.equal(ShatterGlass.buildGeometry(3, { ...opts, maxFacets: 120 }).facets.length, 120, 'cap trims to the budget');
assert.equal(a.impacts.length, 4, 'four impacts');
assert.deepEqual(a.impacts.map(i => i.delay).sort((x, y) => x - y).map(x => +x.toFixed(2)), [0, .12, .24, .36], 'impacts are staggered in a seeded order');
assert.ok(a.facets.every(f => f.t0 >= 0 && f.t0 <= .6), 'facets are all revealed before the terminal fill');
assert.ok(a.cracks.length > 100 && a.cracks.every(c => c.t0 >= 0 && c.t0 <= .7), 'crack reveal times stay in range');
assert.equal(ShatterGlass.buildGeometry(3, { ...opts, stagger: false }).impacts.every(i => i.delay === 0), true, 'timed mode does not stagger');
console.log(`ShatterGlass: ${a.facets.length} facets, ${a.cracks.length} crack segments.`);
console.log('ShatterGlass geometry checks passed.');

// Run with: node tests/moon-puzzle.test.js
// Checks the Moonlit Lock unlock rules and secret star (app/src/main/assets/moon-lock.js).
// The puzzles themselves are tested in tests/moon-puzzles.test.js.
const assert = require('assert');
global.document = { getElementById: () => null, documentElement: {} };
global.window = {};
global.localStorage = { removeItem() {} };
const m = require('../app/src/main/assets/moon-lock.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

check('the unlock lasts 30 minutes', () => assert.strictEqual(m.PUZZLE_UNLOCK_MS, 30 * 60 * 1000));

check('the puzzle grant is shorter than the tap grant (in-memory path)', () => {
  const before = Date.now();
  m.grantUnlock('puzzle');
  assert.ok(m.isUnlocked(before + 29 * 60000));
  assert.ok(!m.isUnlocked(before + 31 * 60000));
});

check('the secret-star spots match the stars drawn by the .sky CSS', () => {
  const html = require('fs').readFileSync(__dirname + '/../app/src/main/assets/index.html', 'utf8');
  const spots = [];
  for (const sel of ['.sky::before {', '.sky::after {']) {
    const line = html.split('\n').find(l => l.startsWith(sel) && l.includes('background-image'));
    assert.ok(line, sel);
    for (const mt of line.matchAll(/circle at ([\d.]+)% ([\d.]+)%/g)) spots.push([parseFloat(mt[1]), parseFloat(mt[2])]);
  }
  assert.deepStrictEqual(m.STAR_SPOTS, spots);
});

check('a tap only counts when it is on the star', () => {
  const rect = { left: 0, top: 0, width: 400, height: 800 }, star = [25, 50]; // star at (100, 400)
  assert.ok(m.isStarHit(star, rect, 100, 400));
  assert.ok(m.isStarHit(star, rect, 100 + m.STAR_HIT - 1, 400));
  assert.ok(!m.isStarHit(star, rect, 100 + m.STAR_HIT + 1, 400));
  assert.ok(!m.isStarHit(star, rect, 300, 100));
  assert.ok(!m.isStarHit(null, rect, 100, 400));
});

check('the page loads moon-puzzles.js before moon-lock.js', () => {
  const html = require('fs').readFileSync(__dirname + '/../app/src/main/assets/index.html', 'utf8');
  const a = html.indexOf('<script src="moon-puzzles.js">'), b = html.indexOf('<script src="moon-lock.js">');
  assert.ok(a > 0 && b > a);
});

check('there is no puzzle button in the lock screen markup', () => {
  const html = require('fs').readFileSync(__dirname + '/../app/src/main/assets/index.html', 'utf8');
  assert.ok(!html.includes('night-lock-puzzle-btn'));
});

console.log(n + ' checks passed');

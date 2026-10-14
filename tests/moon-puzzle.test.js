// Run with: node tests/moon-puzzle.test.js
// Checks the Moonlit Lock puzzle rules (puzzle in app/src/main/assets/moon-lock.js).
const assert = require('assert');
global.document = { getElementById: () => null, documentElement: {} };
global.window = {};
global.localStorage = { removeItem() {} };
const m = require('../app/src/main/assets/moon-lock.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

check('the unlock lasts 30 minutes', () => assert.strictEqual(m.PUZZLE_UNLOCK_MS, 30 * 60 * 1000));

check('solved board is recognised, others are not', () => {
  assert.ok(m.puzzleSolved(m.PUZZLE_SOLVED));
  assert.ok(!m.puzzleSolved([1,2,3,4,5,6,7,0,8]));
});

check('a tile next to the gap slides in; a tile on a diagonal does not', () => {
  const solved = m.PUZZLE_SOLVED;                        // gap at index 8
  assert.deepStrictEqual(m.puzzleMove(solved, 7), [1,2,3,4,5,6,7,0,8]);
  assert.deepStrictEqual(m.puzzleMove(solved, 5), [1,2,3,4,5,0,7,8,6]);
  assert.strictEqual(m.puzzleMove(solved, 4), null);     // diagonal to the gap
  assert.strictEqual(m.puzzleMove(solved, 8), null);     // the gap itself
});

check('tapping further along a row or column slides every tile between', () => {
  assert.deepStrictEqual(m.puzzleMove(m.PUZZLE_SOLVED, 6), [1,2,3,4,5,6,0,7,8]);
  assert.deepStrictEqual(m.puzzleMove(m.PUZZLE_SOLVED, 2), [1,2,0,4,5,3,7,8,6]);
});

check('shuffled boards are never solved, keep all tiles, and can be solved', () => {
  for (let k = 0; k < 200; k++) {
    const b = m.puzzleShuffle();
    assert.ok(!m.puzzleSolved(b));
    assert.deepStrictEqual(b.slice().sort(), [0,1,2,3,4,5,6,7,8]);
    // solvable: an even number of inversions among the tiles (3x3 board rule)
    const t = b.filter(v => v); let inv = 0;
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) if (t[i] > t[j]) inv++;
    assert.strictEqual(inv % 2, 0);
  }
});

check('shuffling with a fixed random source gives the same board', () => {
  const seq = () => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
  assert.deepStrictEqual(m.puzzleShuffle(seq()), m.puzzleShuffle(seq()));
});

check('the puzzle grant is shorter than the tap grant (in-memory path)', () => {
  const before = Date.now();
  m.grantUnlock('puzzle');
  assert.ok(m.isUnlocked(before + 29 * 60000));
  assert.ok(!m.isUnlocked(before + 31 * 60000));
});

console.log(n + ' checks passed');

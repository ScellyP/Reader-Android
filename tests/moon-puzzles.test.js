// Run with: node tests/moon-puzzles.test.js
// Checks the six Moonlit Lock puzzles (app/src/main/assets/moon-puzzles.js): every generated
// puzzle must be solvable, the checks must reject wrong answers, and nothing may be trivia.
const assert = require('assert');
global.window = {};
const P = require('../app/src/main/assets/moon-puzzles.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }
function seeded(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const RUNS = 150;

check('there are exactly the six logic puzzle types', () => {
  assert.deepStrictEqual(P.PUZZLES.map(p => p.id), ['timing', 'grid', 'light', 'math', 'sequence', 'mastermind']);
  assert.deepStrictEqual(P.PUZZLES.map(p => p.name), ['Logic & Timing', 'Grid Match', 'Spatial Light Routing', 'Math & Combinatorics', 'Sequence Programming', 'Mastermind Variant']);
});

check('no puzzle is trivia: no question/answer text, no lookup tables', () => {
  const src = require('fs').readFileSync(__dirname + '/../app/src/main/assets/moon-puzzles.js', 'utf8');
  assert.ok(!/trivia|quiz|capital of|who wrote|which year/i.test(src.replace(/no trivia and no general knowledge/, '')));
  P.PUZZLES.forEach(p => { assert.strictEqual(typeof p.rule, 'string'); assert.ok(p.rule.length > 10); });
});

check('pickType never repeats the type just shown, and reaches all six', () => {
  const rnd = seeded(3), seen = new Set();
  let last = null;
  for (let i = 0; i < 300; i++) { const t = P.pickType(rnd, last); assert.notStrictEqual(t, last); seen.add(t); last = t; }
  assert.strictEqual(seen.size, 6);
});

check('every puzzle starts unsolved', () => {
  P.PUZZLES.forEach(p => { for (let i = 0; i < 40; i++) assert.ok(!p.solved(p.make(seeded(i + 1))), p.id); });
});

// 1. timing
check('timing: always has a solution tick (also the fallback), and a wrong tick is refused', () => {
  assert.ok(P.timingSolutions(P.TIMING_FALLBACK).length >= 1);
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('timing', seeded(i)), sol = P.timingSolutions(s.lamps);
    assert.ok(sol.length >= 1 && sol.length <= 3 && sol[0] >= 5);
    const wrong = Array.from({ length: P.TIMING_MAX + 1 }, (_, t) => t).find(t => !sol.includes(t));
    s.tick = wrong; assert.strictEqual(P.timingCommit(s), false); assert.ok(!s.done);
    s.tick = sol[0]; assert.strictEqual(P.timingCommit(s), true); assert.ok(s.done);
  }
});

// 2. grid
check('grid: the hidden solution is valid and matches the givens; duplicates are flagged', () => {
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('grid', seeded(i));
    assert.ok(P.latinValid(s.solution));
    s.cells.forEach((v, k) => { if (s.given[k]) assert.strictEqual(v, s.solution[k]); else assert.strictEqual(v, 0); });
    assert.ok(!P.latinValid(s.cells));
    s.cells = s.solution.slice();
    assert.ok(P.latinValid(s.cells));
    const bad = s.solution.slice(); bad[0] = bad[1];
    assert.ok(!P.latinValid(bad)); assert.ok(P.latinConflicts(bad).has(0));
  }
});

// 3. light
check('light: placing the built-in solution reaches the target within the mirror limit', () => {
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('light', seeded(i));
    assert.ok(!P.lightSolved(s));
    s.mirrors = s.solution.slice();
    assert.strictEqual(P.lightCount(s), s.max);
    assert.ok(P.lightTrace(s).reached && P.lightSolved(s));
    assert.ok(!s.walls[s.target] && s.solution.every((m, k) => !m || !s.walls[k]));
    s.mirrors[s.solution.findIndex(Boolean)] = '';
    assert.ok(!P.lightSolved(s));
  }
});
check('light: the fallback puzzle is solvable and starts unsolved', () => {
  const src = require('fs').readFileSync(__dirname + '/../app/src/main/assets/moon-puzzles.js', 'utf8');
  assert.ok(src.includes("solution[12] = '/'; solution[2] = '/';"));
  const s = { row: 2, target: 4, walls: Array(25).fill(false), mirrors: Array(25).fill(''), max: 2 };
  assert.ok(!P.lightTrace(s).reached);
  s.mirrors[12] = '/'; s.mirrors[2] = '/'; assert.ok(P.lightSolved(s));
});
check('light: a mirror bends the beam the right way, and walls block it', () => {
  const s = { row: 2, target: 4, walls: Array(25).fill(false), mirrors: Array(25).fill(''), max: 2 };
  s.mirrors[12] = '/'; s.mirrors[2] = '/';
  assert.deepStrictEqual(P.lightTrace(s).lit, [10, 11, 12, 7, 2, 3, 4]);
  s.walls[7] = true;
  assert.ok(!P.lightTrace(s).reached);
  assert.deepStrictEqual(P.reflect([0, 1], '/'), [-1, 0]);
  assert.deepStrictEqual(P.reflect([0, 1], '\\'), [1, 0]);
});

// 4. math
check('math: a valid pick exists, the check needs exactly k numbers and the exact sum', () => {
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('math', seeded(i));
    assert.strictEqual(new Set(s.nums).size, 7);
    const ways = P.mathWays(s.nums, s.k, s.target); assert.ok(ways >= 1 && ways <= 2);
    let found = null;
    (function rec(start, cur) {
      if (found) return;
      if (cur.length === s.k) { if (cur.reduce((a, j) => a + s.nums[j], 0) === s.target) found = cur.slice(); return; }
      for (let j = start; j < 7; j++) { cur.push(j); rec(j + 1, cur); cur.pop(); }
    })(0, []);
    s.picked = found; assert.ok(P.mathSolved(s));
    s.picked = found.slice(0, s.k - 1); assert.ok(!P.mathSolved(s));
  }
});

// 5. sequence
check('sequence: some program of palette instructions reaches the target; wrong ones are refused', () => {
  assert.strictEqual(P.seqApply('+3', 4), 7);
  assert.strictEqual(P.seqApply('-2', 4), 2);
  assert.strictEqual(P.seqApply('×3', 4), 12);
  assert.deepStrictEqual(P.seqRun(3, ['+2', '×2', '+5', '×2']), [3, 5, 10, 15, 30]);
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('sequence', seeded(i)), ways = P.seqWays(s.start, s.palette, s.target);
    assert.ok(ways >= 1 && ways <= 4);
    let hit = null, miss = null;
    (function rec(ops) {
      if (ops.length === P.SEQ_SLOTS) {
        const end = P.seqRun(s.start, ops)[P.SEQ_SLOTS];
        if (end === s.target && !hit) hit = ops.slice(); if (end !== s.target && !miss) miss = ops.slice(); return;
      }
      s.palette.forEach(op => { ops.push(op); rec(ops); ops.pop(); });
    })([]);
    s.slots = hit; assert.ok(P.seqSolved(s));
    s.slots = miss; assert.ok(!P.seqSolved(s));
    s.slots = hit.slice(); s.slots[3] = null; assert.ok(!P.seqSolved(s));
  }
});

// 6. mastermind
check('mastermind: scoring handles exact and misplaced pegs, and repeated guess colours', () => {
  assert.deepStrictEqual(P.mmScore([1, 2, 3, 4], [1, 2, 3, 4]), { exact: 4, misplaced: 0 });
  assert.deepStrictEqual(P.mmScore([1, 2, 3, 4], [2, 1, 4, 3]), { exact: 0, misplaced: 4 });
  assert.deepStrictEqual(P.mmScore([1, 2, 3, 4], [1, 1, 1, 1]), { exact: 1, misplaced: 0 });
  assert.deepStrictEqual(P.mmScore([1, 2, 3, 4], [5, 5, 5, 5]), { exact: 0, misplaced: 0 });
  assert.deepStrictEqual(P.mmScore([1, 2, 3, 4], [1, 5, 2, 5]), { exact: 1, misplaced: 1 });
});
check('mastermind: the code never repeats a colour; the game can be won and lost', () => {
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('mastermind', seeded(i));
    assert.strictEqual(new Set(s.secret).size, 4); assert.ok(s.secret.every(v => v >= 1 && v <= 5));
    assert.strictEqual(P.mmSubmit(s), null);                       // an incomplete guess is not accepted
    s.guess = s.secret.slice(); P.mmSubmit(s); assert.ok(s.won);
  }
  const s = P.make('mastermind', seeded(9));
  const wrong = s.secret.slice().reverse(); if (wrong.join() === s.secret.join()) wrong[0] = 0;
  for (let k = 0; k < P.MM_TRIES; k++) { s.guess = [1, 1, 1, 1]; P.mmSubmit(s); }
  assert.ok(s.failed && !s.won);
});
check('mastermind: a simple solver cracks every code within the 8 guesses', () => {
  const all = [];
  for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) for (let d = 1; d <= 5; d++) if (new Set([a, b, c, d]).size === 4) all.push([a, b, c, d]);
  assert.strictEqual(all.length, 120);
  let worst = 0;
  all.forEach(secret => {
    let cands = all.slice(), guesses = 0;
    for (;;) {
      const g = cands[0]; guesses++;
      const fb = P.mmScore(secret, g); if (fb.exact === 4) break;
      cands = cands.filter(c => { const f = P.mmScore(c, g); return f.exact === fb.exact && f.misplaced === fb.misplaced; });
    }
    worst = Math.max(worst, guesses);
  });
  assert.ok(worst <= P.MM_TRIES, 'worst case ' + worst);
});

console.log(n + ' checks passed');

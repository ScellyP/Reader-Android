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

check('there are exactly the twelve logic puzzle types', () => {
  assert.deepStrictEqual(P.PUZZLES.map(p => p.id), ['timing', 'grid', 'light', 'math', 'sequence', 'mastermind', 'lightsout', 'hanoi', 'slide', 'jugs', 'picross', 'truth']);
  assert.deepStrictEqual(P.PUZZLES.map(p => p.name), ['Logic & Timing', 'Grid Match', 'Spatial Light Routing', 'Math & Combinatorics', 'Sequence Programming', 'Mastermind Variant', 'Lights Out', 'Tower Shift', 'Slide Tiles', 'Pour Puzzle', 'Picross', 'Truth & Lies']);
});

check('no puzzle is trivia: no question/answer text, no lookup tables', () => {
  const src = require('fs').readFileSync(__dirname + '/../app/src/main/assets/moon-puzzles.js', 'utf8');
  assert.ok(!/trivia|quiz|capital of|who wrote|which year/i.test(src.replace(/no trivia and no general knowledge/, '')));
  P.PUZZLES.forEach(p => { assert.strictEqual(typeof p.rule, 'string'); assert.ok(p.rule.length > 10); });
});

check('pickType never repeats the type just shown, and reaches all twelve', () => {
  const rnd = seeded(3), seen = new Set();
  let last = null;
  for (let i = 0; i < 300; i++) { const t = P.pickType(rnd, last); assert.notStrictEqual(t, last); seen.add(t); last = t; }
  assert.strictEqual(seen.size, 12);
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

// 7. lights out
check('lightsout: always solvable by undoing the generating taps; a lone tap is not a solution', () => {
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('lightsout', seeded(i));
    assert.ok(P.LO_N === 4 && s.cells.length === 16 && P.loLit(s) >= 3);
    // brute force: some set of taps (taps commute) switches everything off
    let ok = false;
    for (let m = 0; m < 65536 && !ok; m++) {
      const t = { cells: s.cells.slice(), moves: 0 };
      for (let k = 0; k < 16; k++) if (m & (1 << k)) P.loPress(t, k);
      ok = P.loLit(t) === 0;
    }
    assert.ok(ok);
  }
  const s = { cells: Array(16).fill(false), moves: 0 }; P.loPress(s, 0); assert.strictEqual(P.loLit(s), 3);
});

// 8. tower shift
check('hanoi: legal start, never solved, bigger-on-smaller refused, can be solved', () => {
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('hanoi', seeded(i));
    s.pegs.forEach(peg => peg.forEach((d, k) => { if (k) assert.ok(peg[k - 1] > d); }));
    assert.strictEqual(s.pegs.reduce((a, p) => a + p.length, 0), P.HANOI_DISCS);
    assert.ok(s.pegs[s.target].length < P.HANOI_DISCS);
  }
  const s = { pegs: [[4, 3], [1], [2]], target: 2, from: null, moves: 0 };
  assert.ok(!P.hanoiMove(s, 0, 1));            // 3 onto 1: refused
  assert.ok(P.hanoiMove(s, 1, 2));              // 1 onto 2 is allowed
  const t = { pegs: [[4, 3, 2, 1], [], []], target: 2, from: null, moves: 0 };
  // classic recursive solution
  (function mv(n, a, b, c) { if (!n) return; mv(n - 1, a, c, b); assert.ok(P.hanoiMove(t, a, c)); mv(n - 1, b, a, c); })(4, 0, 1, 2);
  assert.strictEqual(t.pegs[2].length, 4); assert.strictEqual(t.moves, 15);
});

// 9. slide tiles
check('slide: a permutation of 0-8, reachable from solved (parity), never solved, moves only next to the blank', () => {
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('slide', seeded(i));
    assert.deepStrictEqual(s.tiles.slice().sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const flat = s.tiles.filter(Boolean); let inv = 0;
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) if (flat[a] > flat[b]) inv++;
    assert.strictEqual(inv % 2, 0);
    assert.ok(!P.slideSolved(s));
  }
  const s = { tiles: [1, 2, 3, 4, 5, 6, 7, 0, 8], moves: 0 };
  assert.ok(!P.slideMove(s, 0)); assert.ok(P.slideMove(s, 8)); assert.ok(P.slideSolved(s));
});

// 10. pour puzzle
check('jugs: the target is reachable in 4-7 pours (also the fallback), pours conserve water', () => {
  assert.strictEqual(P.jugsMinMoves([8, 5, 3], [8, 0, 0], 4) > 0, true);
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('jugs', seeded(i));
    const m = P.jugsMinMoves(s.caps, s.vols, s.target);
    assert.ok(m >= 4 && m <= 7 || (s.caps.join() === '8,5,3'), 'moves ' + m);
    assert.ok(!P.jugsSolved(s));
    const total = s.vols.reduce((a, b) => a + b, 0);
    const w = P.jugsPourState(s.vols, s.caps, 0, 1); assert.strictEqual(w.reduce((a, b) => a + b, 0), total);
    assert.ok(w.every((v, k) => v <= s.caps[k]));
  }
});

// 11. picross
check('picross: clues come from a real picture, an empty board is wrong, any matching picture is right', () => {
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('picross', seeded(i));
    assert.ok(!P.picSolved(s));
    s.cells = s.picture.slice(); assert.ok(P.picSolved(s));
    const flipped = s.picture.slice(); flipped[0] = !flipped[0]; s.cells = flipped; assert.ok(!P.picSolved(s));
  }
  assert.deepStrictEqual(P.picClues([1,1,0,1,0, 0,0,0,0,0, 1,1,1,1,1, 0,1,0,1,0, 1,0,0,0,1]).rows, [[2, 1], [0], [5], [1, 1], [1, 1]]);
});

// 12. truth & lies
check('truth: exactly one assignment fits what everyone said, and only it is accepted', () => {
  for (let i = 1; i <= RUNS; i++) {
    const s = P.make('truth', seeded(i)), sol = P.tlSolutions(s.stmts);
    assert.strictEqual(sol.length, 1);
    assert.ok(!P.tlSolved(s));
    s.guess = sol[0].slice(); assert.ok(P.tlSolved(s));
    const wrong = sol[0].slice(); wrong[0] = !wrong[0]; s.guess = wrong; assert.ok(!P.tlSolved(s));
    s.guess = sol[0].slice(); s.guess[2] = null; assert.ok(!P.tlSolved(s));
  }
});
check('generators rarely fall back to their fixed puzzle (truth, jugs, picross)', () => {
  let tl = 0, jg = 0, pc = 0;
  for (let i = 1; i <= RUNS; i++) {
    const t = P.make('truth', seeded(i)); if (t.stmts[0].k === 'liar' && t.stmts[0].j === 1 && t.stmts[3].k === 'truthful' && t.stmts[3].j === 0) tl++;
    if (P.make('jugs', seeded(i)).caps.join() === '8,5,3') jg++;
    if (P.make('picross', seeded(i)).picture.join() === [1,1,0,0,1, 0,1,1,1,0, 1,0,1,0,1, 0,1,1,0,1, 1,1,0,1,1].map(Boolean).join()) pc++;
  }
  assert.ok(tl < RUNS / 4 && jg < RUNS / 4 && pc < RUNS / 4, [tl, jg, pc].join());
});

console.log(n + ' checks passed');

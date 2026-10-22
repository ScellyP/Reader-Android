// Run with: node tests/moon-puzzles.test.js
// Checks the two Moonlit Lock puzzles (app/src/main/assets/moon-puzzles.js): every generated
// puzzle must be solvable and hard enough, the moves must obey the rules, and the screens must
// build and respond to clicks.
const assert = require('assert');
global.window = {};
const P = require('../app/src/main/assets/moon-puzzles.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }
function seeded(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const RUNS = 150;
const inversions = tiles => { const t = tiles.filter(Boolean); let c = 0; for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) if (t[i] > t[j]) c++; return c; };

check('there are exactly the two puzzle types', () => {
  assert.deepStrictEqual(P.PUZZLES.map(p => p.id), ['slide', 'flip']);
  assert.deepStrictEqual(P.PUZZLES.map(p => p.name), ['Phase Slide', 'Moon Flip']);
  P.PUZZLES.forEach(p => { assert.strictEqual(typeof p.rule, 'string'); assert.ok(p.rule.length > 10); });
});

check('no puzzle is trivia and nothing needs typing', () => {
  const src = require('fs').readFileSync(__dirname + '/../app/src/main/assets/moon-puzzles.js', 'utf8');
  assert.ok(!/trivia|quiz|capital of|who wrote|which year/i.test(src.replace(/no trivia/, '')));
  assert.ok(!/<input|<textarea|keydown|keyup|contenteditable/i.test(src));
});

check('pickType never repeats the type just shown, and reaches both', () => {
  const rnd = seeded(3), seen = new Set();
  for (let i = 0; i < 40; i++) {
    const t = P.pickType(rnd, 'slide'); assert.notStrictEqual(t, 'slide'); seen.add(t);
    const u = P.pickType(rnd, 'flip'); assert.notStrictEqual(u, 'flip'); seen.add(u);
  }
  assert.deepStrictEqual([...seen].sort(), ['flip', 'slide']);
});

check('the eight moon phases are drawn as eight different shapes', () => {
  const paths = Array.from({ length: P.MOON_PHASES }, (_, k) => P.moonLitPath(k));
  assert.strictEqual(P.MOON_PHASES, 8);
  assert.strictEqual(paths[0], '');                       // new moon: nothing lit
  assert.strictEqual(new Set(paths).size, 8);
  assert.ok(paths[4].includes('A40 40 0 1 1 50 90A40 40 0 1 1 50 10'));   // full moon: whole disc
  // waxing is lit on the right (rim sweeps clockwise), waning on the left
  [1, 2, 3].forEach(k => assert.ok(paths[k].startsWith('M50 10A40 40 0 0 1 50 90'), 'waxing ' + k));
  [5, 6, 7].forEach(k => assert.ok(paths[k].startsWith('M50 10A40 40 0 0 0 50 90'), 'waning ' + k));
  assert.ok(paths[2].includes('L50 10') && paths[6].includes('L50 10'));   // quarters: straight line
  assert.ok(!/NaN/.test(paths.join()));
});

// ---- Phase Slide ----
check('slide: every start is a solvable, scrambled, hard position', () => {
  const rnd = seeded(11);
  for (let i = 0; i < RUNS; i++) {
    const s = P.make('slide', rnd);
    assert.deepStrictEqual(s.tiles.slice().sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.strictEqual(s.moves, 0);
    assert.ok(!P.slideSolved(s));
    assert.strictEqual(inversions(s.tiles) % 2, 0, 'solvable (even inversions)');
    assert.ok(P.slideDistance(s) >= P.SLIDE_MIN_DISTANCE, 'too easy: ' + P.slideDistance(s));
  }
});

check('slide: only tiles next to the gap move, and the moves can be undone', () => {
  const s = { tiles: P.SLIDE_DONE.slice(), moves: 0 };
  assert.ok(P.slideSolved(s));
  assert.ok(!P.slideMove(s, 0));            // not beside the gap
  assert.ok(!P.slideMove(s, 4));
  assert.ok(P.slideMove(s, 7));
  assert.deepStrictEqual(s.tiles, [1, 2, 3, 4, 5, 6, 7, 0, 8]);
  assert.strictEqual(s.moves, 1);
  assert.ok(!P.slideSolved(s));
  assert.ok(P.slideMove(s, 8));
  assert.ok(P.slideSolved(s));
});

// ---- Moon Flip ----
check('flip: every start is a scrambled stack that needs at least seven flips', () => {
  const rnd = seeded(21);
  for (let i = 0; i < RUNS; i++) {
    const s = P.make('flip', rnd);
    assert.deepStrictEqual(s.pile.slice().sort(), [1, 2, 3, 4, 5, 6, 7]);
    assert.strictEqual(s.moves, 0);
    assert.ok(!P.flipSolved(s));
    const d = P.flipMinMoves(s);
    assert.ok(d >= P.FLIP_MIN_MOVES && d <= 8, 'min flips ' + d);
  }
});

check('flip: a flip reverses the chosen disc and everything above it', () => {
  const s = { pile: [3, 1, 4, 2, 7, 5, 6], moves: 0 };
  assert.ok(!P.flipApply(s, 0));            // the top disc alone: nothing changes, nothing counted
  assert.ok(!P.flipApply(s, 7));
  assert.strictEqual(s.moves, 0);
  assert.ok(P.flipApply(s, 3));
  assert.deepStrictEqual(s.pile, [2, 4, 1, 3, 7, 5, 6]);
  assert.strictEqual(s.moves, 1);
  assert.ok(!P.flipSolved(s));
  assert.ok(P.flipSolved({ pile: [1, 2, 3, 4, 5, 6, 7] }));
});

check('flip: playing it right always solves it in the fewest flips', () => {
  const rnd = seeded(5);
  for (let i = 0; i < 40; i++) {
    const s = P.make('flip', rnd), best = P.flipMinMoves(s);
    while (!P.flipSolved(s)) {
      const before = P.flipMinMoves(s);
      let moved = false;
      for (let k = 1; k < P.FLIP_N && !moved; k++) {
        const t = { pile: s.pile.slice(), moves: 0 }; P.flipApply(t, k);
        if (P.flipMinMoves(t) === before - 1) { P.flipApply(s, k); moved = true; }
      }
      assert.ok(moved, 'a flip that gets closer always exists');
    }
    assert.strictEqual(s.moves, best);
  }
});

// ---- The screens ----
function fakeDom() {
  const make = tag => {
    const e = { tag, className: '', children: [], attrs: {}, style: {}, listeners: {}, disabled: false, _text: '' };
    e.appendChild = c => { e.children.push(c); return c; };
    e.setAttribute = (k, v) => { e.attrs[k] = v; };
    e.addEventListener = (t, f) => { e.listeners[t] = f; };
    Object.defineProperty(e, 'textContent', { get: () => e._text, set: v => { e._text = v; if (v === '') e.children = []; } });
    return e;
  };
  global.document = { createElement: make, createElementNS: (ns, tag) => make(tag) };
  return make;
}
const all = (e, pred, out = []) => { if (pred(e)) out.push(e); e.children.forEach(c => all(c, pred, out)); return out; };

check('slide screen: a gap, eight moons, and tapping a neighbour slides it', () => {
  const make = fakeDom(), host = make('div');
  const s = { tiles: [1, 2, 3, 4, 5, 6, 7, 0, 8], moves: 0 };
  let changed = 0;
  P.get('slide').render(host, s, () => changed++, false);
  const buttons = all(host, e => e.tag === 'button');
  assert.strictEqual(buttons.length, 9);
  assert.strictEqual(all(host, e => e.attrs.class === 'pz-moon').length, 8 + 8);   // 8 tiles + the goal strip
  assert.ok(buttons[7].disabled && buttons[7].className.includes('pz-blank'));
  buttons[8].listeners.click();
  assert.strictEqual(changed, 1);
  assert.ok(P.slideSolved(s));
  assert.strictEqual(P.get('slide').status(s), '1 slides');
});

check('flip screen: seven discs of different widths; tapping one flips from there', () => {
  const make = fakeDom(), host = make('div');
  const s = { pile: [2, 1, 3, 4, 5, 6, 7], moves: 0 };
  let changed = 0;
  P.get('flip').render(host, s, () => changed++, false);
  const buttons = all(host, e => e.tag === 'button');
  assert.strictEqual(buttons.length, 7);
  assert.ok(buttons[0].disabled);
  const widths = all(host, e => e.className === 'pz-bar').map(e => e.style.width);
  assert.strictEqual(new Set(widths).size, 7);
  buttons[1].listeners.click();
  assert.strictEqual(changed, 1);
  assert.ok(P.flipSolved(s));
  assert.strictEqual(P.get('flip').solved(s), true);
  const done = make('div'); P.get('flip').render(done, s, () => {}, true);
  assert.ok(all(done, e => e.tag === 'button').every(b => b.disabled));
});

console.log(n + ' checks passed');

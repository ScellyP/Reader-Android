/* Moonlit Lock puzzles (loaded before moon-lock.js).
   Twelve pure-logic puzzles, no trivia and no general knowledge: everything needed to
   solve one is on the screen. Each generator builds a puzzle that can always be solved.

   1. timing     Logic & Timing           find the tick at which every lamp is lit
   2. grid       Grid Match               fill a 4x4 grid, each symbol once per row and column
   3. light      Spatial Light Routing    place mirrors so the beam reaches the target
   4. math       Math & Combinatorics     pick exactly k numbers that add up to the target
   5. sequence   Sequence Programming     fill the program slots so the number machine hits the target
   6. mastermind Mastermind Variant       crack a 4-peg code (5 colours, no repeats) in 8 guesses
   7. lightsout  Lights Out               tapping a lamp flips it and its neighbours; switch all off
   8. hanoi      Tower Shift              Tower of Hanoi from a random position, onto the starred peg
   9. slide      Slide Tiles              8-puzzle: order the tiles 1-8
  10. jugs       Pour Puzzle              pour between jugs to measure an exact amount
  11. picross    Picross                  5x5 nonogram from run-length clues
  12. truth      Truth & Lies             who always tells the truth and who always lies
   A puzzle is { id, name, rule, make(rand), solved(state), status(state), render(host, state, change, done) }.
   make/solved/status are pure (tested in tests/moon-puzzles.test.js); render builds the DOM. */
(function () {
  'use strict';

  const int = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
  function shuffle(rnd, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  const sum = arr => arr.reduce((a, b) => a + b, 0);

  // ---- 1. Logic & Timing ------------------------------------------------
  // Every lamp repeats "lit for `on` ticks, dark for `off` ticks". `start` is how far into
  // its cycle it already is at tick 0. Find a tick where all lamps are lit together.
  const TIMING_MAX = 30;
  function lampLit(l, t) { return ((t + l.start) % (l.on + l.off)) < l.on; }
  function timingAllLit(lamps, t) { return lamps.every(l => lampLit(l, t)); }
  function timingSolutions(lamps) {
    const out = [];
    for (let t = 0; t <= TIMING_MAX; t++) if (timingAllLit(lamps, t)) out.push(t);
    return out;
  }
  const TIMING_FALLBACK = [{ on: 2, off: 3, start: 0 }, { on: 1, off: 2, start: 0 }, { on: 1, off: 3, start: 2 }];
  function timingMake(rnd) {
    for (let tries = 0; tries < 500; tries++) {
      const lamps = [], n = int(rnd, 3, 4);
      for (let i = 0; i < n; i++) {
        const on = int(rnd, 1, 3), off = int(rnd, 2, 4);
        lamps.push({ on, off, start: int(rnd, 0, on + off - 1) });
      }
      const sol = timingSolutions(lamps);
      if (sol.length >= 1 && sol.length <= 3 && sol[0] >= 5) return { lamps, tick: 0, done: false, msg: '' };
    }
    return { lamps: TIMING_FALLBACK.map(l => Object.assign({}, l)), tick: 0, done: false, msg: '' };
  }
  function timingCommit(s) {
    if (timingAllLit(s.lamps, s.tick)) { s.done = true; s.msg = ''; return true; }
    s.msg = 'Not every lamp is lit at tick ' + s.tick + '.';
    return false;
  }

  // ---- 2. Grid Match ----------------------------------------------------
  // A Latin square: each of the four symbols exactly once in every row and column.
  const LATIN_N = 4;
  function latinConflicts(cells) {
    const bad = new Set(), N = LATIN_N;
    function scan(indices) {
      const seen = {};
      indices.forEach(i => { const v = cells[i]; if (!v) return; (seen[v] = seen[v] || []).push(i); });
      Object.keys(seen).forEach(v => { if (seen[v].length > 1) seen[v].forEach(i => bad.add(i)); });
    }
    for (let k = 0; k < N; k++) {
      scan(Array.from({ length: N }, (_, c) => k * N + c));
      scan(Array.from({ length: N }, (_, r) => r * N + k));
    }
    return bad;
  }
  function latinValid(cells) { return cells.every(v => v >= 1 && v <= LATIN_N) && latinConflicts(cells).size === 0; }
  function gridMake(rnd) {
    const N = LATIN_N, rows = shuffle(rnd, [0, 1, 2, 3]), cols = shuffle(rnd, [0, 1, 2, 3]), sym = shuffle(rnd, [1, 2, 3, 4]);
    const solution = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) solution.push(sym[(rows[r] + cols[c]) % N]);
    const holes = new Set(shuffle(rnd, Array.from({ length: N * N }, (_, i) => i)).slice(0, 9));
    return { solution, cells: solution.map((v, i) => holes.has(i) ? 0 : v), given: solution.map((_, i) => !holes.has(i)) };
  }

  // ---- 3. Spatial Light Routing -----------------------------------------
  // A beam enters the left edge of one row heading right. '/' and '\' mirrors bend it.
  // Walls stop it. Reach the target using no more mirrors than the limit.
  const LIGHT_N = 5;
  const DIR = { E: [0, 1], N: [-1, 0], W: [0, -1], S: [1, 0] };
  function reflect(d, m) { return m === '/' ? [-d[1] || 0, -d[0] || 0] : [d[1], d[0]]; }
  function lightTrace(s) {
    const N = LIGHT_N, lit = [];
    let r = s.row, c = 0, d = DIR.E, reached = false;
    for (let step = 0; step < 200 && r >= 0 && r < N && c >= 0 && c < N; step++) {
      const i = r * N + c;
      if (s.walls[i]) break;
      lit.push(i);
      if (i === s.target) { reached = true; break; }
      if (s.mirrors[i]) d = reflect(d, s.mirrors[i]);
      r += d[0]; c += d[1];
    }
    return { lit, reached };
  }
  function lightCount(s) { return s.mirrors.filter(Boolean).length; }
  function mirrorFor(from, to) { return ['/', '\\'].find(m => { const d = reflect(from, m); return d[0] === to[0] && d[1] === to[1]; }); }
  function lightMake(rnd) {
    const N = LIGHT_N;
    for (let tries = 0; tries < 400; tries++) {
      const row = int(rnd, 0, N - 1), want = int(rnd, 2, 4), solution = Array(N * N).fill('');
      let r = row, c = 0, d = DIR.E, turns = 0, ok = true, target = -1;
      const visited = new Set([r * N + c]);
      for (let leg = 0; leg < 12 && ok; leg++) {
        const run = leg === 0 ? int(rnd, 0, 3) : int(rnd, 1, 3);
        for (let k = 0; k < run; k++) {
          r += d[0]; c += d[1];
          if (r < 0 || r >= N || c < 0 || c >= N || visited.has(r * N + c)) { ok = false; break; }
          visited.add(r * N + c);
        }
        if (!ok) break;
        if (turns >= want) { target = r * N + c; break; }
        const options = shuffle(rnd, [[d[1], d[0]], [-d[1], -d[0]]]).filter(nd => {
          const nr = r + nd[0], nc = c + nd[1];
          return nr >= 0 && nr < N && nc >= 0 && nc < N && !visited.has(nr * N + nc);
        });
        if (!options.length || solution[r * N + c]) { ok = false; break; }
        solution[r * N + c] = mirrorFor(d, options[0]);
        d = options[0]; turns++;
      }
      if (!ok || target < 0 || turns < 2 || target === row * N) continue;
      const walls = Array(N * N).fill(false);
      shuffle(rnd, Array.from({ length: N * N }, (_, i) => i).filter(i => !visited.has(i))).slice(0, int(rnd, 2, 4)).forEach(i => { walls[i] = true; });
      const puzzle = { row, target, walls, mirrors: Array(N * N).fill(''), max: turns, solution, msg: '' };
      if (lightTrace(puzzle).reached) continue;      // the straight beam must not already hit the target
      return puzzle;
    }
    // fixed fallback: row 2, '/' at (2,2) sends the beam north, '/' at (0,2) sends it east to (0,4)
    const solution = Array(25).fill(''); solution[12] = '/'; solution[2] = '/';
    return { row: 2, target: 4, walls: Array(25).fill(false), mirrors: Array(25).fill(''), max: 2, solution, msg: '' };
  }
  function lightSolved(s) { return lightCount(s) <= s.max && lightTrace(s).reached; }

  // ---- 4. Math & Combinatorics ------------------------------------------
  // Pick exactly k of the numbers so that they add up to the target.
  function combos(n, k) {
    const out = [];
    (function rec(start, cur) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (let i = start; i < n; i++) { cur.push(i); rec(i + 1, cur); cur.pop(); }
    })(0, []);
    return out;
  }
  function mathWays(nums, k, target) { return combos(nums.length, k).filter(c => sum(c.map(i => nums[i])) === target).length; }
  function mathMake(rnd) {
    for (let tries = 0; tries < 500; tries++) {
      const k = int(rnd, 3, 4);
      const nums = shuffle(rnd, Array.from({ length: 23 }, (_, i) => i + 2)).slice(0, 7).sort((a, b) => a - b);
      const chosen = shuffle(rnd, [0, 1, 2, 3, 4, 5, 6]).slice(0, k);
      const target = sum(chosen.map(i => nums[i])), ways = mathWays(nums, k, target);
      if (ways >= 1 && ways <= 2) return { nums, k, target, picked: [] };
    }
    return { nums: [3, 5, 8, 9, 12, 14, 17], k: 3, target: 26, picked: [] }; // 3 + 9 + 14
  }
  function mathSum(s) { return sum(s.picked.map(i => s.nums[i])); }
  function mathSolved(s) { return s.picked.length === s.k && mathSum(s) === s.target; }

  // ---- 5. Sequence Programming ------------------------------------------
  // A number machine runs its slots in order, left to right, starting from the start value.
  const SEQ_SLOTS = 4;
  function seqApply(op, v) {
    const n = Number(op.slice(1));
    return op[0] === '+' ? v + n : op[0] === '-' ? v - n : v * n;
  }
  function seqRun(start, ops) { const vals = [start]; ops.forEach(op => vals.push(seqApply(op, vals[vals.length - 1]))); return vals; }
  const SEQ_POOL = ['+1', '+2', '+3', '+4', '+5', '-1', '-2', '-3', '×2', '×3'];
  function seqWays(start, palette, target) {
    let n = 0;
    (function rec(ops) {
      if (ops.length === SEQ_SLOTS) { if (seqRun(start, ops)[SEQ_SLOTS] === target) n++; return; }
      palette.forEach(op => { ops.push(op); rec(ops); ops.pop(); });
    })([]);
    return n;
  }
  function seqMake(rnd) {
    for (let tries = 0; tries < 500; tries++) {
      const start = int(rnd, 2, 9);
      const multipliers = shuffle(rnd, SEQ_POOL.filter(o => o[0] === '×')).slice(0, 1);
      const palette = shuffle(rnd, SEQ_POOL.filter(o => o[0] !== '×')).slice(0, 4).concat(multipliers);
      const program = Array.from({ length: SEQ_SLOTS }, () => pick(rnd, palette));
      const vals = seqRun(start, program), target = vals[SEQ_SLOTS];
      if (vals.some(v => v < 1 || v > 150) || target === start) continue;
      const ways = seqWays(start, palette, target);
      if (ways >= 1 && ways <= 4) return { start, palette: shuffle(rnd, palette), target, slots: Array(SEQ_SLOTS).fill(null) };
    }
    return { start: 3, palette: ['+2', '+5', '-1', '+1', '×2'], target: 30, slots: Array(SEQ_SLOTS).fill(null) }; // 3 +2 ×2 +5 ×2 = 30
  }
  function seqValues(s) {
    const ops = []; for (const op of s.slots) { if (!op) break; ops.push(op); }
    return seqRun(s.start, ops);
  }
  function seqSolved(s) { return s.slots.every(Boolean) && seqRun(s.start, s.slots)[SEQ_SLOTS] === s.target; }

  // ---- 6. Mastermind variant --------------------------------------------
  // The secret is 4 different colours out of 5. After each guess you learn how many are the
  // right colour in the right place, and how many are the right colour in the wrong place.
  const MM_COLOURS = 5, MM_LEN = 4, MM_TRIES = 8;
  function mmScore(secret, guess) {
    let exact = 0;
    const cs = Array(MM_COLOURS + 1).fill(0), cg = Array(MM_COLOURS + 1).fill(0);
    for (let i = 0; i < MM_LEN; i++) {
      if (secret[i] === guess[i]) exact++;
      cs[secret[i]]++; cg[guess[i]]++;
    }
    let common = 0;
    for (let v = 1; v <= MM_COLOURS; v++) common += Math.min(cs[v], cg[v]);
    return { exact, misplaced: common - exact };
  }
  function mmMake(rnd) {
    return { secret: shuffle(rnd, [1, 2, 3, 4, 5]).slice(0, MM_LEN), guess: Array(MM_LEN).fill(0), history: [], won: false, failed: false };
  }
  function mmSubmit(s) {
    if (s.won || s.failed || s.guess.some(v => !v)) return null;
    const fb = mmScore(s.secret, s.guess);
    s.history.push({ guess: s.guess.slice(), exact: fb.exact, misplaced: fb.misplaced });
    if (fb.exact === MM_LEN) s.won = true;
    else if (s.history.length >= MM_TRIES) s.failed = true;
    s.guess = Array(MM_LEN).fill(0);
    return fb;
  }

  // ---- 7. Lights Out ----------------------------------------------------
  // Tapping a lamp flips it and the lamps directly above, below, left and right of it.
  const LO_N = 4;
  function loPress(s, i) {
    const N = LO_N, r = Math.floor(i / N), c = i % N;
    [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(d => {
      const rr = r + d[0], cc = c + d[1];
      if (rr >= 0 && rr < N && cc >= 0 && cc < N) s.cells[rr * N + cc] = !s.cells[rr * N + cc];
    });
  }
  function loLit(s) { return s.cells.filter(Boolean).length; }
  function loMake(rnd) {
    // Start dark and press a few random lamps: pressing the same lamps again always undoes it.
    for (let tries = 0; tries < 200; tries++) {
      const s = { cells: Array(LO_N * LO_N).fill(false), moves: 0 };
      shuffle(rnd, Array.from({ length: LO_N * LO_N }, (_, i) => i)).slice(0, int(rnd, 3, 4)).forEach(i => loPress(s, i));
      if (loLit(s) >= 3) return s;
    }
    const s = { cells: Array(LO_N * LO_N).fill(false), moves: 0 };
    [0, 5, 10].forEach(i => loPress(s, i));
    return s;
  }

  // ---- 8. Tower Shift (Tower of Hanoi from a random position) ------------
  // Four discs sit on three pegs. Move one disc at a time, never a bigger disc onto a smaller
  // one, until all four are stacked on the starred peg.
  const HANOI_DISCS = 4;
  function hanoiCanMove(s, from, to) {
    const a = s.pegs[from], b = s.pegs[to];
    if (from === to || !a.length) return false;
    return !b.length || b[b.length - 1] > a[a.length - 1];
  }
  function hanoiMove(s, from, to) {
    if (!hanoiCanMove(s, from, to)) return false;
    s.pegs[to].push(s.pegs[from].pop()); s.moves++;
    return true;
  }
  function hanoiMake(rnd) {
    for (let tries = 0; tries < 100; tries++) {
      const pegs = [[], [], []];
      for (let d = HANOI_DISCS; d >= 1; d--) pegs[int(rnd, 0, 2)].push(d);   // any split is a legal position
      const target = int(rnd, 0, 2);
      if (pegs[target].length < HANOI_DISCS) return { pegs, target, from: null, moves: 0, msg: '' };
    }
    return { pegs: [[4, 3, 2, 1], [], []], target: 2, from: null, moves: 0, msg: '' };
  }

  // ---- 9. Slide Tiles (8-puzzle) ----------------------------------------
  // Slide the numbered tiles into order, blank in the last corner. The start is made by sliding
  // tiles around from the finished picture, so it can always be undone.
  const SLIDE_N = 3;
  const SLIDE_DONE = [1, 2, 3, 4, 5, 6, 7, 8, 0];
  function slideNeighbours(i) {
    const N = SLIDE_N, r = Math.floor(i / N), c = i % N, out = [];
    if (r > 0) out.push(i - N); if (r < N - 1) out.push(i + N);
    if (c > 0) out.push(i - 1); if (c < N - 1) out.push(i + 1);
    return out;
  }
  function slideMove(s, i) {
    const blank = s.tiles.indexOf(0);
    if (!slideNeighbours(blank).includes(i)) return false;
    s.tiles[blank] = s.tiles[i]; s.tiles[i] = 0; s.moves++;
    return true;
  }
  function slideSolved(s) { return s.tiles.every((v, i) => v === SLIDE_DONE[i]); }
  function slideMake(rnd) {
    for (let tries = 0; tries < 50; tries++) {
      const s = { tiles: SLIDE_DONE.slice(), moves: 0 };
      let prev = -1;
      for (let k = int(rnd, 22, 34); k > 0; k--) {
        const blank = s.tiles.indexOf(0), opts = slideNeighbours(blank).filter(n => n !== prev);
        const n = pick(rnd, opts); prev = blank; slideMove(s, n);
      }
      s.moves = 0;
      if (!slideSolved(s)) return s;
    }
    return { tiles: [1, 2, 3, 4, 0, 6, 7, 5, 8], moves: 0 };
  }

  // ---- 10. Pour Puzzle (water jugs) -------------------------------------
  // Pour water between jugs (a pour stops when the source is empty or the target is full).
  // Get exactly the target amount into any one jug.
  function jugsPourState(vols, caps, from, to) {
    const amt = Math.min(vols[from], caps[to] - vols[to]);
    if (from === to || amt <= 0) return null;
    const next = vols.slice(); next[from] -= amt; next[to] += amt;
    return next;
  }
  // Fewest pours (breadth-first) from `start` until some jug holds exactly `target`; -1 if never.
  function jugsMinMoves(caps, start, target) {
    const seen = new Set([start.join()]);
    let layer = [start], dist = 0;
    while (layer.length) {
      if (layer.some(v => v.includes(target))) return dist;
      const next = [];
      layer.forEach(v => { for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        const w = jugsPourState(v, caps, a, b);
        if (w && !seen.has(w.join())) { seen.add(w.join()); next.push(w); }
      } });
      layer = next; dist++;
    }
    return -1;
  }
  function jugsMake(rnd) {
    for (let tries = 0; tries < 300; tries++) {
      const big = int(rnd, 8, 13), mid = int(rnd, 4, big - 3), small = int(rnd, 2, mid - 1);
      if (mid === small) continue;
      const caps = [big, mid, small], vols = [big, 0, 0], goods = [];
      for (let t = 1; t < big; t++) {
        if (caps.includes(t)) continue;
        const m = jugsMinMoves(caps, vols, t);
        if (m >= 4 && m <= 7) goods.push(t);
      }
      if (goods.length) return { caps, vols: vols.slice(), start: vols.slice(), target: pick(rnd, goods), from: null, moves: 0 };
    }
    return { caps: [8, 5, 3], vols: [8, 0, 0], start: [8, 0, 0], target: 4, from: null, moves: 0 };
  }
  function jugsSolved(s) { return s.vols.includes(s.target); }

  // ---- 11. Picross (5x5 nonogram) ---------------------------------------
  // The numbers beside a row or above a column give the lengths of its runs of filled squares,
  // in order. Any picture that satisfies every clue counts.
  const PIC_N = 5;
  function picRuns(line) {
    const out = []; let run = 0;
    line.forEach(v => { if (v) run++; else if (run) { out.push(run); run = 0; } });
    if (run) out.push(run);
    return out.length ? out : [0];
  }
  function picLine(cells, kind, k) {
    return Array.from({ length: PIC_N }, (_, j) => cells[kind === 'row' ? k * PIC_N + j : j * PIC_N + k]);
  }
  function picClues(cells) {
    return {
      rows: Array.from({ length: PIC_N }, (_, k) => picRuns(picLine(cells, 'row', k))),
      cols: Array.from({ length: PIC_N }, (_, k) => picRuns(picLine(cells, 'col', k)))
    };
  }
  function picSolved(s) {
    const now = picClues(s.cells);
    return JSON.stringify(now.rows) === JSON.stringify(s.rows) && JSON.stringify(now.cols) === JSON.stringify(s.cols);
  }
  function picMake(rnd) {
    for (let tries = 0; tries < 300; tries++) {
      const picture = Array.from({ length: PIC_N * PIC_N }, () => rnd() < .55);
      const filled = picture.filter(Boolean).length;
      if (filled < 11 || filled > 17) continue;
      const cl = picClues(picture);
      if (cl.rows.some(r => r[0] === 0) || cl.cols.some(c => c[0] === 0)) continue;   // no empty line
      return { rows: cl.rows, cols: cl.cols, cells: Array(PIC_N * PIC_N).fill(false), picture };
    }
    const picture = [1,1,0,0,1, 0,1,1,1,0, 1,0,1,0,1, 0,1,1,0,1, 1,1,0,1,1].map(Boolean);
    const cl = picClues(picture);
    return { rows: cl.rows, cols: cl.cols, cells: Array(PIC_N * PIC_N).fill(false), picture };
  }

  // ---- 12. Truth & Lies (knights and knaves) ----------------------------
  // Four people, each always tells the truth or always lies. Each says one thing about someone.
  // Work out who is who. Only one assignment fits what everybody said.
  const TL_PEOPLE = 4, TL_NAMES = ['A', 'B', 'C', 'D'];
  function tlTrue(st, who, kinds) {
    const other = kinds[st.j];
    if (st.k === 'truthful') return other;
    if (st.k === 'liar') return !other;
    if (st.k === 'same') return other === kinds[who];
    return other !== kinds[who];          // 'diff'
  }
  function tlFits(stmts, kinds) { return stmts.every((st, who) => tlTrue(st, who, kinds) === kinds[who]); }
  function tlAssignments() {
    const out = [];
    for (let m = 0; m < (1 << TL_PEOPLE); m++) out.push(Array.from({ length: TL_PEOPLE }, (_, i) => !!(m & (1 << i))));
    return out;
  }
  function tlSolutions(stmts) { return tlAssignments().filter(k => tlFits(stmts, k)); }
  function tlText(st) {
    const o = TL_NAMES[st.j];
    return st.k === 'truthful' ? o + ' always tells the truth.' : st.k === 'liar' ? o + ' always lies.'
      : st.k === 'same' ? o + ' and I are the same kind.' : o + ' and I are different kinds.';
  }
  const TL_FALLBACK = [{ k: 'liar', j: 1 }, { k: 'same', j: 2 }, { k: 'diff', j: 3 }, { k: 'truthful', j: 0 }];
  function tlMake(rnd) {
    for (let tries = 0; tries < 3000; tries++) {
      const stmts = Array.from({ length: TL_PEOPLE }, (_, who) => {
        let j = int(rnd, 0, TL_PEOPLE - 1); if (j === who) j = (j + 1) % TL_PEOPLE;
        return { k: pick(rnd, ['truthful', 'liar', 'same', 'diff']), j };
      });
      if (tlSolutions(stmts).length === 1) return { stmts, guess: Array(TL_PEOPLE).fill(null) };
    }
    return { stmts: TL_FALLBACK.map(s => Object.assign({}, s)), guess: Array(TL_PEOPLE).fill(null) };
  }
  function tlSolved(s) { return s.guess.every(v => v !== null) && tlFits(s.stmts, s.guess); }

  // ---- Rendering --------------------------------------------------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function btn(cls, text, onClick, label, disabled) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    if (disabled) b.disabled = true;
    else b.addEventListener('click', onClick);
    return b;
  }
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  function renderTiming(host, s, change, done) {
    host.textContent = '';
    s.lamps.forEach((l, i) => {
      const row = el('div', 'pz-row');
      row.appendChild(el('span', 'pz-lamp' + (lampLit(l, s.tick) ? ' lit' : ''), ''));
      row.appendChild(el('span', 'pz-rule', 'Lamp ' + (i + 1) + ': lit ' + l.on + ', dark ' + l.off + ', already ' + plural(l.start, 'tick') + ' into its cycle at tick 0'));
      host.appendChild(row);
    });
    const step = el('div', 'pz-step');
    step.appendChild(btn('pz-btn', '−', () => { if (s.tick > 0) { s.tick--; s.msg = ''; change(); } }, 'Previous tick', done));
    step.appendChild(el('span', 'pz-tick', 'Tick ' + s.tick));
    step.appendChild(btn('pz-btn', '+', () => { if (s.tick < TIMING_MAX) { s.tick++; s.msg = ''; change(); } }, 'Next tick', done));
    step.appendChild(btn('pz-btn pz-go', 'Set tick', () => { timingCommit(s); change(); }, 'Set this tick as the answer', done));
    host.appendChild(step);
    host.appendChild(el('div', 'pz-note', s.msg));
  }

  const GRID_GLYPH = ['', '●', '▲', '■', '◆'], GRID_NAME = ['empty', 'circle', 'triangle', 'square', 'diamond'];
  function renderGrid(host, s, change, done) {
    host.textContent = '';
    const bad = latinConflicts(s.cells), board = el('div', 'pz-board pz-grid4');
    s.cells.forEach((v, i) => {
      const given = s.given[i];
      const b = btn('pz-cell' + (v ? ' g' + v : '') + (given ? ' pz-given' : '') + (bad.has(i) ? ' pz-bad' : ''), GRID_GLYPH[v],
        () => { s.cells[i] = (s.cells[i] + 1) % (LATIN_N + 1); change(); },
        'Row ' + (Math.floor(i / LATIN_N) + 1) + ', column ' + (i % LATIN_N + 1) + ': ' + GRID_NAME[v], given || done);
      board.appendChild(b);
    });
    host.appendChild(board);
  }

  const MIRROR_GLYPH = { '/': '╱', '\\': '╲' };
  function renderLight(host, s, change, done) {
    host.textContent = '';
    const N = LIGHT_N, trace = lightTrace(s), lit = new Set(trace.lit), board = el('div', 'pz-board pz-light');
    for (let r = 0; r < N; r++) {
      board.appendChild(el('span', 'pz-src', r === s.row ? '✦' : ''));
      for (let c = 0; c < N; c++) {
        const i = r * N + c, isTarget = i === s.target, m = s.mirrors[i];
        const text = s.walls[i] ? '▮' : isTarget ? '◎' : (MIRROR_GLYPH[m] || '');
        const label = 'Row ' + (r + 1) + ', column ' + (c + 1) + ': ' + (s.walls[i] ? 'wall' : isTarget ? 'target' : m === '/' ? 'mirror /' : m === '\\' ? 'mirror \\' : 'empty');
        board.appendChild(btn('pz-cell' + (lit.has(i) ? ' pz-lit' : '') + (s.walls[i] ? ' pz-wall' : '') + (isTarget ? ' pz-target' : ''), text, () => {
          const next = m === '' ? '/' : m === '/' ? '\\' : '';
          if (next && !m && lightCount(s) >= s.max) { s.msg = 'No mirrors left: remove one first.'; change(); return; }
          s.mirrors[i] = next; s.msg = ''; change();
        }, label, s.walls[i] || isTarget || done));
      }
    }
    host.appendChild(board);
    host.appendChild(el('div', 'pz-note', s.msg));
  }

  function renderMath(host, s, change, done) {
    host.textContent = '';
    const board = el('div', 'pz-board pz-nums');
    s.nums.forEach((n, i) => {
      const on = s.picked.includes(i);
      board.appendChild(btn('pz-cell pz-num' + (on ? ' pz-on' : ''), String(n), () => {
        if (on) s.picked = s.picked.filter(j => j !== i);
        else if (s.picked.length < s.k) s.picked = s.picked.concat(i);
        change();
      }, 'Number ' + n + (on ? ', picked' : ''), done));
    });
    host.appendChild(board);
    host.appendChild(el('div', 'pz-note', 'Target ' + s.target + '  ·  sum ' + mathSum(s) + '  ·  ' + s.picked.length + '/' + s.k + ' picked'));
  }

  function renderSequence(host, s, change, done) {
    host.textContent = '';
    const vals = seqValues(s), chain = el('div', 'pz-chain');
    chain.appendChild(el('span', 'pz-val', String(s.start)));
    s.slots.forEach((op, i) => {
      chain.appendChild(btn('pz-slot' + (op ? ' pz-on' : ''), op || '＿', () => { s.slots[i] = null; change(); },
        op ? 'Slot ' + (i + 1) + ': ' + op + ', tap to clear' : 'Slot ' + (i + 1) + ': empty', !op || done));
      chain.appendChild(el('span', 'pz-val' + (vals[i + 1] === undefined ? ' pz-dim' : ''), vals[i + 1] === undefined ? '?' : String(vals[i + 1])));
    });
    host.appendChild(chain);
    host.appendChild(el('div', 'pz-note', 'Start ' + s.start + '  →  target ' + s.target));
    const palette = el('div', 'pz-palette');
    s.palette.forEach(op => palette.appendChild(btn('pz-cell pz-op', op, () => {
      const at = s.slots.indexOf(null); if (at >= 0) { s.slots[at] = op; change(); }
    }, 'Add ' + op, done)));
    host.appendChild(palette);
    host.appendChild(btn('pz-btn', 'Clear all', () => { s.slots = Array(SEQ_SLOTS).fill(null); change(); }, 'Clear all slots', done));
  }

  const MM_LETTER = ['', 'A', 'B', 'C', 'D', 'E'];
  function renderMastermind(host, s, change, done) {
    host.textContent = '';
    const list = el('div', 'pz-history');
    s.history.forEach(h => {
      const row = el('div', 'pz-row');
      h.guess.forEach(v => row.appendChild(el('span', 'pz-peg p' + v, MM_LETTER[v])));
      row.appendChild(el('span', 'pz-fb', '●' + h.exact + '  ○' + h.misplaced));
      list.appendChild(row);
    });
    host.appendChild(list);
    if (s.failed) {
      host.appendChild(el('div', 'pz-note', 'Out of guesses. The code was ' + s.secret.map(v => MM_LETTER[v]).join(' ') + '.'));
      host.appendChild(btn('pz-btn pz-go', 'New code', () => { Object.assign(s, mmMake(Math.random)); change(); }, 'Start again with a new code', done));
      return;
    }
    const cur = el('div', 'pz-row');
    s.guess.forEach((v, i) => cur.appendChild(btn('pz-peg pz-pick' + (v ? ' p' + v : ''), MM_LETTER[v] || '·',
      () => { s.guess[i] = (s.guess[i] + 1) % (MM_COLOURS + 1); change(); }, 'Peg ' + (i + 1) + ': ' + (MM_LETTER[v] || 'empty') + ', tap to change', done)));
    cur.appendChild(btn('pz-btn pz-go', 'Guess', () => { mmSubmit(s); change(); }, 'Submit guess', done || s.guess.some(v => !v)));
    host.appendChild(cur);
    host.appendChild(el('div', 'pz-note', '● right colour, right place  ·  ○ right colour, wrong place'));
  }

  function renderLights(host, s, change, done) {
    host.textContent = '';
    const board = el('div', 'pz-board pz-grid4');
    s.cells.forEach((on, i) => board.appendChild(btn('pz-cell pz-bulb' + (on ? ' pz-on pz-glow' : ''), on ? '●' : '',
      () => { loPress(s, i); s.moves++; change(); },
      'Row ' + (Math.floor(i / LO_N) + 1) + ', column ' + (i % LO_N + 1) + ': ' + (on ? 'lit' : 'dark'), done)));
    host.appendChild(board);
    host.appendChild(el('div', 'pz-note', s.moves + ' taps'));
  }

  function renderHanoi(host, s, change, done) {
    host.textContent = '';
    const row = el('div', 'pz-pegs');
    for (let p = 0; p < 3; p++) {
      const col = btn('pz-peg-col' + (s.from === p ? ' pz-on' : '') + (p === s.target ? ' pz-target' : ''), '', () => {
        s.msg = '';
        if (s.from === null) { if (s.pegs[p].length) s.from = p; }
        else if (s.from === p) s.from = null;
        else { if (!hanoiMove(s, s.from, p)) s.msg = 'A bigger disc cannot go on a smaller one.'; s.from = null; }
        change();
      }, 'Peg ' + (p + 1) + (p === s.target ? ' (goal)' : '') + ': ' + (s.pegs[p].length ? 'top disc ' + s.pegs[p][s.pegs[p].length - 1] : 'empty'), done);
      for (let k = s.pegs[p].length - 1; k >= 0; k--) {
        const d = el('span', 'pz-disc d' + s.pegs[p][k]);
        d.style.width = (22 + s.pegs[p][k] * 17) + '%';
        col.appendChild(d);
      }
      col.appendChild(el('span', 'pz-peg-base', p === s.target ? '★' : ''));
      row.appendChild(col);
    }
    host.appendChild(row);
    host.appendChild(el('div', 'pz-note', s.msg || (s.moves + ' moves')));
  }

  function renderSlide(host, s, change, done) {
    host.textContent = '';
    const board = el('div', 'pz-board pz-slide');
    s.tiles.forEach((v, i) => {
      const b = btn('pz-cell' + (v ? ' pz-tile' : ' pz-blank'), v ? String(v) : '', () => { slideMove(s, i); change(); },
        v ? 'Tile ' + v : 'Blank', done || !v);
      board.appendChild(b);
    });
    host.appendChild(board);
    host.appendChild(el('div', 'pz-note', s.moves + ' slides'));
  }

  function renderJugs(host, s, change, done) {
    host.textContent = '';
    const row = el('div', 'pz-jugs');
    s.caps.forEach((cap, i) => {
      const jug = btn('pz-jug' + (s.from === i ? ' pz-on' : ''), '', () => {
        if (s.from === null) { if (s.vols[i] > 0) s.from = i; }
        else if (s.from === i) s.from = null;
        else { const next = jugsPourState(s.vols, s.caps, s.from, i); if (next) { s.vols = next; s.moves++; } s.from = null; }
        change();
      }, 'Jug ' + (i + 1) + ': ' + s.vols[i] + ' of ' + cap, done);
      jug.style.height = (44 + cap * 11) + 'px';
      const fill = el('span', 'pz-fill'); fill.style.height = (s.vols[i] / cap * 100) + '%';
      jug.appendChild(fill);
      jug.appendChild(el('span', 'pz-jug-n', s.vols[i] + '/' + cap));
      row.appendChild(jug);
    });
    host.appendChild(row);
    host.appendChild(el('div', 'pz-note', 'Get exactly ' + s.target + ' into one jug  ·  ' + s.moves + ' pours'));
    host.appendChild(btn('pz-btn', 'Start over', () => { s.vols = s.start.slice(); s.from = null; s.moves = 0; change(); }, 'Start this puzzle over', done));
  }

  function renderPicross(host, s, change, done) {
    host.textContent = '';
    const N = PIC_N, board = el('div', 'pz-board pz-pic');
    board.appendChild(el('span', 'pz-clue', ''));
    s.cols.forEach(c => board.appendChild(el('span', 'pz-clue pz-clue-col', c.join('\n'))));
    for (let r = 0; r < N; r++) {
      board.appendChild(el('span', 'pz-clue pz-clue-row', s.rows[r].join(' ')));
      for (let c = 0; c < N; c++) {
        const i = r * N + c, on = s.cells[i];
        board.appendChild(btn('pz-cell pz-pixel' + (on ? ' pz-on pz-fillcell' : ''), '', () => { s.cells[i] = !s.cells[i]; change(); },
          'Row ' + (r + 1) + ', column ' + (c + 1) + ': ' + (on ? 'filled' : 'empty'), done));
      }
    }
    host.appendChild(board);
  }

  function renderTruth(host, s, change, done) {
    host.textContent = '';
    s.stmts.forEach((st, i) => {
      const row = el('div', 'pz-row pz-say');
      row.appendChild(el('span', 'pz-who', TL_NAMES[i]));
      row.appendChild(el('span', 'pz-rule', '“' + tlText(st) + '”'));
      const v = s.guess[i];
      row.appendChild(btn('pz-btn pz-kind' + (v === null ? '' : v ? ' pz-on' : ' pz-bad'), v === null ? '?' : v ? 'Truth' : 'Liar',
        () => { s.guess[i] = s.guess[i] === null ? true : s.guess[i] ? false : null; change(); },
        TL_NAMES[i] + ': ' + (v === null ? 'undecided' : v ? 'tells the truth' : 'lies') + ', tap to change', done));
      host.appendChild(row);
    });
    host.appendChild(el('div', 'pz-note', 'Mark each person as Truth or Liar.'));
  }

  // ---- Registry ---------------------------------------------------------
  const PUZZLES = [
    { id: 'timing', name: 'Logic & Timing', rule: 'Find a tick when every lamp is lit at the same time.',
      make: timingMake, solved: s => s.done, status: s => 'Tick ' + s.tick, render: renderTiming },
    { id: 'grid', name: 'Grid Match', rule: 'Fill the grid: each symbol once in every row and column.',
      make: gridMake, solved: s => latinValid(s.cells), status: s => s.cells.filter(Boolean).length + '/16 filled', render: renderGrid },
    { id: 'light', name: 'Spatial Light Routing', rule: 'Place mirrors so the beam from ✦ reaches ◎. Tap a square to turn it ╱, ╲, or clear.',
      make: lightMake, solved: lightSolved, status: s => 'Mirrors ' + lightCount(s) + '/' + s.max, render: renderLight },
    { id: 'math', name: 'Math & Combinatorics', rule: 'Pick exactly the right amount of numbers that add up to the target.',
      make: mathMake, solved: mathSolved, status: s => s.picked.length + '/' + s.k + ' picked', render: renderMath },
    { id: 'sequence', name: 'Sequence Programming', rule: 'Fill every slot with an instruction so the machine ends on the target.',
      make: seqMake, solved: seqSolved, status: s => s.slots.filter(Boolean).length + '/' + SEQ_SLOTS + ' slots', render: renderSequence },
    { id: 'mastermind', name: 'Mastermind Variant', rule: 'Crack the 4-colour code. Five colours, no colour used twice in the code.',
      make: mmMake, solved: s => s.won, status: s => s.history.length + '/' + MM_TRIES + ' guesses', render: renderMastermind },
    { id: 'lightsout', name: 'Lights Out', rule: 'Tapping a lamp flips it and its neighbours (up, down, left, right). Switch every lamp off.',
      make: loMake, solved: s => loLit(s) === 0, status: s => loLit(s) + ' lit', render: renderLights },
    { id: 'hanoi', name: 'Tower Shift', rule: 'Move one disc at a time, never a bigger one onto a smaller one, until all four sit on the ★ peg.',
      make: hanoiMake, solved: s => s.pegs[s.target].length === HANOI_DISCS, status: s => s.moves + ' moves', render: renderHanoi },
    { id: 'slide', name: 'Slide Tiles', rule: 'Slide the tiles into order 1 to 8 with the blank in the last corner.',
      make: slideMake, solved: slideSolved, status: s => s.moves + ' slides', render: renderSlide },
    { id: 'jugs', name: 'Pour Puzzle', rule: 'Pour water between the jugs until one holds exactly the target amount.',
      make: jugsMake, solved: jugsSolved, status: s => s.moves + ' pours', render: renderJugs },
    { id: 'picross', name: 'Picross', rule: 'Numbers give the lengths of the filled runs in each row and column. Fill the picture to match.',
      make: picMake, solved: picSolved, status: s => s.cells.filter(Boolean).length + ' filled', render: renderPicross },
    { id: 'truth', name: 'Truth & Lies', rule: 'Each person always tells the truth or always lies. Work out who is which.',
      make: tlMake, solved: tlSolved, status: s => s.guess.filter(v => v !== null).length + '/' + TL_PEOPLE + ' marked', render: renderTruth }
  ];
  const byId = id => PUZZLES.find(p => p.id === id) || null;
  // A random puzzle type, never the one just shown.
  function pickType(rand, avoid) {
    const rnd = rand || Math.random, pool = PUZZLES.filter(p => p.id !== avoid);
    return pick(rnd, pool).id;
  }

  const api = {
    PUZZLES, get: byId, pickType,
    make: (id, rand) => byId(id).make(rand || Math.random),
    // pure helpers, exported for the tests
    lampLit, timingAllLit, timingSolutions, timingCommit, TIMING_MAX, TIMING_FALLBACK,
    latinConflicts, latinValid, LATIN_N,
    lightTrace, lightCount, lightSolved, reflect, LIGHT_N,
    mathWays, mathSum, mathSolved,
    seqApply, seqRun, seqSolved, seqWays, SEQ_SLOTS,
    mmScore, mmMake, mmSubmit, MM_TRIES, MM_LEN,
    loPress, loLit, LO_N, hanoiCanMove, hanoiMove, HANOI_DISCS, slideMove, slideSolved, slideNeighbours, SLIDE_DONE,
    jugsPourState, jugsMinMoves, jugsSolved, picClues, picSolved, PIC_N, tlFits, tlSolutions, tlSolved, TL_PEOPLE
  };
  if (typeof window !== 'undefined') window.MoonPuzzles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

/* Moonlit Lock puzzles (loaded before moon-lock.js).
   Two click-only puzzles: no typing, no trivia, no text to read, and nothing that depends on
   telling colours apart. Each generator builds a puzzle that can always be solved, and one that
   is hard enough to be worth solving.

   1. slide  Phase Slide  the 8-puzzle, with the eight moon phases as tiles: put them back in
                          lunar order (new moon first, full moon in the middle), blank last
   2. flip   Moon Flip    pancake sorting: clicking a disc flips it and every disc above it;
                          get the stack back to smallest on top, widest at the bottom
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

  // ---- Moon phases ------------------------------------------------------
  // Phase k = 0..7 runs new, waxing crescent, first quarter, waxing gibbous, full, waning gibbous,
  // last quarter, waning crescent. moonLitPath() is the lit part of a 100x100 moon drawn as one
  // SVG path: the outer rim on the lit side, then back along the day/night line.
  const MOON_PHASES = 8;
  const MOON_NAMES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
    'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  function moonLitPath(k) {
    if (k === 0) return '';
    if (k === 4) return 'M50 10A40 40 0 1 1 50 90A40 40 0 1 1 50 10Z';
    const waxing = k < 4, c = Math.cos(Math.PI * k / 4), rx = Math.round(Math.abs(c) * 4000) / 100;
    const rim = waxing ? 1 : 0;                       // lit side: right while waxing, left while waning
    const bulge = waxing === (c > 0) ? 0 : 1;         // which way the day/night line curves
    const line = rx < 0.5 ? 'L50 10' : 'A' + rx + ' 40 0 0 ' + bulge + ' 50 10';
    return 'M50 10A40 40 0 0 ' + rim + ' 50 90' + line + 'Z';
  }

  // ---- 1. Phase Slide (8-puzzle) ----------------------------------------
  // Tile v (1..8) shows phase v - 1; 0 is the blank. The start is made by sliding tiles around from
  // the finished picture, so it can always be undone, and is kept only if it is far enough away.
  const SLIDE_N = 3;
  const SLIDE_DONE = [1, 2, 3, 4, 5, 6, 7, 8, 0];
  const SLIDE_MIN_DISTANCE = 14;   // total tile distance from home (the most possible is 18)
  function slideNeighbours(i) {
    const N = SLIDE_N, r = Math.floor(i / N), c = i % N, out = [];
    if (r > 0) out.push(i - N);
    if (r < N - 1) out.push(i + N);
    if (c > 0) out.push(i - 1);
    if (c < N - 1) out.push(i + 1);
    return out;
  }
  function slideMove(s, i) {
    const blank = s.tiles.indexOf(0);
    if (!slideNeighbours(blank).includes(i)) return false;
    s.tiles[blank] = s.tiles[i]; s.tiles[i] = 0; s.moves++;
    return true;
  }
  function slideSolved(s) { return s.tiles.every((v, i) => v === SLIDE_DONE[i]); }
  function slideDistance(s) {
    let total = 0;
    s.tiles.forEach((v, i) => {
      if (!v) return;
      const home = v - 1;
      total += Math.abs(Math.floor(i / SLIDE_N) - Math.floor(home / SLIDE_N)) + Math.abs(i % SLIDE_N - home % SLIDE_N);
    });
    return total;
  }
  function slideMake(rnd) {
    let best = null;
    for (let tries = 0; tries < 300; tries++) {
      const s = { tiles: SLIDE_DONE.slice(), moves: 0 };
      let prev = -1;
      for (let k = int(rnd, 70, 110); k > 0; k--) {
        const blank = s.tiles.indexOf(0), n = pick(rnd, slideNeighbours(blank).filter(x => x !== prev));
        prev = blank; slideMove(s, n);
      }
      s.moves = 0;
      if (slideDistance(s) >= SLIDE_MIN_DISTANCE) return s;
      if (!best || slideDistance(s) > slideDistance(best)) best = s;
    }
    return best;
  }

  // ---- 2. Moon Flip (pancake sorting) -----------------------------------
  // A stack of discs, pile[0] on top. Choosing a disc flips it and everything above it, reversing
  // that part of the stack. Goal: smallest on top down to widest at the bottom. The start is chosen
  // from the orders that need at least FLIP_MIN_MOVES flips even when played perfectly (the most
  // any seven discs ever need is eight), so there is no lucky shuffle.
  const FLIP_N = 7;
  const FLIP_MIN_MOVES = 7;
  const flipHome = () => Array.from({ length: FLIP_N }, (_, i) => i + 1);
  function flipApply(s, i) {
    if (i <= 0 || i >= s.pile.length) return false;
    s.pile = s.pile.slice(0, i + 1).reverse().concat(s.pile.slice(i + 1));
    s.moves++;
    return true;
  }
  function flipSolved(s) { return s.pile.every((v, i) => v === i + 1); }
  // Fewest flips from every order of the stack (a flip undoes itself, so one search from the goal
  // covers all 5,040 orders).
  let flipDistances = null;
  function flipDistanceTable() {
    if (flipDistances) return flipDistances;
    const home = flipHome(), dist = new Map([[home.join(''), 0]]);
    let frontier = [home];
    while (frontier.length) {
      const next = [];
      frontier.forEach(pile => {
        const d = dist.get(pile.join(''));
        for (let i = 1; i < FLIP_N; i++) {
          const flipped = pile.slice(0, i + 1).reverse().concat(pile.slice(i + 1)), key = flipped.join('');
          if (!dist.has(key)) { dist.set(key, d + 1); next.push(flipped); }
        }
      });
      frontier = next;
    }
    flipDistances = dist;
    return dist;
  }
  function flipMinMoves(s) { return flipDistanceTable().get(s.pile.join('')); }
  function flipMake(rnd) {
    for (;;) {
      const s = { pile: shuffle(rnd, flipHome()), moves: 0 };
      if (flipMinMoves(s) >= FLIP_MIN_MOVES) return s;
    }
  }

  // ---- Rendering --------------------------------------------------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function btn(cls, onClick, label, disabled) {
    const b = el('button', cls);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    if (disabled) b.disabled = true;
    else b.addEventListener('click', onClick);
    return b;
  }
  function moonSvg(k) {
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'pz-moon');
    svg.setAttribute('aria-hidden', 'true');
    const disc = document.createElementNS(NS, 'circle');
    disc.setAttribute('cx', '50'); disc.setAttribute('cy', '50'); disc.setAttribute('r', '40');
    disc.setAttribute('class', 'pz-moon-dark');
    svg.appendChild(disc);
    if (k !== 0) {
      const lit = document.createElementNS(NS, 'path');
      lit.setAttribute('d', moonLitPath(k)); lit.setAttribute('class', 'pz-moon-lit');
      svg.appendChild(lit);
    }
    return svg;
  }

  function renderSlide(host, s, change, done) {
    host.textContent = '';
    // The finished order, small, so the goal is always in view.
    const goal = el('div', 'pz-goal');
    for (let k = 0; k < MOON_PHASES; k++) goal.appendChild(moonSvg(k));
    host.appendChild(goal);
    const board = el('div', 'pz-board pz-slide');
    s.tiles.forEach((v, i) => {
      const b = btn('pz-cell' + (v ? ' pz-tile' : ' pz-blank'), () => { slideMove(s, i); change(); },
        v ? MOON_NAMES[v - 1] : 'Empty space', done || !v);
      if (v) b.appendChild(moonSvg(v - 1));
      board.appendChild(b);
    });
    host.appendChild(board);
  }

  function renderFlip(host, s, change, done) {
    host.textContent = '';
    const stack = el('div', 'pz-stack');
    s.pile.forEach((v, i) => {
      const b = btn('pz-pan', () => { flipApply(s, i); change(); },
        'Disc ' + (i + 1) + ' from the top: flip it and the ' + i + ' above', done || i === 0);
      const bar = el('span', 'pz-bar');
      bar.style.width = (22 + v * 11) + '%';
      b.appendChild(bar);
      stack.appendChild(b);
    });
    host.appendChild(stack);
  }

  // ---- Registry ---------------------------------------------------------
  const PUZZLES = [
    { id: 'slide', name: 'Phase Slide', rule: 'Slide the moons into the order shown, with the gap in the last corner.',
      make: slideMake, solved: slideSolved, status: s => s.moves + ' slides', render: renderSlide },
    { id: 'flip', name: 'Moon Flip', rule: 'Tap a disc to flip it and all the discs above it. Narrowest on top, widest at the bottom.',
      make: flipMake, solved: flipSolved, status: s => s.moves + ' flips', render: renderFlip }
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
    MOON_PHASES, moonLitPath,
    slideMove, slideSolved, slideNeighbours, slideDistance, SLIDE_DONE, SLIDE_MIN_DISTANCE,
    flipApply, flipSolved, flipMinMoves, FLIP_N, FLIP_MIN_MOVES
  };
  if (typeof window !== 'undefined') window.MoonPuzzles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

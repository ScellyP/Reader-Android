// Run with: node tests/chapter-swipe.test.js
// Swipe up on the chapter switcher (app/src/main/assets/chapter-swipe.js) opens the music player.
const assert = require('assert');
const ChapterSwipe = require('../app/src/main/assets/chapter-swipe.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

// A fake page: records the listeners, and lets a test play a finger across it.
function setup({ canOpen = true, rect = { left: 20, right: 340, top: 500, bottom: 552, width: 320, height: 52 } } = {}) {
  const handlers = {};
  const doc = { addEventListener: (type, fn) => { handlers[type] = fn; } };
  const bar = { getBoundingClientRect: () => rect };
  let opened = 0;
  ChapterSwipe.attach(bar, () => canOpen, () => { opened++; }, doc);
  const touch = (x, y) => ({ clientX: x, clientY: y });
  return {
    opened: () => opened,
    down: (x, y, fingers = 1) => handlers.touchstart({ touches: Array.from({ length: fingers }, () => touch(x, y)) }),
    move: (x, y) => handlers.touchmove({ touches: [touch(x, y)] }),
    up: (x, y) => handlers.touchend({ touches: [], changedTouches: [touch(x, y)] }),
    cancel: () => handlers.touchcancel({}),
    // a whole swipe from (x1, y1) to (x2, y2)
    swipe(x1, y1, x2, y2) { this.down(x1, y1); this.move((x1 + x2) / 2, (y1 + y2) / 2); this.move(x2, y2); this.up(x2, y2); },
  };
}

check('what counts as an upward swipe', () => {
  assert.ok(ChapterSwipe.isSwipeUp(0, -40));
  assert.ok(ChapterSwipe.isSwipeUp(10, -30));
  assert.ok(!ChapterSwipe.isSwipeUp(0, -29));             // too short
  assert.ok(!ChapterSwipe.isSwipeUp(0, 60));              // downwards
  assert.ok(!ChapterSwipe.isSwipeUp(90, -40));            // mostly sideways
  assert.ok(ChapterSwipe.isSwipeUp(30, -60));             // steep diagonal (about 63 degrees)
  assert.ok(!ChapterSwipe.isSwipeUp(60, -40));            // shallow diagonal (about 34 degrees)
});

check('swiping up from the bar opens the player', () => {
  const t = setup();
  t.swipe(180, 525, 182, 440);
  assert.strictEqual(t.opened(), 1);
});

check('a swipe may start a little outside the bar, but not far from it', () => {
  const t = setup();
  t.swipe(180, 566, 180, 480);                            // 14 px below the bar
  assert.strictEqual(t.opened(), 1);
  t.swipe(180, 540 + 40, 180, 480);                       // 28 px below: too far
  t.swipe(180, 470, 180, 400);                            // 30 px above the bar
  t.swipe(5, 525, 5, 440);                                // just left of it (15 px): allowed
  t.swipe(-5, 525, -5, 440);                              // 25 px left: too far
  assert.strictEqual(t.opened(), 2);
});

check('it still opens when the browser takes over the drag and cancels the touch', () => {
  const t = setup();
  t.down(180, 525); t.move(181, 490); t.move(182, 450);
  t.cancel();                                             // no touchend ever arrives
  assert.strictEqual(t.opened(), 1);
});

check('taps, sideways drags and downward drags on the bar do nothing', () => {
  const t = setup();
  t.down(180, 525); t.up(180, 525);                       // a tap on Previous / Next
  t.swipe(100, 525, 260, 520);                            // sideways
  t.swipe(180, 525, 180, 600);                            // downwards
  t.swipe(180, 525, 180, 505);                            // only 20 px up
  assert.strictEqual(t.opened(), 0);
});

check('a swipe that starts elsewhere on the page does nothing', () => {
  const t = setup();
  t.swipe(180, 300, 180, 200);                            // ordinary scrolling of the text
  assert.strictEqual(t.opened(), 0);
});

check('two fingers are ignored', () => {
  const t = setup();
  t.down(180, 525, 2); t.move(180, 450); t.up(180, 450);
  assert.strictEqual(t.opened(), 0);
});

check('it does not open while something else is open, or while the bar is not on screen', () => {
  const busy = setup({ canOpen: false });
  busy.swipe(180, 525, 180, 440);
  assert.strictEqual(busy.opened(), 0);
  const hidden = setup({ rect: { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } });
  hidden.swipe(0, 0, 0, -80);                             // would start "on" a zero-size bar at the corner
  assert.strictEqual(hidden.opened(), 0);
});

check('each touch starts fresh: an earlier swipe does not carry over', () => {
  const t = setup();
  t.swipe(180, 525, 180, 440);
  assert.strictEqual(t.opened(), 1);
  t.up(180, 440);                                         // a stray touchend with no start
  t.cancel();
  assert.strictEqual(t.opened(), 1);
  t.down(180, 525); t.up(180, 525);
  assert.strictEqual(t.opened(), 1);
});

console.log(n + ' checks passed');

/* Swipe up on the chapter switcher (the Previous / Next bar under the chapter text) to open
   the music player (loaded before reader.js, which attaches it).

   Listens on the whole document rather than on the bar, so it still works when the browser takes
   a drag over for scrolling and cancels the touch: the gesture is judged from the last position
   seen. A swipe may start a little outside the bar, because the bar is only about 50 px tall. */
(function (root) {
  'use strict';

  const MIN_DISTANCE_PX = 30;   // how far up the finger must travel
  const MIN_ANGLE_DEG = 50;     // from horizontal: steeper than this counts as "up"
  const REACH_PX = 16;          // how far outside the bar a swipe may start

  function isSwipeUp(dx, dy) {
    return dy <= -MIN_DISTANCE_PX && Math.atan2(-dy, Math.abs(dx)) * 180 / Math.PI >= MIN_ANGLE_DEG;
  }

  // bar: the Previous / Next bar. canOpen(): true while nothing else is open.
  // onSwipeUp(): opens the player.
  function attach(bar, canOpen, onSwipeUp, doc) {
    doc = doc || document;
    let start = null, last = null;
    const pointOf = (touch) => ({ x: touch.clientX, y: touch.clientY });

    function startsOnBar(p) {
      const r = bar.getBoundingClientRect();
      return r.width > 0 && r.height > 0 &&
        p.x >= r.left - REACH_PX && p.x <= r.right + REACH_PX &&
        p.y >= r.top - REACH_PX && p.y <= r.bottom + REACH_PX;
    }

    function finish() {
      const from = start, to = last;
      start = last = null;
      if (from && to && isSwipeUp(to.x - from.x, to.y - from.y) && canOpen()) onSwipeUp();
    }

    doc.addEventListener('touchstart', (e) => {
      start = last = null;
      if (e.touches.length !== 1) return;
      const p = pointOf(e.touches[0]);
      if (startsOnBar(p)) start = last = p;
    }, { passive: true });

    doc.addEventListener('touchmove', (e) => {
      if (start && e.touches.length === 1) last = pointOf(e.touches[0]);
    }, { passive: true });

    doc.addEventListener('touchend', (e) => {
      if (start && e.changedTouches[0]) last = pointOf(e.changedTouches[0]);
      finish();
    }, { passive: true });

    doc.addEventListener('touchcancel', finish, { passive: true });
  }

  const api = { attach, isSwipeUp };
  if (typeof window !== 'undefined') window.ChapterSwipe = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);

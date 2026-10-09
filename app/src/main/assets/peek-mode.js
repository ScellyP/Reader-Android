/* Peek mode: while a slider in a settings panel is being dragged, the rest
   of the panel (and its backdrop) fades out so the reading text underneath
   is fully visible, leaving only the control being dragged. Releasing
   fades everything back. */
(function () {
  'use strict';
  var PANELS = '#theme-panel, #session-settings-panel';
  var activeRow = null;

  function start(e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('input[type="range"]')) return;
    var panel = t.closest(PANELS);
    if (!panel) return;
    var row = t;
    while (row.parentElement && row.parentElement !== panel) row = row.parentElement;
    activeRow = row;
    row.classList.add('peek-keep');
    document.body.classList.add('peek-active');
  }

  function end() {
    if (!activeRow && !document.body.classList.contains('peek-active')) return;
    document.body.classList.remove('peek-active');
    if (activeRow) activeRow.classList.remove('peek-keep');
    activeRow = null;
  }

  document.addEventListener('pointerdown', start, true);
  document.addEventListener('touchstart', start, { capture: true, passive: true });
  ['pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach(function (ev) {
    window.addEventListener(ev, end, true);
  });
  window.addEventListener('blur', end);
})();

/* =========================================================================
   "noaudio" flavor: replaces app/src/main/assets/audio-player.js.
   =========================================================================
   The page still loads this file by name (index.html is shared), but here it only switches the
   music player off: window.NovelAudio is never defined, so every `window.NovelAudio && ...`
   check in reader.js stays false, and the buttons / settings row / library handle that lead to
   the player are hidden. reader.js also looks at window.NO_AUDIO so a swipe up cannot open the
   (empty) panel. spotify-ui.js and song-download.js are empty in this flavor. */
(function () {
  'use strict';
  window.NO_AUDIO = true;
  try {
    var style = document.createElement('style');
    style.id = 'no-audio-css';
    style.textContent =
      '#audio-toggle, #audio-toggle-top, #audio-panel, #novel-picker-player-hint { display: none !important; }';
    document.head.appendChild(style);
    var keys = document.getElementById('audio-volume-keys-toggle');
    var row = keys && keys.closest ? keys.closest('.theme-panel-row') : null;
    if (row) row.style.display = 'none';
  } catch (e) { /* the page still works, the player controls just stay hidden by CSS only */ }
})();

/* =========================================================================
   Spotify-kit UI glue for the music panel.

   audio-player.js owns all playback state and keeps updating its original
   elements (#audio-np-title, #audio-artwork, #audio-play-btn, ...). This file
   only (a) switches between the three views (library / songs / now playing),
   (b) mirrors the player's state into the mini player, album header and "..."
   sheet, and (c) forwards taps on the kit's extra buttons to the original
   buttons. It never touches playback itself, and the panel keeps working if
   this file fails to load (the views just stay on their defaults).
   ========================================================================= */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var panel = $('audio-panel');
  if (!panel) return;

  var VIEWS = ['library', 'album', 'track'];

  var el = {
    views: $('sp-views'), mini: $('sp-mini'), miniArt: $('sp-mini-art'),
    miniTitle: $('sp-mini-title'), miniArtist: $('sp-mini-artist'), miniSub: $('sp-mini-sub'),
    miniFill: $('sp-mini-fill'), miniPlay: $('sp-mini-play'),
    albumCover: $('sp-album-cover'), albumTitle: $('sp-album-title'), albumMeta: $('sp-album-meta'),
    albumPlay: $('sp-album-play'), albumShuffle: $('sp-album-shuffle'),
    context: $('sp-track-context'),
    statPlaylists: $('sp-stat-playlists'), statSongs: $('sp-stat-songs'),
    sheet: $('sp-sheet'), sheetArt: $('sp-sheet-art'), sheetTitle: $('sp-sheet-title'),
    sheetArtist: $('sp-sheet-artist'), likeLabel: $('sp-act-like-label'),
    sleepValue: $('sp-act-sleep-value'), sleepOpts: $('sp-sleep-opts'),
    // original player elements (owned by audio-player.js)
    title: $('audio-np-title'), artist: $('audio-np-artist'), artwork: $('audio-artwork'),
    play: $('audio-play-btn'), seek: $('audio-seek'), like: $('audio-like-btn'), addto: $('audio-addto-btn'),
    shuffle: $('audio-shuffle-btn'), scan: $('audio-scan-btn'), sleep: $('audio-sleep'),
    plLabel: $('audio-playlist-btn-label'), plCount: $('audio-playlist-btn-count'), plList: $('audio-playlist-list')
  };

  /* ---------------- views ---------------- */
  function setView(name) {
    if (VIEWS.indexOf(name) < 0) return;
    panel.setAttribute('data-view', name);
    Array.prototype.forEach.call(document.querySelectorAll('#sp-nav [data-sp-view]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-sp-view') === name);
    });
    if (el.views) el.views.scrollTop = 0;
    closeSheet();
    sync();
  }
  window.SpotifyUI = { setView: setView };

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target : null;
    if (!t || !panel.contains(t)) return;

    var nav = t.closest('[data-sp-view]');
    if (nav) return setView(nav.getAttribute('data-sp-view'));

    if (t.closest('#sp-back-library')) return setView('library');
    if (t.closest('#sp-track-down')) return setView('album');

    // Picking a playlist row (audio-player.js already applied the selection
    // in the row's own handler) opens its song list. The delete button stops
    // propagation, so it never reaches here.
    if (t.closest('#audio-playlist-list li')) return setView('album');

    if (t.closest('#sp-album-play')) { if (el.play) el.play.click(); return; }
    if (t.closest('#sp-album-shuffle')) { if (el.shuffle) el.shuffle.click(); return; }
    if (t.closest('#sp-mini-play')) { e.stopPropagation(); if (el.play) el.play.click(); return; }
    if (t.closest('#sp-mini')) return setView('track');

    if (t.closest('[data-sp-more]')) return openSheet();
    if (t.closest('[data-sp-sheet-close]')) return closeSheet();

    var act = t.closest('[data-sp-act]');
    if (act) return runAction(act.getAttribute('data-sp-act'));

    var sl = t.closest('[data-sp-sleep]');
    if (sl && el.sleep) {
      el.sleep.value = sl.getAttribute('data-sp-sleep');
      el.sleep.dispatchEvent(new Event('change', { bubbles: true }));
      return closeSheet();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.target === el.mini && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setView('track'); }
    if (e.key === 'Escape' && el.sheet && !el.sheet.classList.contains('hidden')) closeSheet();
  });

  /* ---------------- "..." sheet ---------------- */
  function openSheet() { if (el.sheet) { el.sheet.classList.remove('hidden'); sync(); } }
  function closeSheet() {
    if (!el.sheet) return;
    el.sheet.classList.add('hidden');
    if (el.sleepOpts) el.sleepOpts.classList.add('hidden');
  }
  function runAction(name) {
    if (name === 'like') { if (el.like && !el.like.disabled) el.like.click(); closeSheet(); }
    else if (name === 'addto') {
      if (el.addto && !el.addto.disabled) { closeSheet(); setView('track'); el.addto.click(); }
    }
    else if (name === 'sleep') { if (el.sleepOpts) el.sleepOpts.classList.toggle('hidden'); }
    else if (name === 'rescan') { if (el.scan) el.scan.click(); closeSheet(); }
  }

  /* ---------------- theme tint ----------------
     The header gradient colour is no longer sampled from the artwork: it is
     --sp-tint in index.html, mixed from the app's --accent and --bg, so it
     follows the colour switcher. Any value set inline by an older build is
     cleared here. */
  var tintedFor = null;
  function updateTint() {
    if (tintedFor === null) { panel.style.removeProperty('--sp-tint'); tintedFor = ''; }
  }

  /* ---------------- mirror player state ---------------- */
  function cloneArt(target) {
    if (!target || !el.artwork) return;
    var img = el.artwork.querySelector('img');
    if (img) {
      var cur = target.querySelector('img');
      if (!cur || cur.src !== img.src) target.innerHTML = '<img alt="" src="' + img.src + '">';
    } else if (!target.querySelector('svg')) {
      target.innerHTML = '<svg class="ico"><use href="#i-music"/></svg>';
    }
  }
  function playlistTitle() {
    var t = (el.plLabel && el.plLabel.textContent || '').trim();
    return t || 'All songs';
  }
  var raf = 0;
  function sync() {
    raf = 0;
    var title = (el.title && el.title.textContent || '').trim();
    var artist = (el.artist && el.artist.textContent || '').trim();
    var hasTrack = !!(el.seek && !el.seek.disabled);
    var playing = !!(el.play && el.play.classList.contains('is-playing'));
    var pl = playlistTitle();
    var n = (el.plCount && el.plCount.textContent || '').trim();

    panel.classList.toggle('sp-playing', playing);
    if (el.mini) el.mini.classList.toggle('hidden', !hasTrack);
    if (el.miniTitle) el.miniTitle.textContent = hasTrack ? title : '';
    if (el.miniArtist) el.miniArtist.textContent = hasTrack ? artist : '';
    if (el.miniSub) el.miniSub.textContent = pl;
    if (el.albumTitle) el.albumTitle.textContent = pl;
    if (el.albumMeta) el.albumMeta.textContent = (n ? n + (n === '1' ? ' song' : ' songs') : 'No songs');
    if (el.context) el.context.textContent = pl;
    if (el.albumPlay) el.albumPlay.disabled = !!(el.play && el.play.disabled);
    if (el.albumShuffle && el.shuffle) el.albumShuffle.classList.toggle('active', el.shuffle.classList.contains('active'));

    cloneArt(el.miniArt); cloneArt(el.albumCover); cloneArt(el.sheetArt);
    updateTint();

    if (el.plList) {
      var rows = el.plList.querySelectorAll('li');
      var all = el.plList.querySelector('li[data-playlist-name="all"] .pl-count');
      if (el.statPlaylists) el.statPlaylists.textContent = String(rows.length);
      if (el.statSongs) el.statSongs.textContent = all ? all.textContent : '0';
    }

    if (el.sheet && !el.sheet.classList.contains('hidden')) {
      if (el.sheetTitle) el.sheetTitle.textContent = hasTrack ? title : pl;
      if (el.sheetArtist) el.sheetArtist.textContent = hasTrack ? artist : '';
      var liked = !!(el.like && el.like.classList.contains('liked'));
      if (el.likeLabel) el.likeLabel.textContent = liked ? 'Remove from Liked' : 'Like';
      var likeBtn = el.sheet.querySelector('[data-sp-act="like"]'), addBtn = el.sheet.querySelector('[data-sp-act="addto"]');
      if (likeBtn) likeBtn.disabled = !(el.like && !el.like.disabled);
      if (addBtn) addBtn.disabled = !(el.addto && !el.addto.disabled);
      var m = el.sleep ? el.sleep.value : '0';
      if (el.sleepValue) el.sleepValue.textContent = m === '0' ? 'Off' : (m === '-1' ? 'End of track' : m + ' min');
      Array.prototype.forEach.call(el.sheet.querySelectorAll('[data-sp-sleep]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-sp-sleep') === m);
      });
    }
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(sync); }

  function progress() {
    if (document.hidden || !el.seek || !el.miniFill || panel.classList.contains('hidden')) return;
    var max = parseFloat(el.seek.max) || 1, v = parseFloat(el.seek.value) || 0;
    el.miniFill.style.width = Math.max(0, Math.min(100, v / max * 100)) + '%';
  }

  var mo = new MutationObserver(schedule);
  [el.title, el.artist, el.artwork, el.plLabel, el.plCount, el.plList].forEach(function (n) {
    if (n) mo.observe(n, { childList: true, subtree: true, characterData: true });
  });
  [el.play, el.seek, el.like, el.addto, el.shuffle, el.sleep, panel].forEach(function (n) {
    if (n) mo.observe(n, { attributes: true, attributeFilter: ['class', 'disabled', 'value'] });
  });
  setInterval(progress, 400);

  setView('album');
})();

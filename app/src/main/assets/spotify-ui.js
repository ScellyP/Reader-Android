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

  /* ---------------- colours: current song, else the app theme ----------------
     While a track with cover art is loaded, the panel's accent colours
     (--accent, --accent-strong, --accent-ink, --accent-soft, --accent-line) are
     taken from that cover and set on #audio-panel only. index.html derives the
     rest (header gradient, buttons, active states, progress) from those, so the
     whole panel follows. With no track, or a track without art (or a grey
     cover), the inline values are removed and the panel falls straight back to
     the app's own theme variables, live. The accent is nudged to a readable
     lightness for the current theme background. */
  var TINT_VARS = ['--accent', '--accent-strong', '--accent-ink', '--accent-soft', '--accent-line', '--sp-tint'];
  var tintKey = null, tintRgb = null;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lum(r, g, b) {
    function f(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0, d = mx - mn;
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    function hue(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [Math.round(hue(p, q, h + 1 / 3) * 255), Math.round(hue(p, q, h) * 255), Math.round(hue(p, q, h - 1 / 3) * 255)];
  }

  /* Weighted average of a tiny copy of the cover, favouring saturated,
     mid-brightness pixels so the result is a colour rather than mud. Returns
     null for (near) greyscale covers. */
  function dominantRgb(img) {
    var N = 32, c = document.createElement('canvas');
    c.width = N; c.height = N;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    var d = ctx.getImageData(0, 0, N, N).data, R = 0, G = 0, B = 0, W = 0;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      var hsl = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      var w = hsl[1] * hsl[1] * (1 - Math.abs(hsl[2] - 0.5) * 1.6);
      if (w <= 0) continue;
      R += d[i] * w; G += d[i + 1] * w; B += d[i + 2] * w; W += w;
    }
    if (W < 0.5) return null; // greyscale / nearly colourless cover
    return [R / W, G / W, B / W];
  }

  function themeBgIsDark() {
    var m = (getComputedStyle(panel).backgroundColor || '').match(/[\d.]+/g);
    if (!m || m.length < 3) return true;
    return lum(+m[0], +m[1], +m[2]) < 0.4;
  }

  function clearTint() {
    TINT_VARS.forEach(function (v) { panel.style.removeProperty(v); });
  }
  function applyTint(rgb) {
    var hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]), dark = themeBgIsDark();
    var s = clamp(hsl[1], 0.45, 0.9);
    var l = dark ? clamp(hsl[2], 0.55, 0.7) : clamp(hsl[2], 0.3, 0.45);
    var base = hslToRgb(hsl[0], s, l);
    var strong = hslToRgb(hsl[0], s, clamp(l + (dark ? 0.08 : -0.08), 0.1, 0.9));
    var ink = lum(base[0], base[1], base[2]) > 0.4 ? '#111111' : '#ffffff';
    function css(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
    function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
    var st = panel.style;
    st.removeProperty('--sp-tint'); // keep index.html's own mix of accent + bg
    st.setProperty('--accent', css(base));
    st.setProperty('--accent-strong', css(strong));
    st.setProperty('--accent-ink', ink);
    st.setProperty('--accent-soft', rgba(base, 0.13));
    st.setProperty('--accent-line', rgba(base, 0.42));
  }

  function updateTint() {
    var hasTrack = !!(el.seek && !el.seek.disabled);
    var img = hasTrack && el.artwork ? el.artwork.querySelector('img') : null;
    if (!img) {
      if (tintKey !== '') { clearTint(); tintKey = ''; tintRgb = null; }
      return;
    }
    var src = img.src;
    if (src === tintKey) return;
    tintKey = src;
    var probe = new Image();
    probe.onload = function () {
      if (tintKey !== src) return; // track changed while decoding
      var rgb = null;
      try { rgb = dominantRgb(probe); } catch (e) { rgb = null; }
      tintRgb = rgb;
      if (rgb) applyTint(rgb); else clearTint();
    };
    probe.onerror = function () { if (tintKey === src) { tintRgb = null; clearTint(); } };
    probe.src = src;
  }
  // Theme switched (preset / colour pickers): re-fit the song colour to the new background.
  try {
    new MutationObserver(function () { if (tintRgb) applyTint(tintRgb); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
  } catch (e) { /* tint just won't re-fit live */ }

  /* ---------------- playlist covers ----------------
     Each playlist row's thumbnail is a 2x2 mosaic of the cover art of its
     first four songs in alphabetical order (by title; songs without art are
     skipped, a playlist with fewer than four covers repeats them, one cover
     fills the whole tile). Playlists whose songs have no art at all keep the
     theme-coloured mosaic from index.html. Mosaics are drawn once on a small
     canvas and cached by the list of songs they were made from. Nothing is
     added to the list's DOM (only a CSS variable + attribute on each row), so
     the list observer below is not re-triggered. */
  var COVER_PX = 112, COVER_SCAN = 12;
  var coverCache = {};      // "id|id|id|id" -> data: URL ('' = could not be made)
  var artMemo = {};         // track path -> art data: URL ('' = none)
  var coverBusy = false, coverAgain = false, coverTimer = 0, coverSig = null;

  function playlistTracks(name) {
    var A = window.NovelAudio;
    if (!A || !A._state || !A._state.tracks) return [];
    var all = A._state.tracks, ids = null;
    if (name === 'all') return all.slice();
    if (name.charAt(0) === '@' && A.features && A.features.selectionFor) ids = A.features.selectionFor(name);
    if (ids) {
      var byId = {}; all.forEach(function (t) { byId[t.id] = t; });
      return ids.map(function (id) { return byId[id]; }).filter(Boolean);
    }
    return all.filter(function (t) { return t.playlist === name; });
  }
  function firstFourWithArt(name) {
    var b = window.AndroidBridge;
    if (!b || !b.getArtwork) return [];
    var list = playlistTracks(name).sort(function (a, c) {
      return String(a.title || '').localeCompare(String(c.title || ''), undefined, { sensitivity: 'base', numeric: true });
    });
    var out = [];
    for (var i = 0; i < list.length && i < COVER_SCAN && out.length < 4; i++) {
      var uri = artMemo[list[i].path];
      if (uri === undefined) {
        try { uri = b.getArtwork(list[i].path) || ''; } catch (e) { uri = ''; }
        artMemo[list[i].path] = uri;
      }
      if (uri) out.push({ id: list[i].id, uri: uri });
    }
    return out;
  }
  function loadImg(uri) {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { res(null); };
      im.src = uri;
    });
  }
  function drawCover(im, ctx, x, y, w, h) {  // object-fit: cover
    var r = Math.max(w / im.naturalWidth, h / im.naturalHeight), dw = im.naturalWidth * r, dh = im.naturalHeight * r;
    ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  function makeMosaic(items) {
    return Promise.all(items.map(function (it) { return loadImg(it.uri); })).then(function (imgs) {
      imgs = imgs.filter(Boolean);
      if (!imgs.length) return '';
      var c = document.createElement('canvas'); c.width = COVER_PX; c.height = COVER_PX;
      var ctx = c.getContext('2d'), h = COVER_PX / 2;
      if (imgs.length === 1) drawCover(imgs[0], ctx, 0, 0, COVER_PX, COVER_PX);
      else {
        for (var i = 0; i < 4; i++) drawCover(imgs[i % imgs.length], ctx, (i % 2) * h, Math.floor(i / 2) * h, h, h);
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.fillRect(h - 0.5, 0, 1, COVER_PX); ctx.fillRect(0, h - 0.5, COVER_PX, 1);
      }
      return c.toDataURL('image/jpeg', 0.85);
    });
  }
  function setRowCover(li, url) {
    if (url) { li.style.setProperty('--sp-cover', 'url("' + url + '")'); li.setAttribute('data-sp-cover', '1'); }
    else { li.style.removeProperty('--sp-cover'); li.removeAttribute('data-sp-cover'); }
  }
  function coverPass() {
    if (coverBusy) { coverAgain = true; return; }
    if (!el.plList) return;
    coverBusy = true; coverAgain = false;
    var rows = Array.prototype.slice.call(el.plList.querySelectorAll('li[data-playlist-name]'));
    var i = 0;
    (function next() {
      if (i >= rows.length) { coverBusy = false; if (coverAgain) scheduleCovers(); return; }
      var li = rows[i++];
      if (!li.isConnected) { setTimeout(next, 0); return; }
      var items = firstFourWithArt(li.getAttribute('data-playlist-name'));
      var key = items.map(function (it) { return it.id; }).join('|');
      if (!key) { setRowCover(li, ''); setTimeout(next, 0); return; }
      if (coverCache[key] !== undefined) { setRowCover(li, coverCache[key]); setTimeout(next, 0); return; }
      makeMosaic(items).then(function (url) {
        coverCache[key] = url;
        if (li.isConnected) setRowCover(li, url);
        setTimeout(next, 16);   // one playlist per tick keeps the UI smooth
      }, function () { coverCache[key] = ''; setTimeout(next, 16); });
    })();
  }
  function scheduleCovers() {
    // Only redo the work when the library or the rows' contents changed.
    var A = window.NovelAudio, sig = (A && A._state && A._state.tracks ? A._state.tracks.length : 0) + '#';
    if (el.plList) Array.prototype.forEach.call(el.plList.querySelectorAll('li[data-playlist-name]'), function (li) {
      var c = li.querySelector('.pl-count');
      sig += li.getAttribute('data-playlist-name') + ':' + (c ? c.textContent : '') + ';';
    });
    if (sig === coverSig && !coverAgain) return;
    coverSig = sig;
    clearTimeout(coverTimer);
    coverTimer = setTimeout(coverPass, 150);
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
    scheduleCovers();

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

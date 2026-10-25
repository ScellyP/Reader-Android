/* =========================================================================
   Spotify-kit UI glue for the music panel
   -------------------------------------------------------------------------
   audio-player.js owns ALL playback state and keeps updating its original
   elements (#audio-np-title, #audio-artwork, #audio-play-btn, ...).

   This file only:
     1. switches between the three views (library / album / track),
     2. mirrors the player's state into the mini player, album header and
        the "..." sheet,
     3. forwards taps on the kit's extra buttons to the original buttons,
     4. tints the panel from the current cover art,
     5. builds 2x2 cover mosaics for the playlist rows.

   It never touches playback itself, and the panel keeps working if this
   file fails to load (the views just stay on their defaults).
   ========================================================================= */
(function () {
  'use strict';

  /* =======================================================================
     Home screen model: pure functions, tested in tests/spotify-home.test.js
     ======================================================================= */

  const QUICK_TILE_COUNT = 6;
  // The player's built-in lists get their own shelf; everything else (folders, your own playlists) is "Constellations".
  const MADE_FOR_YOU = ['all', '@recent', '@liked'];
  const MADE_FOR_YOU_NOTES = { all: 'Your whole sky', '@recent': 'What you played lately', '@liked': 'Songs you hearted' };

  function greetingForHour(hour) {
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 18) return 'Good afternoon';
    if (hour >= 18 && hour < 22) return 'Good evening';
    return 'Good night';
  }

  // rows: [{ name, title, count }] in the order the player lists them.
  function planHome(rows) {
    return {
      tiles: rows.slice(0, QUICK_TILE_COUNT),
      made: MADE_FOR_YOU.map((name) => rows.find((row) => row.name === name)).filter(Boolean),
      lists: rows.filter((row) => MADE_FOR_YOU.indexOf(row.name) === -1),
    };
  }

  // The small line under a card's name.
  function captionFor(row) {
    if (MADE_FOR_YOU_NOTES[row.name]) return MADE_FOR_YOU_NOTES[row.name];
    const songs = parseInt(row.count, 10);
    if (!songs) return 'No songs yet';
    return songs + (songs === 1 ? ' song' : ' songs');
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { greetingForHour, planHome, captionFor };

  const $ = (id) => document.getElementById(id);

  const panel = $('audio-panel');
  if (!panel) return;

  /* =======================================================================
     Constants & element references
     ======================================================================= */

  const VIEWS = ['library', 'album', 'track', 'download'];   // the order of the bottom bar, and of swiping
  const ENTER_ANIMATION_MS = 900;
  const PROGRESS_INTERVAL_MS = 400;

  // Elements created by this kit (sp-*) and the player's own elements (audio-*).
  const el = {
    // kit: layout
    views: $('sp-views'),
    sheet: $('sp-sheet'),
    sleepOptions: $('sp-sleep-opts'),

    // kit: mini player
    mini: $('sp-mini'),
    miniArt: $('sp-mini-art'),
    miniTitle: $('sp-mini-title'),
    miniArtist: $('sp-mini-artist'),
    miniSub: $('sp-mini-sub'),
    miniFill: $('sp-mini-fill'),

    // kit: album header
    albumCover: $('sp-album-cover'),
    albumTitle: $('sp-album-title'),
    albumMeta: $('sp-album-meta'),
    albumPlay: $('sp-album-play'),
    albumShuffle: $('sp-album-shuffle'),

    // kit: track view / library stats
    trackContext: $('sp-track-context'),
    statPlaylists: $('sp-stat-playlists'),
    statSongs: $('sp-stat-songs'),

    // kit: "..." sheet
    sheetArt: $('sp-sheet-art'),
    sheetTitle: $('sp-sheet-title'),
    sheetArtist: $('sp-sheet-artist'),
    likeLabel: $('sp-act-like-label'),
    sleepValue: $('sp-act-sleep-value'),

    // original player elements (owned by audio-player.js)
    title: $('audio-np-title'),
    artist: $('audio-np-artist'),
    artwork: $('audio-artwork'),
    play: $('audio-play-btn'),
    seek: $('audio-seek'),
    like: $('audio-like-btn'),
    addTo: $('audio-addto-btn'),
    shuffle: $('audio-shuffle-btn'),
    scan: $('audio-scan-btn'),
    sleep: $('audio-sleep'),
    playlistLabel: $('audio-playlist-btn-label'),
    playlistCount: $('audio-playlist-btn-count'),
    playlistList: $('audio-playlist-list'),
  };

  /* =======================================================================
     Small helpers
     ======================================================================= */

  /** Restart the one-shot CSS animation (.sp-swap) on an element. */
  function restartSwapAnimation(node) {
    if (!node) return;
    node.classList.remove('sp-swap');
    void node.offsetWidth; // force reflow so the animation restarts
    node.classList.add('sp-swap');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function textOf(node) {
    return ((node && node.textContent) || '').trim();
  }

  function isEnabled(button) {
    return !!(button && !button.disabled);
  }

  function clickIfPresent(button) {
    if (button) button.click();
  }

  /** The big Play button of a playlist. If the song that is loaded belongs to another playlist,
   *  start this playlist from its top song; otherwise it is the normal play / pause. */
  function playPlaylist() {
    const audio = window.NovelAudio;
    if (audio && typeof audio.playSelectionFromTop === 'function' && audio.playSelectionFromTop()) return;
    clickIfPresent(el.play);
  }

  /* =======================================================================
     Views (library / album / track)
     ======================================================================= */

  let enterTimer = 0;

  function setView(name) {
    if (VIEWS.indexOf(name) < 0) return;

    panel.setAttribute('data-view', name);

    // Lets index.html stagger the song rows in; removed once they've played.
    panel.classList.add('sp-enter');
    clearTimeout(enterTimer);
    enterTimer = setTimeout(() => panel.classList.remove('sp-enter'), ENTER_ANIMATION_MS);

    document.querySelectorAll('#sp-nav [data-sp-view]').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-sp-view') === name);
    });

    if (el.views) el.views.scrollTop = 0;
    closeSheet();
    sync();
  }

  /** Swipe between tabs: +1 = the next tab to the right in the bottom bar, -1 = the one to the left.
   *  Does nothing past either end. Returns true when the tab changed. */
  function stepView(delta) {
    const next = VIEWS.indexOf(panel.getAttribute('data-view')) + (delta < 0 ? -1 : 1);
    if (next < 0 || next >= VIEWS.length) return false;
    setView(VIEWS[next]);
    return true;
  }

  window.SpotifyUI = { setView, stepView };

  /* =======================================================================
     "..." sheet
     ======================================================================= */

  function openSheet() {
    if (!el.sheet) return;
    el.sheet.classList.remove('hidden');
    sync();
  }

  function closeSheet() {
    if (!el.sheet) return;
    el.sheet.classList.add('hidden');
    if (el.sleepOptions) el.sleepOptions.classList.add('hidden');
  }

  function isSheetOpen() {
    return !!(el.sheet && !el.sheet.classList.contains('hidden'));
  }

  function runSheetAction(action) {
    switch (action) {
      case 'like':
        if (isEnabled(el.like)) el.like.click();
        closeSheet();
        break;

      case 'addto':
        if (isEnabled(el.addTo)) {
          closeSheet();
          setView('track');
          el.addTo.click();
        }
        break;

      case 'sleep':
        if (el.sleepOptions) el.sleepOptions.classList.toggle('hidden');
        break;

      case 'rescan':
        clickIfPresent(el.scan);
        closeSheet();
        break;
    }
  }

  function chooseSleepTimer(minutes) {
    // Drive the player's own <select>/input so audio-player.js reacts.
    el.sleep.value = minutes;
    el.sleep.dispatchEvent(new Event('change', { bubbles: true }));
    closeSheet();
  }

  /* =======================================================================
     Event handling
     ======================================================================= */

  document.addEventListener('click', (event) => {
    const target = event.target.closest ? event.target : null;
    if (!target || !panel.contains(target)) return;

    // Navigation
    const navButton = target.closest('[data-sp-view]');
    if (navButton) return setView(navButton.getAttribute('data-sp-view'));
    if (target.closest('#sp-back-library')) return setView('library');
    if (target.closest('#sp-track-down')) return setView('album');

    // Picking a playlist row (audio-player.js has already applied the
    // selection in the row's own handler) opens its song list. The delete
    // button stops propagation, so it never reaches here.
    if (target.closest('#audio-playlist-list li')) return setView('album');

    // Forwarded playback buttons
    if (target.closest('#sp-album-play')) return playPlaylist();
    if (target.closest('#sp-album-shuffle')) return clickIfPresent(el.shuffle);

    // The mini player's play button must be checked BEFORE the mini player
    // itself, otherwise tapping play would also open the track view.
    if (target.closest('#sp-mini-play')) {
      event.stopPropagation();
      return clickIfPresent(el.play);
    }
    if (target.closest('#sp-mini')) return setView('track');

    // "..." sheet
    if (target.closest('[data-sp-more]')) return openSheet();
    if (target.closest('[data-sp-sheet-close]')) return closeSheet();

    const actionButton = target.closest('[data-sp-act]');
    if (actionButton) return runSheetAction(actionButton.getAttribute('data-sp-act'));

    const sleepOption = target.closest('[data-sp-sleep]');
    if (sleepOption && el.sleep) return chooseSleepTimer(sleepOption.getAttribute('data-sp-sleep'));
  });

  document.addEventListener('keydown', (event) => {
    // Keyboard activation of the (non-button) mini player
    if (event.target === el.mini && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      setView('track');
    }
    if (event.key === 'Escape' && isSheetOpen()) closeSheet();
  });

  /* =======================================================================
     Colours: current song, else the app theme
     -----------------------------------------------------------------------
     While a track with cover art is loaded, the panel's accent colours
     (--accent, --accent-strong, --accent-ink, --accent-soft, --accent-line)
     are taken from that cover and set on #audio-panel only, together with
     --bg, --text and --muted (same hue) so the text follows too.
     index.html derives the rest (header gradient, buttons, active states,
     progress) from those, so the whole panel follows.

     With no track, a track without art, or a grey cover, the inline values
     are removed and the panel falls straight back to the app's own theme
     variables, live. The accent is nudged to a readable lightness for the
     current theme background.
     ======================================================================= */

  const TINT_VARS = [
    '--accent', '--accent-strong', '--accent-ink', '--accent-soft', '--accent-line',
    '--bg', '--text', '--muted', '--sp-tint',
  ];

  let tintKey = null; // src of the cover the tint was computed from ('' = none)
  let tintRgb = null; // the dominant colour of that cover, or null

  /* ---------- colour maths ---------- */

  /** Relative luminance (WCAG) of an sRGB colour, 0..1. */
  function luminance(r, g, b) {
    const linear = (channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  }

  /** RGB (0..255) -> [h, s, l], each 0..1. */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const l = (max + min) / 2;

    let h = 0;
    let s = 0;

    if (delta) {
      s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

      if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;

      h /= 6;
    }
    return [h, s, l];
  }

  /** [h, s, l] (each 0..1) -> [r, g, b] (0..255, rounded). */
  function hslToRgb(h, s, l) {
    const channel = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    return [
      Math.round(channel(p, q, h + 1 / 3) * 255),
      Math.round(channel(p, q, h) * 255),
      Math.round(channel(p, q, h - 1 / 3) * 255),
    ];
  }

  const toCssRgb = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  const toCssRgba = (c, alpha) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';

  /* ---------- reading the cover ---------- */

  /**
   * Weighted average of a tiny copy of the cover, favouring saturated,
   * mid-brightness pixels so the result is a colour rather than mud.
   * Returns null for (near) greyscale covers.
   */
  function dominantRgb(image) {
    const SIZE = 32;
    const MIN_TOTAL_WEIGHT = 0.5;

    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, SIZE, SIZE);

    const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
    let sumR = 0, sumG = 0, sumB = 0, totalWeight = 0;

    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      if (alpha < 128) continue; // skip transparent pixels

      const [, saturation, lightness] = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
      const weight = saturation * saturation * (1 - Math.abs(lightness - 0.5) * 1.6);
      if (weight <= 0) continue;

      sumR += pixels[i] * weight;
      sumG += pixels[i + 1] * weight;
      sumB += pixels[i + 2] * weight;
      totalWeight += weight;
    }

    if (totalWeight < MIN_TOTAL_WEIGHT) return null; // greyscale / colourless
    return [sumR / totalWeight, sumG / totalWeight, sumB / totalWeight];
  }

  /**
   * Is the APP theme dark? Read from <html>, not from the panel, because the
   * panel's own --bg is overridden while a song colour is active.
   */
  function isThemeDark() {
    const value = (getComputedStyle(document.documentElement).getPropertyValue('--bg') || '').trim();
    let rgb = null;

    const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hexMatch) {
      const hex = hexMatch[1].length === 3 ? hexMatch[1].replace(/./g, '$&$&') : hexMatch[1];
      rgb = [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    } else {
      const numbers = value.match(/[\d.]+/g);
      if (numbers && numbers.length >= 3) rgb = [+numbers[0], +numbers[1], +numbers[2]];
    }

    return rgb ? luminance(rgb[0], rgb[1], rgb[2]) < 0.4 : true;
  }

  /* ---------- applying / clearing ---------- */

  function clearTint() {
    TINT_VARS.forEach((name) => panel.style.removeProperty(name));
  }

  function applyTint(rgb) {
    const [hue, rawSaturation] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const lightness = rgbToHsl(rgb[0], rgb[1], rgb[2])[2];
    const dark = isThemeDark();

    // Accent: keep it vivid, and at a readable lightness for the theme.
    const accentSat = clamp(rawSaturation, 0.45, 0.9);
    const accentLight = dark ? clamp(lightness, 0.55, 0.7) : clamp(lightness, 0.3, 0.45);
    const accent = hslToRgb(hue, accentSat, accentLight);
    const accentStrong = hslToRgb(
      hue, accentSat,
      clamp(accentLight + (dark ? 0.08 : -0.08), 0.1, 0.9)
    );

    // Background and text come from the same hue, so the whole panel reads
    // as one theme: a deep tint of the cover with light text on a dark app
    // theme, a pale tint with dark text on a light one.
    const tintSat = clamp(rawSaturation, 0.3, 0.8);
    const background = hslToRgb(hue, tintSat * (dark ? 0.55 : 0.6), dark ? 0.09 : 0.94);
    const text = hslToRgb(hue, dark ? 0.25 : 0.4, dark ? 0.94 : 0.12);
    const muted = hslToRgb(hue, dark ? 0.15 : 0.2, dark ? 0.68 : 0.36);

    const style = panel.style;
    style.removeProperty('--sp-tint'); // keep index.html's own mix of accent + bg
    style.setProperty('--bg', toCssRgb(background));
    style.setProperty('--text', toCssRgb(text));
    style.setProperty('--muted', toCssRgb(muted));
    style.setProperty('--accent', toCssRgb(accent));
    style.setProperty('--accent-strong', toCssRgb(accentStrong));
    style.setProperty('--accent-ink', toCssRgb(background));
    style.setProperty('--accent-soft', toCssRgba(accent, 0.13));
    style.setProperty('--accent-line', toCssRgba(accent, 0.42));
  }

  function resetTint() {
    clearTint();
    tintKey = '';
    tintRgb = null;
  }

  function updateTint() {
    const hasTrack = isEnabled(el.seek);
    const image = hasTrack && el.artwork ? el.artwork.querySelector('img') : null;

    // No track, or a track without cover art: fall back to the app theme.
    if (!image) {
      if (tintKey !== '') resetTint();
      return;
    }

    const src = image.src;
    if (src === tintKey) return; // already tinted from this cover
    tintKey = src;

    const probe = new Image();
    probe.onload = () => {
      if (tintKey !== src) return; // track changed while decoding

      try {
        tintRgb = dominantRgb(probe);
      } catch (error) {
        tintRgb = null;
      }

      if (tintRgb) applyTint(tintRgb);
      else clearTint();
    };
    probe.onerror = () => {
      if (tintKey !== src) return;
      tintRgb = null;
      clearTint();
    };
    probe.src = src;
  }

  // Theme switched (preset / colour pickers): re-fit the song colour to the
  // new background.
  try {
    new MutationObserver(() => {
      if (tintRgb) applyTint(tintRgb);
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme'],
    });
  } catch (error) {
    /* the tint just won't re-fit live */
  }

  /* =======================================================================
     Playlist covers
     -----------------------------------------------------------------------
     Each playlist row's thumbnail is a 2x2 mosaic of the cover art of its
     first four songs in alphabetical order (by title). Rules:
       - songs without art are skipped
       - fewer than four covers: they repeat to fill the grid
       - exactly one cover: it fills the whole tile
       - no art at all: the row keeps the theme-coloured mosaic from
         index.html

     Mosaics are drawn once on a small canvas and cached by the list of
     songs they were made from (successes only: a look-up that failed is
     tried again after a rescan, and by itself a few seconds later). Nothing is added to the list's DOM (only a
     CSS variable + attribute on each row), so the list observer below is
     not re-triggered.
     ======================================================================= */

  // Big enough to stay sharp on the Home screen's 138 px cards at 3x pixel density.
  const COVER_SIZE_PX = 384;
  const COVER_MAX_SONGS_SCANNED = 12;
  const COVER_ROW_DELAY_MS = 16;     // one playlist per tick keeps the UI smooth
  const COVER_DEBOUNCE_MS = 150;

  // Only successes are remembered. A failed look-up ("no art", or a mosaic that could not be drawn)
  // may be a passing problem (storage not ready yet, a file still being written, a busy moment during
  // the first scan), and remembering it made the covers stay missing until the app was restarted.
  const mosaicCache = {};  // "id|id|id|id" -> data: URL
  const artworkCache = {}; // track path    -> art data: URL (only songs that have art)

  let mosaicPassRunning = false;
  let mosaicPassRequested = false;
  let mosaicTimer = 0;
  let lastLibrarySignature = null;
  let passMisses = null;     // paths asked about during the running pass that had no art (asked once per pass)
  let passSuspicious = 0;    // rows of the running pass that ended without a cover though they have songs
  let retriesUsed = 0;       // retries made since the library last changed
  let retryTimer = 0;
  const COVER_RETRY_MS = [4000, 15000];   // when a pass left rows without a cover, look again, twice at most

  /* ---------- finding the songs of a playlist ---------- */

  function getPlaylistTracks(playlistName) {
    const audio = window.NovelAudio;
    if (!audio || !audio._state || !audio._state.tracks) return [];

    const allTracks = audio._state.tracks;
    if (playlistName === 'all') return allTracks.slice();

    // Smart playlists ("@...") are a list of track ids.
    if (playlistName.charAt(0) === '@' && audio.features && audio.features.selectionFor) {
      const ids = audio.features.selectionFor(playlistName);
      if (ids) {
        const byId = {};
        allTracks.forEach((track) => { byId[track.id] = track; });
        return ids.map((id) => byId[id]).filter(Boolean);
      }
    }

    return allTracks.filter((track) => track.playlist === playlistName);
  }

  function getArtworkFor(track) {
    const bridge = window.AndroidBridge;

    if (artworkCache[track.path]) return artworkCache[track.path];
    if (passMisses && passMisses[track.path]) return '';     // a song in several playlists: ask once per pass

    let uri = '';
    try { uri = bridge.getArtwork(track.path) || ''; } catch (error) { uri = ''; }
    if (uri) artworkCache[track.path] = uri;
    else if (passMisses) passMisses[track.path] = true;
    return uri;
  }

  /** The first (up to) four songs, alphabetically, that have cover art. */
  function getFirstFourWithArt(playlistName) {
    const bridge = window.AndroidBridge;
    if (!bridge || !bridge.getArtwork) return [];

    const byTitle = (a, b) =>
      String(a.title || '').localeCompare(String(b.title || ''), undefined, {
        sensitivity: 'base',
        numeric: true,
      });

    const tracks = getPlaylistTracks(playlistName).sort(byTitle);
    const withArt = [];

    for (let i = 0; i < tracks.length && i < COVER_MAX_SONGS_SCANNED && withArt.length < 4; i++) {
      const uri = getArtworkFor(tracks[i]);
      if (uri) withArt.push({ id: tracks[i].id, uri });
    }
    return withArt;
  }

  /* ---------- drawing the mosaic ---------- */

  function loadImage(uri) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = uri;
    });
  }

  /** Draw an image into a rectangle, cropping like CSS object-fit: cover. */
  function drawImageCover(image, ctx, x, y, width, height) {
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  /** Resolves to a JPEG data: URL, or '' if no image could be loaded. */
  function makeMosaic(items) {
    return Promise.all(items.map((item) => loadImage(item.uri))).then((loaded) => {
      const images = loaded.filter(Boolean);
      if (!images.length) return '';

      const canvas = document.createElement('canvas');
      canvas.width = COVER_SIZE_PX;
      canvas.height = COVER_SIZE_PX;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const half = COVER_SIZE_PX / 2;

      if (images.length === 1) {
        drawImageCover(images[0], ctx, 0, 0, COVER_SIZE_PX, COVER_SIZE_PX);
      } else {
        for (let i = 0; i < 4; i++) {
          const column = i % 2;
          const row = Math.floor(i / 2);
          drawImageCover(images[i % images.length], ctx, column * half, row * half, half, half);
        }
        // thin divider lines between the four tiles
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.fillRect(half - 0.5, 0, 1, COVER_SIZE_PX);
        ctx.fillRect(0, half - 0.5, COVER_SIZE_PX, 1);
      }

      return canvas.toDataURL('image/jpeg', 0.85);
    });
  }

  /* ---------- applying covers to rows ---------- */

  function setRowCover(row, url) {
    updateHomeCover(row.getAttribute('data-playlist-name'), url);
    if (url) {
      row.style.setProperty('--sp-cover', 'url("' + url + '")');
      row.setAttribute('data-sp-cover', '1');
    } else {
      row.style.removeProperty('--sp-cover');
      row.removeAttribute('data-sp-cover');
    }
  }

  /** Process every playlist row, one per tick, then re-run if asked to. */
  function runMosaicPass() {
    if (mosaicPassRunning) {
      mosaicPassRequested = true;
      return;
    }
    if (!el.playlistList) return;

    mosaicPassRunning = true;
    mosaicPassRequested = false;
    passMisses = {};
    passSuspicious = 0;

    const rows = Array.from(el.playlistList.querySelectorAll('li[data-playlist-name]'));
    let index = 0;

    function finish() {
      mosaicPassRunning = false;
      passMisses = null;
      if (mosaicPassRequested) scheduleMosaics();
      else planRetry();
    }

    function processNextRow() {
      if (index >= rows.length) return finish();

      const row = rows[index++];
      if (!row.isConnected) {
        // The player rebuilt its rows while this pass was running: the new rows have not been seen yet.
        mosaicPassRequested = true;
        return setTimeout(processNextRow, 0);
      }

      const name = row.getAttribute('data-playlist-name');
      const items = getFirstFourWithArt(name);
      const cacheKey = items.map((item) => item.id).join('|');
      row.setAttribute('data-sp-pass', '1');      // seen by a pass (an attribute: the list observer ignores it)

      // No art at all: keep the theme-coloured mosaic from index.html.
      if (!cacheKey) {
        if (getPlaylistTracks(name).length) passSuspicious++;   // songs but no art: maybe only for now
        setRowCover(row, '');
        return setTimeout(processNextRow, 0);
      }

      // Already drawn for exactly these songs.
      if (mosaicCache[cacheKey]) {
        setRowCover(row, mosaicCache[cacheKey]);
        return setTimeout(processNextRow, 0);
      }

      makeMosaic(items).then(
        (url) => {
          if (url) mosaicCache[cacheKey] = url; else passSuspicious++;
          if (row.isConnected) setRowCover(row, url);
          setTimeout(processNextRow, COVER_ROW_DELAY_MS);
        },
        () => {
          passSuspicious++;
          setTimeout(processNextRow, COVER_ROW_DELAY_MS);
        }
      );
    }

    processNextRow();
  }

  /** A string that changes whenever the library or the rows' contents do. */
  function getLibrarySignature() {
    const audio = window.NovelAudio;
    let signature = (audio && audio._state && audio._state.tracks ? audio._state.tracks.length : 0) + '#';

    if (el.playlistList) {
      el.playlistList.querySelectorAll('li[data-playlist-name]').forEach((row) => {
        const count = row.querySelector('.pl-count');
        signature += row.getAttribute('data-playlist-name') + ':' + (count ? count.textContent : '') + ';';
      });
    }
    return signature;
  }

  /**
   * A rescan makes audio-player.js rebuild every playlist row from scratch, and the new rows
   * have no cover. The library usually hasn't changed, so the check below would see nothing to
   * do and the covers would stay gone: put back the last cover made for each playlist right away.
   */
  function restoreRowCovers() {
    if (!el.playlistList) return;
    el.playlistList.querySelectorAll('li[data-playlist-name]').forEach((row) => {
      const url = coverUrlByName[row.getAttribute('data-playlist-name')];
      if (url && !row.hasAttribute('data-sp-cover')) {
        row.style.setProperty('--sp-cover', 'url("' + url + '")');
        row.setAttribute('data-sp-cover', '1');
      }
    });
  }

  /** Rows no pass has looked at yet and that still have no cover: a rescan just rebuilt them. */
  function hasUnseenRows() {
    if (!el.playlistList) return false;
    return Array.from(el.playlistList.querySelectorAll('li[data-playlist-name]'))
      .some((row) => !row.hasAttribute('data-sp-cover') && !row.hasAttribute('data-sp-pass'));
  }

  /** A pass left rows without a cover although they have songs: look again shortly, a couple of times. */
  function planRetry() {
    clearTimeout(retryTimer);
    if (!passSuspicious || retriesUsed >= COVER_RETRY_MS.length) return;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      mosaicPassRequested = true;
      scheduleMosaics();
    }, COVER_RETRY_MS[retriesUsed++]);
  }

  function scheduleMosaics() {
    restoreRowCovers();

    // Only redo the work when the library or the rows' contents changed, or when there are fresh
    // rows (a rescan) that have not been looked at, or a retry was asked for.
    const signature = getLibrarySignature();
    if (signature === lastLibrarySignature && !mosaicPassRequested && !hasUnseenRows()) return;

    if (signature !== lastLibrarySignature) retriesUsed = 0;
    lastLibrarySignature = signature;
    clearTimeout(mosaicTimer);
    mosaicTimer = setTimeout(runMosaicPass, COVER_DEBOUNCE_MS);
  }


  /* =======================================================================
     Home: quick-access tiles and shelves
     -----------------------------------------------------------------------
     Built from the player's own playlist rows. Those rows stay in the page
     (hidden) because audio-player.js drives the selection through them, so a
     tap on a tile or card is simply forwarded to its row.
     ======================================================================= */

  const home = {
    root: $('sp-view-library'),
    greeting: $('sp-greeting'),
    grid: $('sp-home-grid'),
    made: $('sp-shelf-made'),
    madeRow: $('sp-shelf-made-row'),
    lists: $('sp-shelf-lists'),
    listsRow: $('sp-shelf-lists-row'),
  };

  let homeSignature = '';
  const coverUrlByName = {};   // playlist name -> mosaic data: URL, kept across row rebuilds

  function readPlaylistRows() {
    if (!el.playlistList) return [];
    return Array.from(el.playlistList.querySelectorAll('li[data-playlist-name]')).map((row, index) => {
      const name = row.getAttribute('data-playlist-name');
      return {
        name,
        title: textOf(row.querySelector('.pl-name')),
        count: textOf(row.querySelector('.pl-count')),
        custom: name.indexOf('@list:') === 0,
        tone: index % 4,
      };
    });
  }

  function findRow(name) {
    if (!el.playlistList) return null;
    return Array.from(el.playlistList.querySelectorAll('li[data-playlist-name]'))
      .find((row) => row.getAttribute('data-playlist-name') === name) || null;
  }

  function setCoverUrl(node, url) {
    if (url) {
      node.style.setProperty('--sp-cover', 'url("' + url + '")');
      node.setAttribute('data-sp-cover', '1');
    } else {
      node.style.removeProperty('--sp-cover');
      node.removeAttribute('data-sp-cover');
    }
  }

  /** The mosaic pass finished a row: show its new cover wherever that playlist appears. */
  function updateHomeCover(name, url) {
    coverUrlByName[name] = url || '';
    if (!home.root) return;
    home.root.querySelectorAll('[data-sp-playlist]').forEach((node) => {
      if (node.getAttribute('data-sp-playlist') !== name) return;
      const cover = node.querySelector('.sp-cover');
      if (cover) setCoverUrl(cover, url);
    });
  }

  function makeElement(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeIcon(iconId) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + iconId);
    svg.appendChild(use);
    return svg;
  }

  function makeCover(tone, iconId, url) {
    const cover = makeElement('span', 'sp-cover');
    cover.setAttribute('data-tone', String(tone));
    cover.appendChild(makeIcon(iconId));
    setCoverUrl(cover, url);
    return cover;
  }

  function makeButton(className, label) {
    const button = makeElement('button', className);
    button.type = 'button';
    if (label) button.setAttribute('aria-label', label);
    return button;
  }

  function makeTile(item) {
    const tile = makeButton('sp-tile', item.title);
    tile.setAttribute('data-sp-playlist', item.name);
    tile.appendChild(makeCover(item.tone, 'i-moon-music', coverUrlByName[item.name]));
    tile.appendChild(makeElement('span', 'sp-tile-name', item.title));
    return tile;
  }

  function makeCard(item) {
    const card = makeElement('div', 'sp-card');
    card.setAttribute('data-sp-playlist', item.name);
    const main = makeButton('sp-card-main', item.title);
    main.appendChild(makeCover(item.tone, 'i-moon-music', coverUrlByName[item.name]));
    main.appendChild(makeElement('span', 'sp-card-name', item.title));
    main.appendChild(makeElement('span', 'sp-card-sub', captionFor(item)));
    card.appendChild(main);
    if (item.custom) {
      const remove = makeButton('sp-card-del', 'Delete playlist');
      remove.appendChild(makeIcon('i-trash'));
      card.appendChild(remove);
    }
    return card;
  }

  function makeNewPlaylistCard() {
    const card = makeElement('div', 'sp-card sp-card-new');
    card.setAttribute('data-sp-new', '1');
    const main = makeButton('sp-card-main', 'New playlist');
    main.appendChild(makeCover(0, 'i-plus'));
    main.appendChild(makeElement('span', 'sp-card-name', 'New playlist'));
    card.appendChild(main);
    return card;
  }

  function fill(container, children) {
    container.textContent = '';
    children.forEach((child) => container.appendChild(child));
  }

  function rebuildHome(items) {
    const plan = planHome(items);
    fill(home.grid, plan.tiles.map(makeTile));
    fill(home.madeRow, plan.made.map(makeCard));
    home.made.hidden = plan.made.length === 0;
    fill(home.listsRow, plan.lists.map(makeCard).concat(makeNewPlaylistCard()));
    home.lists.hidden = false;
  }

  function syncHome() {
    if (!home.grid || !home.madeRow || !home.listsRow) return;

    const greeting = greetingForHour(new Date().getHours());
    if (home.greeting && home.greeting.textContent !== greeting) home.greeting.textContent = greeting;

    const items = readPlaylistRows();
    const signature = items.map((item) => item.name + '\u0001' + item.title + '\u0001' + item.count).join('\u0002');
    if (signature !== homeSignature) {
      homeSignature = signature;
      rebuildHome(items);
    }

    // Which playlist is selected: follows the player's row, so it stays right when the selection changes elsewhere.
    const selected = el.playlistList && el.playlistList.querySelector('li.active');
    const selectedName = selected ? selected.getAttribute('data-playlist-name') : '';
    home.root.querySelectorAll('[data-sp-playlist]').forEach((node) => {
      node.classList.toggle('active', node.getAttribute('data-sp-playlist') === selectedName);
    });
  }

  if (home.root) home.root.addEventListener('click', (event) => {
    const target = event.target.closest ? event.target : null;
    if (!target) return;

    // "New playlist": the name box lives in the Now playing view, so go there to type it.
    if (target.closest('[data-sp-new]')) {
      const newRow = el.playlistList && el.playlistList.querySelector('li.pl-new');
      if (newRow) { newRow.click(); setView('track'); }
      return;
    }

    const holder = target.closest('[data-sp-playlist]');
    const row = holder ? findRow(holder.getAttribute('data-sp-playlist')) : null;
    if (!row) return;

    // Delete: the player's own two-tap confirm (first tap arms it, the second deletes).
    const remove = target.closest('.sp-card-del');
    if (remove) {
      const rowDelete = row.querySelector('.pl-del');
      if (rowDelete) {
        rowDelete.click();
        remove.classList.toggle('confirm', rowDelete.classList.contains('confirm'));
        setTimeout(() => remove.classList.remove('confirm'), 2500);
      }
      return;
    }

    // Choosing a playlist: the row applies the selection, and the document-level handler
    // below then opens its song list.
    row.click();
  });

  /* =======================================================================
     Mirroring the player's state into the kit's UI
     ======================================================================= */

  let lastSongKey = null;

  /** Copy the player's cover (or a music-note placeholder) into `target`. */
  function mirrorArtwork(target) {
    if (!target || !el.artwork) return;

    const sourceImage = el.artwork.querySelector('img');
    if (sourceImage) {
      const currentImage = target.querySelector('img');
      if (!currentImage || currentImage.src !== sourceImage.src) {
        target.innerHTML = '<img alt="" src="' + sourceImage.src + '">';
      }
    } else if (!target.querySelector('svg')) {
      target.innerHTML = '<svg class="ico"><use href="#i-moon-music"/></svg>';
    }
  }

  function getPlaylistTitle() {
    return textOf(el.playlistLabel) || 'All songs';
  }

  /** Snapshot of everything the sync functions below need. */
  function readPlayerState() {
    return {
      title: textOf(el.title),
      artist: textOf(el.artist),
      hasTrack: isEnabled(el.seek),
      isPlaying: !!(el.play && el.play.classList.contains('is-playing')),
      playlist: getPlaylistTitle(),
      songCount: textOf(el.playlistCount),
    };
  }

  /** Song changed: slide the title/artist (full player + mini player) into place. */
  function animateIfSongChanged(state) {
    const songKey = state.hasTrack ? state.title + '\u0001' + state.artist : '';

    if (lastSongKey !== null && songKey && songKey !== lastSongKey) {
      restartSwapAnimation(el.title);
      restartSwapAnimation(el.artist);
      restartSwapAnimation($('sp-mini-text'));
    }
    lastSongKey = songKey;
  }

  function syncMiniPlayer(state) {
    if (el.mini) el.mini.classList.toggle('hidden', !state.hasTrack);
    if (el.miniTitle) el.miniTitle.textContent = state.hasTrack ? state.title : '';
    if (el.miniArtist) el.miniArtist.textContent = state.hasTrack ? state.artist : '';
    if (el.miniSub) el.miniSub.textContent = state.playlist;
  }

  function syncAlbumHeader(state) {
    const { songCount, playlist } = state;

    if (el.albumTitle) el.albumTitle.textContent = playlist;
    if (el.albumMeta) {
      el.albumMeta.textContent = songCount
        ? songCount + (songCount === '1' ? ' song' : ' songs')
        : 'No songs';
    }
    if (el.trackContext) el.trackContext.textContent = playlist;

    if (el.albumPlay) {
      el.albumPlay.disabled = !!(el.play && el.play.disabled);
      // A song from another playlist is playing: this button would start THIS playlist, so it
      // shows Play, not Pause.
      const audio = window.NovelAudio;
      const outside = !!(audio && typeof audio.currentSongInSelection === 'function' && !audio.currentSongInSelection());
      el.albumPlay.classList.toggle('sp-outside', outside);
    }
    if (el.albumShuffle && el.shuffle) {
      el.albumShuffle.classList.toggle('active', el.shuffle.classList.contains('active'));
    }
  }

  function syncLibraryStats() {
    if (!el.playlistList) return;

    const rows = el.playlistList.querySelectorAll('li');
    const allSongsCount = el.playlistList.querySelector('li[data-playlist-name="all"] .pl-count');

    if (el.statPlaylists) el.statPlaylists.textContent = String(rows.length);
    if (el.statSongs) el.statSongs.textContent = allSongsCount ? allSongsCount.textContent : '0';
  }

  function describeSleepTimer(value) {
    if (value === '0') return 'Off';
    if (value === '-1') return 'End of track';
    return value + ' min';
  }

  function syncSheet(state) {
    if (!isSheetOpen()) return;

    if (el.sheetTitle) el.sheetTitle.textContent = state.hasTrack ? state.title : state.playlist;
    if (el.sheetArtist) el.sheetArtist.textContent = state.hasTrack ? state.artist : '';

    const isLiked = !!(el.like && el.like.classList.contains('liked'));
    if (el.likeLabel) el.likeLabel.textContent = isLiked ? 'Remove from Liked' : 'Like';

    const likeButton = el.sheet.querySelector('[data-sp-act="like"]');
    const addToButton = el.sheet.querySelector('[data-sp-act="addto"]');
    if (likeButton) likeButton.disabled = !isEnabled(el.like);
    if (addToButton) addToButton.disabled = !isEnabled(el.addTo);

    const sleepMinutes = el.sleep ? el.sleep.value : '0';
    if (el.sleepValue) el.sleepValue.textContent = describeSleepTimer(sleepMinutes);
    el.sheet.querySelectorAll('[data-sp-sleep]').forEach((option) => {
      option.classList.toggle('on', option.getAttribute('data-sp-sleep') === sleepMinutes);
    });
  }

  let syncFrame = 0;

  function sync() {
    syncFrame = 0;
    const state = readPlayerState();

    animateIfSongChanged(state);
    panel.classList.toggle('sp-playing', state.isPlaying);

    syncMiniPlayer(state);
    syncAlbumHeader(state);

    mirrorArtwork(el.miniArt);
    mirrorArtwork(el.albumCover);
    mirrorArtwork(el.sheetArt);

    updateTint();
    scheduleMosaics();
    syncLibraryStats();
    syncHome();
    syncSheet(state);
  }

  /** Coalesce bursts of DOM mutations into a single sync per frame. */
  function scheduleSync() {
    if (!syncFrame) syncFrame = requestAnimationFrame(sync);
  }

  /** Keep the mini player's progress bar in step with the player's seek bar. */
  function updateMiniProgress() {
    if (document.hidden || !el.seek || !el.miniFill || panel.classList.contains('hidden')) return;

    const max = parseFloat(el.seek.max) || 1;
    const value = parseFloat(el.seek.value) || 0;
    el.miniFill.style.width = clamp(value / max * 100, 0, 100) + '%';
  }

  /* =======================================================================
     Wiring: watch the player's elements and start up
     ======================================================================= */

  const observer = new MutationObserver(scheduleSync);

  // Elements whose content changes (text, children, artwork, playlist list).
  [el.title, el.artist, el.artwork, el.playlistLabel, el.playlistCount, el.playlistList].forEach((node) => {
    if (node) observer.observe(node, { childList: true, subtree: true, characterData: true });
  });

  // Elements whose state changes through attributes.
  [el.play, el.seek, el.like, el.addTo, el.shuffle, el.sleep, panel].forEach((node) => {
    if (node) observer.observe(node, { attributes: true, attributeFilter: ['class', 'disabled', 'value'] });
  });

  setInterval(updateMiniProgress, PROGRESS_INTERVAL_MS);

  setView('library');
  scheduleSync();
})();

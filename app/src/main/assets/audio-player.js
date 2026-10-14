/* =========================================================================
   Novel Reader — Audio Player
   =========================================================================

   "VLC reliability + Spotify experience" hybrid player.

   TWO PLAYBACK ENGINES, one shared UI/queue/library:

     LocalAudioEngine  — a plain WebView <audio> element. Works anywhere
                          (including outside the Android app, e.g. a
                          desktop browser), but Android suspends it once
                          the WebView is backgrounded, so it cannot play
                          reliably with the screen off or the app
                          switched away from.

     NativeAudioEngine — talks over the JS bridge to a real ExoPlayer
                          instance running inside a Media3
                          MediaSessionService (see PlaybackService.kt).
                          This is what makes true background playback,
                          the lock-screen/notification transport controls,
                          and correct audio-focus/headset behaviour
                          possible — none of which a WebView <audio>
                          element can do. See MainActivity.kt's
                          nativeAudio* bridge methods for the other half.

   The app starts on LocalAudioEngine (so it works immediately, and works
   at all in non-Android environments) and switches to NativeAudioEngine
   the moment the native side reports itself ready (window.onNativeAudioReady,
   fired once MainActivity has a live MediaController — see
   NovelAudio._switchToNative()). If anything is already playing at that
   moment, playback hands off to the native engine at the same position
   rather than restarting.

   Both engines implement the same shape — play/pause/toggle/seek/
   setVolume/setSpeed/onTrackEnded/onError — and everything else in this
   file (PlaybackQueue, AudioUI, the reading-session break integration)
   talks to whichever one is current through the single `AudioEngine`
   binding, never to a specific engine by name. That's what lets the
   switch happen invisibly mid-session.

   ARCHITECTURE
   ------------
     MediaLibrary        — knows what files exist and their metadata
     PlaybackQueue        — knows what plays next (order, shuffle, repeat)
     LocalAudioEngine      — plays sound via a WebView <audio> element
     NativeAudioEngine     — plays sound via native ExoPlayer, over the bridge
     AudioEngine (a `let`) — whichever of the two is currently active
     AudioUI               — renders state to the DOM, turns clicks into intents

   State flows one way: UI intent → Queue/Engine → state change → UI
   re-render. Nothing reads the DOM to decide what to do.

   Everything below is exposed as `window.NovelAudio`.
   ========================================================================= */

window.NovelAudio = (function () {
  'use strict';

  // Builds an <svg class="ico"> pointing at a symbol in index.html's
  // shared sprite. A local copy of reader.js's helper of the same name
  // rather than a call across files: this file loads before reader.js
  // (see the <script> order in index.html), so referencing that one
  // would only work by accident, via window, and only for calls that
  // happen to run after both files have finished loading.
  function svgIcon(id) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ico');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  // The volume slider controls the phone's real media volume (STREAM_MUSIC)
  // through the native bridge — this is what actually changes loudness for
  // both playback engines. When that bridge isn't there (desktop browser)
  // it falls back to the engine's own gain.
  function sysVolBridge() {
    const b = window.AndroidBridge;
    return (b && b.setSystemVolume && b.getSystemVolume) ? b : null;
  }
  function gain() {
    const base = sysVolBridge() ? 1 : state.volume;
    // Features (replay gain) may scale the level down. try/catch: gain() can
    // run before AudioFeatures exists, and a feature must never silence audio.
    try { return base * AudioFeatures.outputGain(); } catch (e) { return base; }
  }
  function applySystemVolume(v) {
    const b = sysVolBridge();
    if (b) { try { b.setSystemVolume(v); } catch (e) { /* ignore */ } }
  }
  function syncVolumeFromSystem() {
    const b = sysVolBridge();
    if (!b) return;
    try {
      const v = b.getSystemVolume();
      if (typeof v === 'number' && v >= 0 && v <= 1) state.volume = v;
    } catch (e) { /* ignore */ }
  }

  /* Muting pauses the music and raising the volume again carries on. Only a
     pause that muting caused is undone: if you press play yourself, or never
     had music playing, turning the volume up changes nothing. */
  const MUTE_AT = 0.005;
  const MuteGuard = {
    pausedByMute: false,
    check() {
      if (state.volume <= MUTE_AT) {
        if (state.playing && !this.pausedByMute) {
          this.pausedByMute = true;
          AudioEngine.pause();
        }
      } else if (this.pausedByMute) {
        this.pausedByMute = false;
        if (!state.playing) AudioEngine.play();
      }
    },
    // The listener took over (play pressed, notification button, headset...).
    clear() { this.pausedByMute = false; },
  };

  /* =======================================================================
     1. STATE
     =======================================================================
     One plain object holds everything, shared by both engines — that's
     what makes switching engines mid-session just a matter of pointing
     `AudioEngine` at a different object; the position/volume/queue data
     it reads and writes doesn't move.
  ======================================================================= */

  const EQ_BAND_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  const state = {
    // Library
    tracks: [],              // [{ id, path, title, artist, album, durationSec }]
    scanning: false,

    // Queue
    queue: [],               // array of track ids, in play order
    queueIndex: -1,          // position within queue
    shuffle: false,
    repeat: 'off',           // 'off' | 'all' | 'one'
    activePlaylist: 'all',   // 'all' | a playlist name

    // Playback
    currentTrackId: null,
    playing: false,
    positionSec: 0,
    durationSec: 0,
    volume: 0.8,             // 0..1
    speed: 1.0,

    // Equalizer — only reaches LocalAudioEngine (see the Web Audio graph
    // below); NativeAudioEngine.setEqualizer() documents the native
    // equivalent as a further step.
    eqBands: EQ_BAND_HZ.map(() => 0),  // dB, one per EQ_BAND_HZ entry
    eqPreampDb: 0,

    // Extras
    sleepTimerMinutes: 0,    // 0 = off, -1 = stop at end of current track
    sleepTimerDeadline: null,
    // Mid-playback handoff between LocalAudioEngine and NativeAudioEngine
    // (see _switchToNative()) — NOT a per-track saved position: it's
    // consumed once by the engine being switched to and cleared
    // immediately after, so a track never resumes from here on a later,
    // separate play() of the same id. Every track always starts at 0.
    handoffPositionSec: null,
    duckedForBreak: false,   // true while a reading-break overlay paused us

    // Per-feature state for the optional features (see 7b. AUDIO FEATURES
    // FRAMEWORK) — keyed by module id, filled in by AudioFeatures.register().
    features: {},
  };

  const PREFS_KEY = 'novelReader_audioPrefs';

  /* =======================================================================
     2. MEDIA LIBRARY
     =======================================================================
     Owns discovery and metadata. Nothing here touches playback.
  ======================================================================= */

  const MediaLibrary = {
    /* Scan the audio folder via the native bridge.
     *
     * The native side (MainActivity.kt → AndroidBridge.scanAudio()) walks
     * /storage/emulated/0/Novel/Audio recursively, reads tags with
     * MediaMetadataRetriever, and calls back into
     * window.onAudioListed(json) — mirroring the existing loadNovel()
     * chapter-scanning bridge. See MainActivity.kt for the Kotlin side.
     *
     * STILL TO DO, not required for basic playback to work:
     *   - Cache the scan result keyed by folder mtime so the library
     *     appears instantly on the next launch instead of waiting for a
     *     fresh scan every time.
     *   - Report scan progress incrementally for very large libraries
     *     instead of one callback at the end.
     */
    scan(atStartup) {
      state.scanning = true;
      AudioUI.setNote('');
      AudioUI.render();

      // At start-up the native side has usually already begun (or finished)
      // scanning, so ask for that result instead of starting a second scan.
      if (atStartup === true && window.AndroidBridge && window.AndroidBridge.scanAudioStartup) {
        window.AndroidBridge.scanAudioStartup();
      } else if (window.AndroidBridge && window.AndroidBridge.scanAudio) {
        window.AndroidBridge.scanAudio();
      } else {
        // Running outside the Android app (e.g. this repo's test suite,
        // or the page opened directly in a desktop browser) — there's no
        // bridge to call, so fail visibly rather than hanging on
        // "Scanning…" forever.
        state.scanning = false;
        AudioUI.setNote('Scanning for music only works in the installed Android app.');
        AudioUI.render();
      }
    },

    /* Called by the native side with the scan result. Each track may
     * carry a `playlist` field (the name of the subfolder it lives in
     * under Audio/, or null/undefined for a file directly in Audio/ —
     * see MainActivity.kt's listAudioFiles()). */
    onScanned(tracks) {
      state.tracks = Array.isArray(tracks) ? tracks : [];
      state.scanning = false;
      AudioFeatures.emit('libraryChanged');
      AudioUI.setNote(state.tracks.length ? '' : 'No audio files found in /storage/emulated/0/Novel/Audio.');
      AudioUI.renderPlaylistOptions();

      // Rebuild the queue from whichever playlist is currently selected
      // (defaulting to "All songs"), not always the full library — a
      // rescan while viewing one playlist shouldn't silently widen the
      // queue back out to everything. If something was already playing,
      // keep it playing at its place in the new queue instead of
      // resetting to track zero.
      const currentId = state.currentTrackId;
      const ids = this.currentSelectionIds();
      PlaybackQueue.buildFrom(ids);
      if (currentId && ids.includes(currentId)) {
        PlaybackQueue.jumpTo(currentId);
      }
      AudioUI.render();
    },

    getTrack(id) {
      return state.tracks.find(t => t.id === id) || null;
    },

    /* Distinct playlist names among the current library, sorted for a
     * stable menu order. Files with no `playlist` (sitting directly in
     * Audio/) are excluded here — they're still playable, just as part
     * of "All songs" only, since there's no dedicated filter for them. */
    getPlaylists() {
      const names = new Set();
      state.tracks.forEach(t => { if (t.playlist) names.add(t.playlist); });
      return Array.from(names).sort((a, b) => a.localeCompare(b));
    },

    tracksInPlaylist(name) {
      return state.tracks.filter(t => t.playlist === name);
    },

    /* Track ids for whatever `state.activePlaylist` currently selects —
     * 'all' (everything) or a specific playlist name. This is the single
     * place that turns "which playlist is selected" into "which tracks
     * build the queue", so the queue, shuffle, repeat, and next/prev all
     * automatically operate within just that selection once
     * PlaybackQueue.buildFrom() is called with its result — nothing
     * downstream needs to know playlists exist. */
    currentSelectionIds() {
      const sel = state.activePlaylist;
      const virtual = AudioFeatures.selectionFor(sel);   // '@recent' / '@liked' / '@list:<id>'
      if (virtual) return virtual;
      if (!sel || sel === 'all') return state.tracks.map(t => t.id);
      return this.tracksInPlaylist(sel).map(t => t.id);
    },
  };

  /* =======================================================================
     3. PLAYBACK QUEUE
     =======================================================================
     Owns ordering. Deliberately kept independent of which engine is
     currently playing — the queue doesn't know or care whether the next
     track will be handed to LocalAudioEngine or NativeAudioEngine.
  ======================================================================= */

  const PlaybackQueue = {
    _originalOrder: [],

    buildFrom(trackIds) {
      this._originalOrder = trackIds.slice();
      // If shuffle is already on (e.g. restored from a saved preference,
      // or surviving a rescan/playlist switch), the rebuilt queue needs
      // to come out shuffled too — otherwise every rebuild silently
      // reverted to plain alphabetical order while the shuffle button
      // kept showing as active, which is what let a "not really
      // shuffling" queue slip through unnoticed.
      if (state.shuffle) {
        state.queue = trackIds.slice();
        state.queueIndex = trackIds.length ? 0 : -1;
        this.setShuffle(true);
      } else {
        state.queue = trackIds.slice();
        state.queueIndex = trackIds.length ? 0 : -1;
      }
    },

    current() {
      return state.queue[state.queueIndex] || null;
    },

    /* Fisher-Yates shuffle — unbiased, unlike `sort(() => Math.random()
     * - 0.5)`. When shuffle is switched on while a track is actually
     * playing, that track stays first so playback doesn't jump; anything
     * else is shuffled around it. Switching shuffle off restores
     * _originalOrder exactly, since that array is never mutated.
     *
     * Pinning only applies when state.currentTrackId is set — i.e.
     * something has actually been loaded to play. queueIndex itself is
     * always 0 right after buildFrom(), whether or not anything has
     * played yet, so using this.current() (which reads off queueIndex)
     * as the "keep this one first" track pinned whatever track happened
     * to sort first alphabetically on every fresh scan or playlist
     * switch — shuffle looked like it "always played the first song"
     * because, from a fresh queue, it effectively always did. */
    setShuffle(enabled) {
      state.shuffle = enabled;
      const currentId = state.currentTrackId || null;

      if (enabled) {
        const rest = this._originalOrder.filter(id => id !== currentId);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp;
        }
        state.queue = currentId ? [currentId, ...rest] : rest;
        state.queueIndex = state.queue.length ? 0 : -1;
      } else {
        state.queue = this._originalOrder.slice();
        state.queueIndex = currentId ? state.queue.indexOf(currentId) : (state.queue.length ? 0 : -1);
      }
      AudioUI.render();
    },

    cycleRepeat() {
      const order = ['off', 'all', 'one'];
      state.repeat = order[(order.indexOf(state.repeat) + 1) % order.length];
      AudioUI.render();
    },

    /* Returns the next track id, honouring repeat mode, or null at the
     * end of the queue. Kept pure (no side effects) so it can be unit
     * tested and so LocalAudioEngine can *preload* the next track
     * without committing to it. */
    peekNext() {
      if (state.repeat === 'one') return this.current();
      const nextIndex = state.queueIndex + 1;
      if (nextIndex < state.queue.length) return state.queue[nextIndex];
      return state.repeat === 'all' ? (state.queue[0] || null) : null;
    },

    advance() {
      if (state.repeat === 'one') return this.current();
      const nextIndex = state.queueIndex + 1;
      if (nextIndex < state.queue.length) {
        state.queueIndex = nextIndex;
      } else if (state.repeat === 'all' && state.queue.length) {
        state.queueIndex = 0;
      } else {
        return null;
      }
      return this.current();
    },

    previous() {
      // Standard behaviour: restart the track if more than ~3s in,
      // otherwise go to the actual previous track.
      if (state.positionSec > 3) return this.current();
      if (state.queueIndex > 0) {
        state.queueIndex -= 1;
      } else if (state.repeat === 'all' && state.queue.length) {
        state.queueIndex = state.queue.length - 1;
      }
      return this.current();
    },

    jumpTo(trackId) {
      const idx = state.queue.indexOf(trackId);
      if (idx !== -1) state.queueIndex = idx;
      return this.current();
    },
  };

  /* =======================================================================
     4. SHARED "TRACK FINISHED / FAILED" LOGIC
     =======================================================================
     Both engines report track-end and track-error the same way — this is
     one function each so the actual *behaviour* (repeat modes, the
     sleep-timer "stop at end of track" mode, auto-advance, resume-point
     cleanup, error messaging) can't quietly drift apart between the two
     engines over time. Each engine's onTrackEnded()/onError() is a thin
     wrapper that calls these with itself as `engine`.
  ======================================================================= */

  function handleTrackEnded(engine) {
    AudioFeatures.emit('trackEnd', MediaLibrary.getTrack(state.currentTrackId));
    if (state.sleepTimerMinutes === -1) {
      // "Stop at end of track" sleep mode — this was that track.
      AudioUI.setSleepTimer(0);
      engine.pause();
      return;
    }

    const next = PlaybackQueue.advance();
    if (next) {
      engine.play(next);
    } else {
      state.playing = false;
      AudioUI.render();
    }
  }

  function handleError(engine, detail) {
    // VLC's reliability is largely about degrading gracefully — one
    // unplayable/corrupt file should never stall the whole queue.
    const failedTrack = MediaLibrary.getTrack(state.currentTrackId);
    console.error('Audio playback error', detail, failedTrack && failedTrack.path);
    AudioUI.setNote('Couldn\u2019t play \u201c' + (failedTrack ? failedTrack.title : 'that track') + '\u201d, so it was skipped.');

    const next = PlaybackQueue.advance();
    if (next) {
      engine.play(next);
    } else {
      state.playing = false;
      AudioUI.render();
    }
  }

  /* Shared bookkeeping for a crossfade — see the Crossfade feature module in
   * section 7b. Both engines call this the moment a crossfade starts. From
   * then on the NEXT track is "the" current track as far as the app is
   * concerned (queue position, title, seek bar, history, replay-gain level),
   * while the engine keeps playing the tail of the old one underneath. The
   * engine-specific part is `startAudio(outGain, inGain)`: the linear levels
   * of the track fading out and the track fading in (each includes that
   * track's own replay gain). It runs BEFORE the 'trackStart' event so that
   * the gain refresh that event triggers already finds the crossfade live and
   * is redirected instead of making the level jump. */
  function switchForCrossfade(nextId, startAudio) {
    const next = MediaLibrary.getTrack(nextId);
    if (!next) return false;
    const prev = MediaLibrary.getTrack(state.currentTrackId);
    const outGain = gain();                    // the level of the track that is fading out
    AudioFeatures.emit('trackEnd', prev);
    state.currentTrackId = nextId;
    PlaybackQueue.jumpTo(nextId);
    state.durationSec = next.durationSec || 0;
    state.positionSec = 0;
    startAudio(outGain, gain());               // gain() now describes the incoming track
    AudioFeatures.emit('trackStart', next);
    AudioUI.render();
    return true;
  }

  // <audio>.volume throws if it is ever outside 0..1.
  function clamp01(v) { return v > 1 ? 1 : (v > 0 ? v : 0); }

  /* =======================================================================
     5. LOCAL AUDIO ENGINE (WebView <audio> element)
     =======================================================================
     IMPLEMENTATION: a plain HTML <audio> element, given the track's
     `webUrl` (https://appassets.androidplatform.net/audio/<path under
     Audio/>), which MainActivity.kt serves from Novel/Audio with Range
     support so seeking works. The page runs on that same https origin, so
     the Web Audio equalizer can process the sound, and the WebView needs
     no file:// access at all. (`path`, the file:// URI, is still what the
     native engine and artwork lookups use.) mediaPlaybackRequiresUserGesture
     is false so programmatic play() calls aren't blocked.

     WHAT THIS GETS YOU: play/pause/seek/volume/speed, resume-at-position,
     shuffle/repeat, auto-skip past a file that fails to decode, and (new)
     a real 10-band Web Audio equalizer.

     WHAT IT STILL DOESN'T GET YOU: reliable playback once the WebView is
     backgrounded (Android suspends it), lock-screen/notification
     controls, and true gapless transitions — that's what
     NativeAudioEngine below is for, and the app switches to it
     automatically once it's ready. This engine remains in place as the
     fallback for anywhere NativeAudioEngine can't run (outside the
     Android app) and as what plays audio in the brief window before the
     native side finishes connecting.
  ======================================================================= */

  const LocalAudioEngine = {
    _el: null,             // the HTMLAudioElement that is actually playing
    _el2: null,            // the spare element: takes over during a crossfade (the two swap roles each time)
    _xf: null,             // the crossfade in progress, or null (see beginCrossfade)
    _preloadEl: null,      // hidden element used to pre-buffer the next track
    _preloadedTrackId: null,
    _pendingSeek: null,    // seconds to apply once 'loadedmetadata' fires
    _eqGraph: null,        // lazily-built { ctx, source, source2, filters, preamp }

    init() {
      this._el = new Audio();
      this._el2 = new Audio();
      [this._el, this._el2].forEach(el => {
        el.preload = 'auto';
        el.volume = el === this._el ? gain() : 0;
        el.playbackRate = state.speed;
        this._applyPitchPreservation(el);
        this._wire(el);
      });

      this._preloadEl = new Audio();
      this._preloadEl.preload = 'auto';
      this._preloadEl.volume = 0; // never audible — it's only there to warm the cache
    },

    /* Event wiring for one of the two playback elements. The two swap roles
     * on every crossfade, so each handler first checks that its element is
     * the LIVE one (this._el) — the element that is just fading out must not
     * move the seek bar, report "ended", or flip the play button. */
    _wire(el) {
      const live = () => el === this._el;

      el.addEventListener('loadedmetadata', () => {
        if (!live()) return;
        // Only trust the tag-reported duration as a fallback; once the
        // file is actually loaded, the real duration is authoritative
        // (tags can be wrong or missing).
        if (el.duration && isFinite(el.duration)) {
          state.durationSec = el.duration;
        }
        if (this._pendingSeek !== null) {
          el.currentTime = this._pendingSeek;
          this._pendingSeek = null;
        }
        AudioUI.render();
      });

      // Fires ~4x/sec while playing. Re-rendering the whole panel that
      // often is wasteful, so this updates only the seek bar/time labels
      // directly; a full render() only happens on track/state changes.
      el.addEventListener('timeupdate', () => {
        if (!live()) return;
        state.positionSec = el.currentTime || 0;
        AudioUI.updateProgressOnly();
        this._applySleepFadeIfDue();
        AudioFeatures.emit('progress', { positionSec: state.positionSec, durationSec: state.durationSec });
      });

      el.addEventListener('ended', () => { if (live()) this.onTrackEnded(); });
      el.addEventListener('error', (e) => { if (live()) this.onError(e); });

      // Keep `state.playing` in sync with the element's own play/pause
      // events (not just our own play()/pause() calls) — e.g. Android
      // can pause an <audio> element for reasons outside our control.
      el.addEventListener('play', () => {
        if (!live()) return;
        state.playing = true;
        AudioUI.setNote(''); // a prior error/skip note is now superseded
        AudioUI.render();
      });
      el.addEventListener('pause', () => {
        if (!live()) return;
        state.playing = false;
        AudioUI.render();
      });
    },

    // Some browsers/WebViews use the unprefixed property, older ones a
    // vendor-prefixed one; setting whichever exist is harmless.
    _applyPitchPreservation(el) {
      if ('preservesPitch' in el) el.preservesPitch = true;
      if ('mozPreservesPitch' in el) el.mozPreservesPitch = true;
      if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
    },

    /* Load and play a track. Safe to call with no argument to
     * resume/start whatever is current. */
    play(trackId) {
      const id = trackId || state.currentTrackId || PlaybackQueue.current();
      if (!id) return;
      const track = MediaLibrary.getTrack(id);
      if (!track) return;

      MuteGuard.clear(); // playback started on purpose: forget any pause-on-mute
      const isAlreadyLoaded = id === state.currentTrackId && this._el.src;

      // Picking a different track (next/previous/queue tap) while a
      // crossfade is still running ends it on the spot.
      if (!isAlreadyLoaded) this._endCrossfade();

      if (!isAlreadyLoaded) {
        state.currentTrackId = id;
        PlaybackQueue.jumpTo(id);
        this._el.src = track.webUrl || track.path;
        state.durationSec = track.durationSec || 0;
        state.positionSec = 0;
        // Always starts from the beginning — no resume-from-last-position.
        this._pendingSeek = null;
        AudioFeatures.emit('trackStart', track);
      }

      this._applyVolume();
      this._el.playbackRate = state.speed;
      this._applyPitchPreservation(this._el);

      // Set optimistically, then correct via events if needed — see the
      // 'play'/'pause' listeners above. Waiting for the element's own
      // event before updating the UI would leave the pause icon, queue
      // highlight, and disabled states stale for however long buffering
      // takes.
      state.playing = true;
      AudioUI.render();

      // A suspended AudioContext (created lazily by the EQ, see below)
      // needs an explicit resume() after user interaction — play() is
      // as close to that gesture as this engine gets a hook for.
      if (this._eqGraph && this._eqGraph.ctx.state === 'suspended') {
        this._eqGraph.ctx.resume();
      }

      const playResult = this._el.play();
      // Autoplay-policy rejections are the single most common cause of
      // "the play button silently does nothing" bug reports — always
      // handle the promise, never fire-and-forget it.
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {
          state.playing = false;
          AudioUI.setNote('Playback was blocked. Tap Play again to start it.');
          AudioUI.render();
        });
      }

      this._preloadNext();
    },

    pause() {
      this._endCrossfade();          // silence the fading-out tail too
      this._el.pause();
      if (state.playing) {
        state.playing = false;
        AudioUI.render();
      }
    },

    toggle() {
      if (state.playing) this.pause();
      else this.play();
    },

    /* The one place the live element's level is set from gain(). While a
     * crossfade is running the ramp owns the element's volume, so this only
     * records the new target level for it to fade towards. */
    _applyVolume() {
      if (this._xf) { this._xf.inGain = gain(); return; }
      if (this._el) this._el.volume = clamp01(gain());
    },

    /* Seek to an absolute position in seconds. Setting .currentTime
     * before the element has metadata is silently ignored by the
     * platform, which is why naive seek implementations "sometimes
     * don't work" — readyState >= 1 (HAVE_METADATA) is required first;
     * otherwise the seek is queued and applied by the loadedmetadata
     * handler above. */
    seek(seconds) {
      if (!state.durationSec) return;
      this._endCrossfade();
      const clamped = Math.max(0, Math.min(state.durationSec, seconds));
      if (this._el.readyState >= 1) {
        this._el.currentTime = clamped;
      } else {
        this._pendingSeek = clamped;
      }
      state.positionSec = clamped;
      AudioUI.updateProgressOnly();
    },

    setVolume(v) {
      state.volume = Math.max(0, Math.min(1, v));
      applySystemVolume(state.volume);
      MuteGuard.check();
      this._applyVolume();
      Prefs.save();
      AudioUI.render();
    },

    setSpeed(rate) {
      state.speed = rate;
      if (this._el) this._el.playbackRate = rate;
      if (this._el2) this._el2.playbackRate = rate;
      Prefs.save();
      AudioUI.render();
    },

    /* -------------------------------------------------------------------
       10-band equalizer via the Web Audio API.
       -------------------------------------------------------------------
       Graph: <audio> element -> MediaElementSourceNode -> band1 -> band2
       -> ... -> band10 -> preamp GainNode -> ctx.destination.

       Built lazily (on first EQ use, not at init()) for two reasons:
       browsers commonly start an AudioContext 'suspended' until a user
       gesture occurs, so creating it eagerly at page-load just means an
       extra resume() dance for no benefit; and createMediaElementSource
       can only ever be called ONCE per <audio> element for its entire
       lifetime — building the graph once, on demand, and caching it is
       what makes that safe to rely on.

       The element's own .volume keeps working as the main volume control
       even once routed through this graph (per spec, the element's
       "effective playback volume" is applied before its audio enters the
       Web Audio graph) — so setVolume() above needs no changes, and the
       preamp GainNode here is purely for EQ headroom, not overall volume.
       ------------------------------------------------------------------- */
    _ensureEqGraph() {
      if (this._eqGraph) return this._eqGraph;
      if (!this._el) return null;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null; // Web Audio unsupported in this environment

      try {
        const ctx = new Ctx();
        const source = ctx.createMediaElementSource(this._el);
        // The spare element (used for crossfades) feeds the same chain. Each
        // element can only ever be wrapped once, so both are wrapped here.
        const source2 = this._el2 ? ctx.createMediaElementSource(this._el2) : null;
        const filters = EQ_BAND_HZ.map(freq => {
          const f = ctx.createBiquadFilter();
          f.type = 'peaking';
          f.frequency.value = freq;
          f.Q.value = 1.0;
          f.gain.value = 0;
          return f;
        });
        const preamp = ctx.createGain();
        preamp.gain.value = 1;

        let node = source;
        filters.forEach(f => { node.connect(f); node = f; });
        if (source2) source2.connect(filters[0]);
        node.connect(preamp);
        preamp.connect(ctx.destination);

        this._eqGraph = { ctx, source, source2, filters, preamp };
      } catch (e) {
        console.error('Web Audio EQ graph could not be created', e);
        this._eqGraph = null;
      }
      return this._eqGraph;
    },

    /* bandsDb: array of 10 gain values in dB, one per EQ_BAND_HZ entry
     * (typical UI range roughly -12..+12). Silently does nothing if Web
     * Audio isn't available in this environment — callers don't need to
     * feature-detect themselves. */
    setEqualizer(bandsDb) {
      state.eqBands = bandsDb.slice(0, EQ_BAND_HZ.length);
      Prefs.save(); // persist regardless — if Web Audio becomes available later, these apply automatically
      const graph = this._ensureEqGraph();
      if (!graph) {
        AudioUI.setNote('The equalizer isn\u2019t available on this device.');
        return;
      }
      graph.filters.forEach((f, i) => { f.gain.value = state.eqBands[i] || 0; });
      if (graph.ctx.state === 'suspended') graph.ctx.resume();
    },

    setPreamp(db) {
      state.eqPreampDb = db;
      Prefs.save();
      const graph = this._ensureEqGraph();
      if (!graph) return;
      graph.preamp.gain.value = Math.pow(10, db / 20); // dB -> linear
    },

    onTrackEnded() { handleTrackEnded(this); },
    onError(e) { handleError(this, e); },

    /* Warms the OS/WebView cache for whatever plays next, so that when
     * onTrackEnded() actually switches this._el.src to it, the bytes are
     * already local instead of being fetched from disk cold. */
    _preloadNext() {
      const nextId = PlaybackQueue.peekNext();
      if (!nextId || nextId === this._preloadedTrackId) return;
      const track = MediaLibrary.getTrack(nextId);
      if (!track) return;
      this._preloadEl.src = track.webUrl || track.path;
      this._preloadEl.load();
      this._preloadedTrackId = nextId;
    },

    /* Sleep timer: fades playback volume linearly to 0 over the final
     * ~20 seconds before the deadline, then pauses and restores volume
     * to the user's normal level for next time. Driven off a wall-clock
     * timestamp, not a countdown, so it stays correct across
     * backgrounding. Only relevant for the "N minutes" sleep mode —
     * "stop at end of track" is handled in handleTrackEnded(). */
    _applySleepFadeIfDue() {
      if (!state.sleepTimerDeadline || state.sleepTimerMinutes <= 0) return;
      const remainingMs = state.sleepTimerDeadline - Date.now();

      if (remainingMs <= 0) {
        this._endCrossfade();
        this._el.volume = clamp01(gain()); // restore for the next play()
        this.pause();
        AudioUI.setSleepTimer(0);
        return;
      }

      const FADE_WINDOW_MS = 20000;
      if (remainingMs <= FADE_WINDOW_MS && !this._xf) {
        this._el.volume = clamp01(gain() * (remainingMs / FADE_WINDOW_MS));
      }
    },

    /* -------------------------------------------------------------------
       Crossfade. Called once by the crossfade feature module when the
       playing track is inside the crossfade window (see section 7b).

       The spare <audio> element starts the next track at volume 0, the two
       swap roles (so `_el` is again "the element that is playing"), and a
       timer ramps them against each other on an equal-power curve —
       cos for the track going out, sin for the one coming in — which keeps
       the loudness steady through the overlap (a straight linear fade
       dips by about 3 dB in the middle). The ramp follows the wall clock,
       not the tick count, so a late timer can't stretch it.

       Returns false when it can't crossfade (nothing playing, a crossfade
       already running, or under 0.3 s of the old track left); the track
       then just ends and the next one starts the normal way.
       ------------------------------------------------------------------- */
    beginCrossfade(nextId, seconds) {
      if (this._xf || !state.playing || !this._el || !this._el.src) return false;
      const next = MediaLibrary.getTrack(nextId);
      if (!next || !(seconds > 0)) return false;
      const left = (this._el.duration || 0) - (this._el.currentTime || 0);
      const fadeMs = Math.min(seconds, left) * 1000;
      if (!(fadeMs >= 300)) return false;

      const outEl = this._el, inEl = this._el2;
      const started = switchForCrossfade(nextId, (outGain, inGain) => {
        inEl.src = next.webUrl || next.path;
        inEl.volume = 0;
        inEl.playbackRate = state.speed;
        this._applyPitchPreservation(inEl);

        this._el = inEl;                 // from here on the new track is the live element
        this._el2 = outEl;
        this._pendingSeek = null;
        this._xf = { outEl, inEl, outGain, inGain, fadeMs, createdMs: Date.now(), startMs: null, timer: null };
        this._xf.timer = setInterval(() => this._xfTick(), 40);

        if (this._eqGraph && this._eqGraph.ctx.state === 'suspended') this._eqGraph.ctx.resume();
        const r = inEl.play();
        if (r && typeof r.catch === 'function') {
          r.catch(() => {
            this._endCrossfade();
            state.playing = false;
            AudioUI.setNote('Playback was blocked. Tap Play again to start it.');
            AudioUI.render();
          });
        }
      });
      if (started) this._preloadNext();     // warm the track after the new one
      return started;
    },

    _xfTick() {
      const xf = this._xf;
      if (!xf) return;
      const now = Date.now();
      if (xf.startMs === null) {
        // Hold the old track at full level until the new one can really play
        // (normally a few ms for a local file), then start the clock.
        if (xf.inEl.readyState < 3 && now - xf.createdMs < 1500) return;
        xf.startMs = now;
        const left = ((xf.outEl.duration || 0) - (xf.outEl.currentTime || 0)) * 1000;
        xf.fadeMs = Math.min(xf.fadeMs, left);
        if (!(xf.fadeMs >= 50)) { this._endCrossfade(); return; }
      }
      const c = AudioFeatures.crossfade.curve((now - xf.startMs) / xf.fadeMs);
      xf.inEl.volume = clamp01(c.inn * xf.inGain);
      xf.outEl.volume = clamp01(c.out * xf.outGain);
      if (now - xf.startMs >= xf.fadeMs) this._endCrossfade();
    },

    /* Finishes (or abandons) the crossfade: the old element is stopped and
     * emptied, the live one snaps to its full level. Safe to call any time. */
    _endCrossfade() {
      const xf = this._xf;
      if (!xf) return;
      clearInterval(xf.timer);
      this._xf = null;
      try {
        xf.outEl.pause();
        xf.outEl.removeAttribute('src');
        xf.outEl.load();               // drops the file so it can be reused as the spare
        xf.outEl.volume = 0;
      } catch (e) { /* ignore */ }
      if (this._el) this._el.volume = clamp01(gain());
    },
  };

  /* =======================================================================
     6. NATIVE AUDIO ENGINE (ExoPlayer via the JS bridge)
     =======================================================================
     This object never touches audio hardware itself — every method is a
     thin call across the bridge to MainActivity.kt, which forwards to a
     MediaController connected to PlaybackService's MediaSession (real
     ExoPlayer, running in a foreground Service). The matching native
     callbacks (window.onNativeAudio*, wired at the bottom of this file)
     report state back the same way LocalAudioEngine's <audio> event
     listeners do — this object is deliberately shaped to mirror
     LocalAudioEngine method-for-method, which is what lets `AudioEngine`
     be reassigned between the two without anything else in this file
     caring which one is live.

     Queue ownership stays here in JS on purpose (see PlaybackQueue above)
     — the native side only ever holds ONE MediaItem at a time, the one
     JS just told it to load. That keeps shuffle/repeat logic in a single
     place instead of duplicated in Kotlin, at the cost of native-quality
     gapless transitions (a further step — see the note on
     PlaybackService.kt's QueueAwarePlayer for the equivalent tradeoff on
     the Next/Previous transport buttons, which DO need special handling
     precisely because native only ever sees one item).
  ======================================================================= */

  const NativeAudioEngine = {
    _pendingSeek: null,
    // Which track id the NATIVE side actually has loaded — deliberately
    // separate from state.currentTrackId, which may already equal the
    // id we're about to play (e.g. right after switching over from
    // LocalAudioEngine, which sets state.currentTrackId itself). Using
    // the shared field for this check would skip the load() call on
    // first use of this engine, leaving nothing loaded natively even
    // though state *looked* like playback had already started.
    _loadedTrackId: null,
    // Until this time, a "paused" report from native is ignored: right after
    // a crossfade starts the new player is briefly buffering, which reads as
    // "not playing" for a few tens of ms and would make the play button blink.
    _xfGraceUntil: 0,

    init() {
      // Nothing to set up locally — this engine has no DOM/media element
      // of its own. See window.onNativeAudioReady etc. at the bottom of
      // this file for where its half of the wiring lives.
    },

    _bridge() {
      return window.AndroidBridge || null;
    },

    play(trackId) {
      const bridge = this._bridge();
      if (!bridge) return;
      const id = trackId || state.currentTrackId || PlaybackQueue.current();
      if (!id) return;
      const track = MediaLibrary.getTrack(id);
      if (!track) return;

      MuteGuard.clear(); // playback started on purpose: forget any pause-on-mute
      const isAlreadyLoaded = id === this._loadedTrackId;
      state.currentTrackId = id;
      PlaybackQueue.jumpTo(id);

      // Optimistic UI update, same reasoning as LocalAudioEngine.play():
      // don't make the pause icon wait on a round trip through the
      // bridge and back before it can update. Note NOT cleared here —
      // see onStateChanged() below, which clears it only once native
      // confirms playback actually started; clearing it here would wipe
      // out a "couldn't play X, skipping" message before anyone reads
      // it, since handleError() calls play() on the very next line
      // after setting that note.
      state.playing = true;
      AudioUI.render();

      if (!isAlreadyLoaded) {
        state.durationSec = track.durationSec || 0;
        state.positionSec = 0;
        // A pending mid-playback handoff from LocalAudioEngine (see
        // _switchToNative()) is consumed here, once, then cleared —
        // this is the ONE case a track doesn't start at 0: continuing
        // the same play-through across an engine switch, not resuming a
        // track that was previously left partway through and revisited
        // later. Every other path (a fresh play() of any track,
        // including this same one next time) always starts at 0.
        this._pendingSeek = state.handoffPositionSec;
        state.handoffPositionSec = null;
        bridge.nativeAudioLoad(track.path, track.title || '', track.artist || '', track.album || '');
        this._loadedTrackId = id;
        AudioFeatures.emit('trackStart', track);
      }

      bridge.nativeAudioPlay();
      this._scheduleStateCheck();
    },

    // The UI flips to the pause icon optimistically (above). If the
    // native side never actually starts, or its state callback is lost,
    // that would leave the buttons showing the wrong state. A couple of
    // short follow-up checks ask the native player what it is really
    // doing; its answer arrives through onStateChanged() and corrects
    // the UI either way.
    _stateCheckTimers: [],
    _scheduleStateCheck() {
      this._stateCheckTimers.forEach(clearTimeout);
      const bridge = this._bridge();
      if (!bridge || !bridge.nativeAudioSyncState) return;
      this._stateCheckTimers = [1200, 3500].map(ms => setTimeout(() => {
        if (AudioEngine === NativeAudioEngine) bridge.nativeAudioSyncState();
      }, ms));
    },

    pause() {
      const bridge = this._bridge();
      if (bridge) bridge.nativeAudioPause();
      if (state.playing) {
        state.playing = false;
        AudioUI.render();
      }
    },

    toggle() {
      if (state.playing) this.pause();
      else this.play();
    },

    seek(seconds) {
      const bridge = this._bridge();
      if (!bridge || !state.durationSec) return;
      const clamped = Math.max(0, Math.min(state.durationSec, seconds));
      bridge.nativeAudioSeek(clamped);
      state.positionSec = clamped;
      AudioUI.updateProgressOnly();
    },

    setVolume(v) {
      state.volume = Math.max(0, Math.min(1, v));
      applySystemVolume(state.volume);
      MuteGuard.check();
      const bridge = this._bridge();
      if (bridge) bridge.nativeAudioSetVolume(gain());
      Prefs.save();
      AudioUI.render();
    },

    setSpeed(rate) {
      state.speed = rate;
      const bridge = this._bridge();
      if (bridge) bridge.nativeAudioSetSpeed(rate);
      Prefs.save();
      AudioUI.render();
    },

    /* Native equalizer. The Web Audio graph built for LocalAudioEngine never
     * sees audio played through ExoPlayer, so the curve is handed to
     * android.media.audiofx.Equalizer on ExoPlayer's audio session instead
     * (AudioFeatures → nativeEffects → AndroidBridge.nativeAudioSetEqualizer
     * → NativeAudioEffects.kt). Device bands (commonly 5) are interpolated
     * from our 10 on the native side. If the bridge method is missing, fall
     * back to the old behaviour: the curve is stored and applies the next
     * time the WebView engine plays. */
    setEqualizer(bandsDb) {
      state.eqBands = bandsDb.slice(0, EQ_BAND_HZ.length);
      Prefs.save();
      if (AudioFeatures.nativeEffects.apply()) return;
      AudioUI.setNote('The equalizer only affects playback while the app is open. It isn\u2019t applied to background playback yet.');
    },
    setPreamp(db) {
      state.eqPreampDb = db;
      Prefs.save();
      AudioFeatures.nativeEffects.apply();
    },

    // Called by window.onNativeAudioLoaded once the native side reaches
    // STATE_READY — this engine's equivalent of the <audio> element's
    // 'loadedmetadata' event.
    onLoaded(durationSec) {
      if (durationSec) state.durationSec = durationSec;
      if (this._pendingSeek !== null) {
        const bridge = this._bridge();
        if (bridge) bridge.nativeAudioSeek(this._pendingSeek);
        state.positionSec = this._pendingSeek;
        this._pendingSeek = null;
      }
      AudioUI.render();
    },

    // Called by window.onNativeAudioState({playing}) — corrects
    // state.playing for changes we didn't directly cause: the system
    // media notification's own pause button, a Bluetooth remote, or
    // audio focus lost to another app.
    onStateChanged(playing) {
      if (playing) AudioUI.setNote(''); // confirmed playback supersedes any prior error/skip note
      if (playing) MuteGuard.clear();   // started from the notification/headset: not ours to undo
      if (!playing && Date.now() < this._xfGraceUntil) return; // see _xfGraceUntil
      if (state.playing === playing) return;
      state.playing = playing;
      AudioUI.render();
    },

    // Called by window.onNativeAudioProgress(posSec, durSec), a couple
    // of times a second while playing.
    onProgress(positionSec, durationSec) {
      // Reports already on their way from the OLD track when a crossfade began
      // would drag the seek bar back to its end (and re-trigger a crossfade).
      if (Date.now() < this._xfGraceUntil) return;
      state.positionSec = positionSec;
      if (durationSec) state.durationSec = durationSec;
      AudioUI.updateProgressOnly();
      this._applySleepFadeIfDue();
      AudioFeatures.emit('progress', { positionSec: state.positionSec, durationSec: state.durationSec });
    },

    // Called by window.onNativeAudioSkipNext/Previous — the
    // notification's Next/Previous buttons arrive here, forwarded from
    // PlaybackService's QueueAwarePlayer (see PlaybackService.kt), NOT
    // through MainActivity's own MediaController. Same intent as the
    // in-app next/prev buttons, just a different origin.
    onSkipNext() {
      const next = PlaybackQueue.advance();
      if (next) this.play(next); else AudioUI.render();
    },
    onSkipPrevious() {
      const prev = PlaybackQueue.previous();
      if (prev) this.play(prev); else AudioUI.render();
    },

    /* Crossfade, native side. AndroidBridge.nativeAudioCrossfade() hands the
     * next file to PlaybackService, which starts it on a second ExoPlayer,
     * ramps the two against each other and makes the new one the session's
     * player (see NativeCrossfade.kt). The native call ALWAYS ends with the
     * next track playing: if it can't overlap (e.g. the old track has almost
     * no time left) it simply cuts over, so the app never ends up with its
     * state pointing at a track that isn't playing. Everything is timed
     * natively — nothing here relies on JS timers, which a backgrounded
     * WebView may pause.
     *
     * Returns false (and does nothing) when the installed native side
     * predates this method, so an older host just keeps the normal gap. */
    beginCrossfade(nextId, seconds) {
      const bridge = this._bridge();
      if (!bridge || typeof bridge.nativeAudioCrossfade !== 'function') return false;
      if (!state.playing) return false;
      const track = MediaLibrary.getTrack(nextId);
      if (!track) return false;
      return switchForCrossfade(nextId, (outGain, inGain) => {
        this._pendingSeek = null;
        state.handoffPositionSec = null;
        this._loadedTrackId = nextId;
        this._xfGraceUntil = Date.now() + 1500;
        try {
          bridge.nativeAudioCrossfade(track.path, track.title || '', track.artist || '',
            track.album || '', seconds, outGain, inGain);
        } catch (e) {
          // The bridge call itself failed: fall back to an ordinary start of the next track.
          console.error('native crossfade failed', e);
          this._xfGraceUntil = 0;
          this._loadedTrackId = null;
          this.play(nextId);
          return;
        }
        this._scheduleStateCheck();
      });
    },

    onTrackEnded() {
      if (Date.now() < this._xfGraceUntil) return; // the old track's end, already handled by the crossfade
      handleTrackEnded(this);
    },
    onError(message) {
      // Force the next play() to reload the item rather than assume the
      // native side still has a usable one.
      this._loadedTrackId = null;
      handleError(this, message);
    },

    /* Same fade behaviour as LocalAudioEngine, applied by repeatedly
     * nudging the native volume down across the last ~20s instead of an
     * <audio> element's .volume. */
    _applySleepFadeIfDue() {
      if (!state.sleepTimerDeadline || state.sleepTimerMinutes <= 0) return;
      const remainingMs = state.sleepTimerDeadline - Date.now();
      const bridge = this._bridge();

      if (remainingMs <= 0) {
        if (bridge) bridge.nativeAudioSetVolume(gain()); // restore for next time
        this.pause();
        AudioUI.setSleepTimer(0);
        return;
      }

      const FADE_WINDOW_MS = 20000;
      if (remainingMs <= FADE_WINDOW_MS && bridge) {
        bridge.nativeAudioSetVolume(gain() * (remainingMs / FADE_WINDOW_MS));
      }
    },
  };

  // The engine everything else in this file actually talks to. Starts
  // local; NovelAudio._switchToNative() below repoints this at
  // NativeAudioEngine once the native side is ready. Because this is a
  // `let` at module scope, every arrow-function handler elsewhere that
  // reads `AudioEngine` picks up the reassignment automatically — they
  // look it up at call time, not at the time the handler was defined.
  let AudioEngine = LocalAudioEngine;

  /* =======================================================================
     7. PREFERENCES
     ======================================================================= */

  const Prefs = {
    load() {
      try {
        const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        if (typeof saved.volume === 'number') state.volume = saved.volume;
        state.speed = 1.0; // speed control removed: always normal speed
        if (typeof saved.shuffle === 'boolean') state.shuffle = saved.shuffle;
        if (typeof saved.repeat === 'string') state.repeat = saved.repeat;
        if (typeof saved.activePlaylist === 'string') state.activePlaylist = saved.activePlaylist;
        if (Array.isArray(saved.eqBands) && saved.eqBands.length === EQ_BAND_HZ.length) {
          state.eqBands = saved.eqBands.slice();
        }
        if (typeof saved.eqPreampDb === 'number') state.eqPreampDb = saved.eqPreampDb;
        AudioFeatures.restore(saved.features);
      } catch (e) { /* corrupt prefs are not worth crashing over */ }
    },

    save() {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
          volume: state.volume,
          speed: state.speed,
          shuffle: state.shuffle,
          repeat: state.repeat,
          activePlaylist: state.activePlaylist,
          eqBands: state.eqBands,
          eqPreampDb: state.eqPreampDb,
          features: AudioFeatures.serialize(),
        }));
      } catch (e) { /* storage full — non-fatal */ }
    },
  };

  /* =======================================================================
     7b. AUDIO FEATURES FRAMEWORK
     =======================================================================
     One place for the optional audio features (see README → "Audio feature
     framework"). The core engines/queue stay feature-agnostic: they only
     announce what happened, and feature modules react.

     A MODULE is a plain object registered with AudioFeatures.register():

       {
         id: 'abRepeat',                 // unique; also the key in state.features
         label: 'A-B repeat',
         status: 'working' | 'logic-ready' | 'framework' | 'stub' | 'planned',
         defaults: { ... },              // initial per-feature state
         persistKeys: ['a', 'b'],        // optional: only these keys are saved
                                         //   (omit = save everything, [] = save nothing)
         // Any of these hooks, all optional, all wrapped in try/catch so a
         // broken feature can never stall playback:
         trackStart(track)  trackEnd(track)  progress({positionSec, durationSec})
         engineChanged(engine)  libraryChanged()
         outputGain(track)  -> linear multiplier (<= 1) folded into gain()
       }

     Per-feature state lives in state.features[id], is saved inside the
     existing audio prefs blob (so settings.txt mirrors it for free), and is
     restored through the same Prefs.load() path. Modules are also reachable
     as NovelAudio.features.<id> for the UI and for debugging.

     "status" is honest bookkeeping, not marketing:
       working      — behaviour and UI both exist
       logic-ready  — behaviour works through the JS API, no UI control yet
       framework    — plumbing exists; needs data or native support to do anything
       stub         — stores a value; nothing consumes it yet
       planned      — hook points exist; the behaviour itself isn't written
  ======================================================================= */

  const AudioFeatures = {
    _modules: {},
    _order: [],

    register(mod) {
      this._modules[mod.id] = mod;
      this._order.push(mod.id);
      this[mod.id] = mod;                      // NovelAudio.features.<id>
      state.features[mod.id] = JSON.parse(JSON.stringify(mod.defaults || {}));   // deep copy: arrays must not be shared with the defaults
      return mod;
    },

    // Per-feature state object (shared by reference with state.features).
    st(id) { return state.features[id]; },

    emit(name, payload) {
      for (const id of this._order) {
        const mod = this._modules[id];
        if (!mod || typeof mod[name] !== 'function') continue;
        try { mod[name](payload); } catch (e) { console.error('[audio feature ' + id + '] ' + name + ' failed', e); }
      }
    },

    // Product of every module's outputGain(); always a finite number in (0, 1].
    outputGain() {
      let g = 1;
      let track;                                 // looked up lazily: gain() runs several times a second
      for (const id of this._order) {
        const mod = this._modules[id];
        if (!mod || typeof mod.outputGain !== 'function') continue;
        try {
          if (track === undefined) track = MediaLibrary.getTrack(state.currentTrackId);
          const v = mod.outputGain(track);
          if (typeof v === 'number' && isFinite(v) && v > 0) g *= Math.min(1, v);
        } catch (e) { /* a bad module must not silence playback */ }
      }
      return g;
    },

    // Re-apply the current output level to whichever engine is live — for
    // when a feature changes the gain without the user touching the slider.
    refreshGain() {
      try {
        if (AudioEngine === LocalAudioEngine) {
          LocalAudioEngine._applyVolume();
        } else {
          const b = window.AndroidBridge;
          if (b && b.nativeAudioSetVolume) b.nativeAudioSetVolume(gain());
          this.nativeEffects.pushBoost();
        }
      } catch (e) { console.error('refreshGain failed', e); }
    },

    // Called from Prefs.load(): merge saved values over the defaults, but
    // only keys the module declares and only if the type still matches, so
    // an old or hand-edited settings file can't inject junk.
    restore(saved) {
      if (!saved || typeof saved !== 'object') return;
      for (const id of this._order) {
        const mod = this._modules[id];
        const src = saved[id];
        if (!mod || !src || typeof src !== 'object') continue;
        const target = state.features[id];
        Object.keys(mod.defaults || {}).forEach(k => {
          if (!(k in src)) return;
          const want = mod.defaults[k];
          const ok = Array.isArray(want) ? Array.isArray(src[k])
                   : want === null ? true
                   : typeof src[k] === typeof want;
          if (ok) target[k] = src[k];
        });
      }
    },

    // Called from Prefs.save().
    serialize() {
      const out = {};
      for (const id of this._order) {
        const mod = this._modules[id];
        const st = state.features[id];
        const keys = mod.persistKeys || Object.keys(st);
        if (!keys.length) continue;
        out[id] = {};
        keys.forEach(k => { out[id][k] = st[k]; });
      }
      return out;
    },

    // Who is who and how finished — for the README, a future "about audio"
    // screen, or the console: NovelAudio.features.describe()
    describe() {
      return this._order.map(id => ({ id, label: this._modules[id].label, status: this._modules[id].status }));
    },

    /* Virtual playlists: state.activePlaylist may be '@recent', '@liked' or
     * '@list:<id>' as well as 'all' / a folder name. Returns the track ids
     * for such a name, or null when `name` isn't virtual. Ids that are no
     * longer in the library are dropped, so a deleted file never ends up
     * in a queue. */
    selectionFor(name) {
      if (typeof name !== 'string' || name.charAt(0) !== '@') return null;
      let ids = null;
      if (name === '@recent') ids = this.history.getIds();
      else if (name === '@liked') ids = this.likes.getIds();
      else if (name.indexOf('@list:') === 0) ids = this.customPlaylists.getIds(name.slice(6));
      if (!ids) return null;
      const known = new Set(state.tracks.map(t => t.id));
      return ids.filter(id => known.has(id));
    },

    // For a future playlist picker: every virtual playlist worth listing.
    listVirtualPlaylists() {
      const out = [];
      const add = (id, label) => out.push({ id, label, count: (this.selectionFor(id) || []).length });
      add('@recent', 'Recently played');
      add('@liked', 'Liked');
      this.customPlaylists.list().forEach(p => add('@list:' + p.id, p.name));
      return out.filter(p => p.count > 0 || p.id.indexOf('@list:') === 0);
    },
  };

  /* ---- A-B repeat -------------------------------------------------------
     Loops the section between two points of the current track. Works on
     both engines through AudioEngine.seek(). Resolution is the engine's
     progress rate (~4 Hz local, ~2 Hz native), so the loop can overshoot B
     by up to half a second; a frame-accurate loop would need a native
     ClippingMediaSource. Cleared whenever a new track starts. UI: the A / B
     buttons under the seek bar. */
  AudioFeatures.register({
    id: 'abRepeat', label: 'A-B repeat', status: 'working',
    defaults: { a: null, b: null },
    persistKeys: [],
    trackStart() { const s = state.features.abRepeat; s.a = null; s.b = null; },
    progress(p) {
      const s = state.features.abRepeat;
      if (s.a === null || s.b === null) return;
      if (p.positionSec >= s.b) AudioEngine.seek(s.a);
    },
    setA() {
      const s = state.features.abRepeat;
      s.a = state.positionSec;
      if (s.b !== null && s.b <= s.a + 0.5) s.b = null;
      return s.a;
    },
    setB() {
      const s = state.features.abRepeat;
      if (s.a === null || state.positionSec < s.a + 0.5) return null; // B must come after A
      s.b = state.positionSec;
      return s.b;
    },
    clear() { const s = state.features.abRepeat; s.a = null; s.b = null; },
    isActive() { const s = state.features.abRepeat; return s.a !== null && s.b !== null; },
    get() { const s = state.features.abRepeat; return { a: s.a, b: s.b }; },
  });

  /* ---- Replay gain (volume normalisation) -------------------------------
     Reads `replayGainTrackDb` / `replayGainAlbumDb` and the peaks
     `replayGainPeak` (track) / `replayGainAlbumPeak` off the track object.
     MainActivity.listAudioFiles() fills those in from the file's own tags
     (ReplayGainReader.kt: ID3 TXXX, APEv2, Vorbis comments, Opus R128, MP4
     free-form atoms). A track with no tag is left alone.
     Modes: 'off' | 'track' | 'album'. 'track' uses the track gain (falling
     back to the album gain if only that exists); 'album' uses the album gain
     (falling back to the track gain), which keeps an album's own dynamics.
     Cuts (negative dB) are applied in JS through gain(); boosts (positive dB)
     are passed to the native LoudnessEnhancer, since a WebView <audio>
     element can't exceed 1.0. With `preventClipping` on, the result is
     limited so the track's peak never goes past full scale. */
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  AudioFeatures.register({
    id: 'replayGain', label: 'Volume normalisation (replay gain)', status: 'working',
    defaults: { mode: 'off', preventClipping: true },     // mode: 'off' | 'track' | 'album'
    _pick(track) {
      const s = state.features.replayGain;
      const t = track.replayGainTrackDb, a = track.replayGainAlbumDb;
      const wantAlbum = s.mode === 'album';
      const useAlbum = wantAlbum ? isNum(a) : !isNum(t) && isNum(a);
      const db = useAlbum ? a : (isNum(t) ? t : null);
      let peak = useAlbum ? track.replayGainAlbumPeak : track.replayGainPeak;
      if (!isNum(peak) || peak <= 0) peak = useAlbum ? track.replayGainPeak : track.replayGainAlbumPeak;
      return { db, peak: isNum(peak) && peak > 0 ? peak : null };
    },
    _db(track) {
      const s = state.features.replayGain;
      if (!track || s.mode === 'off') return 0;
      const pick = this._pick(track);
      if (pick.db === null) return 0;
      let db = pick.db;
      if (s.preventClipping && pick.peak !== null) {
        db = Math.min(db, -20 * Math.log10(pick.peak)); // never push the peak past full scale
      }
      return Math.max(-24, Math.min(12, db));
    },
    outputGain(track) { const db = this._db(track); return db < 0 ? Math.pow(10, db / 20) : 1; },
    boostDb(track) { const db = this._db(track); return db > 0 ? db : 0; },
    // For the UI: null = nothing to show (off / no track), otherwise
    // { tagged, db } where db is the adjustment actually being asked for.
    describe(track) {
      if (!track || state.features.replayGain.mode === 'off') return null;
      const pick = this._pick(track);
      return { tagged: pick.db !== null, db: this._db(track) };
    },
    trackStart() { AudioFeatures.refreshGain(); },
    setMode(mode) {
      if (mode !== 'off' && mode !== 'track' && mode !== 'album') return;
      state.features.replayGain.mode = mode;
      Prefs.save();
      AudioFeatures.refreshGain();
    },
  });

  /* ---- Crossfade ----------------------------------------------------------
     Overlaps the end of one track with the start of the next: the old one
     fades out while the new one fades in. 0 = off (the default); 1–12 s.
     UI: the Crossfade slider in the 🎧 panel.

     This module only decides WHEN. When `seconds` > 0 and the playing track
     is within that window of its end, it calls the live engine's
     beginCrossfade(nextTrackId, seconds); each engine does the audio:
       LocalAudioEngine   a second <audio> element + two timed volume ramps
       NativeAudioEngine  a second ExoPlayer in PlaybackService
                          (AndroidBridge.nativeAudioCrossfade, NativeCrossfade.kt)
     beginCrossfade returns true once it has taken over. If it returns false
     (cannot crossfade right now) the module asks again on the next
     progress tick, so a crossfade that was refused because the previous one
     was still running starts a moment later, and a track that never gets to
     crossfade just ends and the next one starts the normal way.

     The window is `seconds + LEAD`, because progress arrives only ~2 times a
     second (native); the engine shortens the fade to whatever really remains.
     Not used when: repeat-one is on, "stop at end of track" sleep mode is on,
     an A-B loop is set, a timed sleep ends inside the fade, or a track is
     too short — a track under 2× the setting crossfades over half its
     length instead. The fade curve is equal-power (see curve()). */
  AudioFeatures.register({
    id: 'crossfade', label: 'Crossfade', status: 'working',
    defaults: { seconds: 0 },
    LEAD: 0.5,
    _armedFor: null,           // track already handed to an engine that gave no answer: ask only once
    trackStart() { this._armedFor = null; },
    // Equal-power fade: for t = 0..1 (0 = start of the overlap) the outgoing
    // track is at `out` and the incoming at `inn`. out² + inn² = 1, so the
    // combined loudness stays flat; a linear fade would dip ~3 dB mid-way.
    curve(t) {
      const a = (t > 1 ? 1 : t > 0 ? t : 0) * Math.PI / 2;
      return { out: Math.cos(a), inn: Math.sin(a) };
    },
    progress(p) {
      const s = state.features.crossfade;
      if (!s.seconds || typeof AudioEngine.beginCrossfade !== 'function') return;
      if (this._armedFor === state.currentTrackId) return;
      if (!(p.durationSec > 0) || !state.playing) return;
      if (state.repeat === 'one' || state.sleepTimerMinutes === -1) return;
      if (AudioFeatures.abRepeat.isActive()) return;
      const sec = Math.min(s.seconds, p.durationSec / 2);
      const remaining = p.durationSec - p.positionSec;
      if (remaining <= 0 || remaining > sec + this.LEAD) return;
      // A timed sleep that would end (or start its own 20 s fade-out) inside the overlap.
      if (state.sleepTimerMinutes > 0 && state.sleepTimerDeadline &&
          state.sleepTimerDeadline - Date.now() < (sec + 20) * 1000) return;
      const next = PlaybackQueue.peekNext();
      if (!next) return;
      // On success the new track becomes current, so there is nothing to arm. An
      // explicit `false` means "not now" and is asked again on the next tick; any
      // other answer from an engine that did not switch tracks counts as handled.
      const cur = state.currentTrackId;
      const result = AudioEngine.beginCrossfade(next, sec);
      if (result !== false && state.currentTrackId === cur) this._armedFor = cur;
    },
    setSeconds(sec) {
      const v = Number(sec);
      if (!isFinite(v)) return;
      state.features.crossfade.seconds = Math.max(0, Math.min(12, Math.round(v)));
      Prefs.save();
    },
  });

  /* ---- Recently played ----------------------------------------------------
     Newest-first list of track ids, capped. Recorded when a track starts.
     Selectable as the virtual playlist '@recent'. */
  AudioFeatures.register({
    id: 'history', label: 'Recently played', status: 'working',
    defaults: { ids: [] },
    MAX: 100,
    trackStart(track) {
      if (!track) return;
      const s = state.features.history;
      s.ids = [track.id].concat(s.ids.filter(id => id !== track.id)).slice(0, this.MAX);
      Prefs.save();
    },
    getIds() { return state.features.history.ids.slice(); },
    clear() { state.features.history.ids = []; Prefs.save(); },
  });

  /* ---- Liked tracks ---------------------------------------------------------
     A set of track ids (stored as an array). Virtual playlist '@liked'.
     toggle() with no argument acts on the track that is playing. */
  AudioFeatures.register({
    id: 'likes', label: 'Liked tracks', status: 'working',
    defaults: { ids: [] },
    getIds() { return state.features.likes.ids.slice(); },
    isLiked(id) { return state.features.likes.ids.indexOf(id || state.currentTrackId) !== -1; },
    toggle(id) {
      const target = id || state.currentTrackId;
      if (!target) return false;
      const s = state.features.likes;
      const i = s.ids.indexOf(target);
      if (i === -1) s.ids.push(target); else s.ids.splice(i, 1);
      Prefs.save();
      return i === -1;               // true = now liked
    },
  });

  /* ---- Curated playlists --------------------------------------------------
     Hand-picked lists that don't depend on folders. Each is { id, name,
     ids[] }. Selectable as '@list:<id>'. Pure data + CRUD; the UI is the
     picker (select / delete) and the "add to playlist" button on the
     now-playing card. */
  AudioFeatures.register({
    id: 'customPlaylists', label: 'Curated playlists', status: 'working',
    defaults: { lists: [], nextId: 1 },
    list() { return state.features.customPlaylists.lists.map(p => ({ id: p.id, name: p.name, count: p.ids.length })); },
    getIds(id) { const p = this._find(id); return p ? p.ids.slice() : null; },
    _find(id) { return state.features.customPlaylists.lists.find(p => String(p.id) === String(id)) || null; },
    create(name, ids) {
      const s = state.features.customPlaylists;
      const clean = String(name || '').trim().slice(0, 60);
      if (!clean) return null;
      const p = { id: s.nextId++, name: clean, ids: Array.isArray(ids) ? ids.slice() : [] };
      s.lists.push(p);
      Prefs.save();
      return p.id;
    },
    rename(id, name) {
      const p = this._find(id), clean = String(name || '').trim().slice(0, 60);
      if (!p || !clean) return false;
      p.name = clean; Prefs.save(); return true;
    },
    remove(id) {
      const s = state.features.customPlaylists, n = s.lists.length;
      s.lists = s.lists.filter(p => String(p.id) !== String(id));
      if (s.lists.length === n) return false;
      if (state.activePlaylist === '@list:' + id) state.activePlaylist = 'all';
      Prefs.save(); return true;
    },
    addTracks(id, trackIds) {
      const p = this._find(id);
      if (!p) return false;
      (trackIds || []).forEach(t => { if (p.ids.indexOf(t) === -1) p.ids.push(t); });
      Prefs.save(); return true;
    },
    removeTrack(id, trackId) {
      const p = this._find(id);
      if (!p) return false;
      p.ids = p.ids.filter(t => t !== trackId);
      Prefs.save(); return true;
    },
  });

  /* ---- Native effects (equalizer + replay-gain boost) --------------------------
     Bridges the UI's 10 EQ sliders to android.media.audiofx.Equalizer on
     ExoPlayer's audio session, so the EQ is audible for background playback
     too (see NativeAudioEffects.kt — the device's own band layout is
     interpolated from our 10 bands there). The state stays in state.eqBands
     / state.eqPreampDb, shared with the Web Audio EQ, so switching engines
     keeps the same curve. */
  AudioFeatures.register({
    id: 'nativeEffects', label: 'Native equalizer', status: 'framework',
    defaults: {},
    persistKeys: [],
    info: null,                                    // set by window.onNativeAudioEffectsInfo
    _bridge() { return window.AndroidBridge || null; },
    supported() { const b = this._bridge(); return !!(b && b.nativeAudioSetEqualizer); },
    requestInfo() {
      const b = this._bridge();
      if (b && b.nativeAudioEffectsRequestInfo) { try { b.nativeAudioEffectsRequestInfo(); } catch (e) { /* ignore */ } }
    },
    // Push the current curve. Returns true when the call was made.
    apply() {
      const b = this._bridge();
      if (!b || !b.nativeAudioSetEqualizer) return false;
      try { b.nativeAudioSetEqualizer(JSON.stringify(state.eqBands), state.eqPreampDb); return true; }
      catch (e) { console.error('native EQ apply failed', e); return false; }
    },
    pushBoost() {
      const b = this._bridge();
      if (!b || !b.nativeAudioSetBoostDb) return;
      const db = AudioFeatures.replayGain.boostDb(MediaLibrary.getTrack(state.currentTrackId));
      try { b.nativeAudioSetBoostDb(db); } catch (e) { /* ignore */ }
    },
    engineChanged(engine) { if (engine === NativeAudioEngine) { this.requestInfo(); this.apply(); this.pushBoost(); } },
    trackStart() { if (AudioEngine === NativeAudioEngine) { this.apply(); this.pushBoost(); } },
    onInfo(info) {
      this.info = info || null;
      if (this.info && this.info.available === false && AudioEngine === NativeAudioEngine) {
        AudioUI.setNote('This device doesn\u2019t offer an equalizer for background playback.');
      }
    },
  });

  /* =======================================================================
     8. UI
     =======================================================================
     Pure render: reads `state`, writes the DOM. Every handler dispatches
     an intent to the modules above (via the current `AudioEngine`) and
     lets the resulting render update the screen.
  ======================================================================= */

  const els = {};

  /* Cover art: the native side extracts embedded album art (or a
     cover/folder image next to the file) and returns it as a small
     data: URI; cached here per track so each is only fetched once. */
  const artCache = {};
  let queueRenderKey = null;
  let artShownFor = null;
  function updateArtwork(track) {
    if (!els.artwork) return;
    const id = track ? track.id : null;
    if (id === artShownFor) return;
    artShownFor = id;
    let uri = '';
    if (track) {
      if (artCache[id] === undefined) {
        const b = window.AndroidBridge;
        try { artCache[id] = (b && b.getArtwork) ? (b.getArtwork(track.path) || '') : ''; }
        catch (e) { artCache[id] = ''; }
      }
      uri = artCache[id];
    }
    els.artwork.innerHTML = uri
      ? '<img alt="" src="' + uri + '">'
      : '<svg class="ico"><use href="#i-moon-music"/></svg>';
    els.artwork.classList.toggle('has-art', !!uri);
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function formatBandLabel(hz) {
    return hz >= 1000 ? (hz / 1000) + 'k' : String(hz);
  }

  // Keeps a range input's amber fill (--pct, see index.html) in sync
  // whenever its value is set from code rather than dragged by the user.
  function syncSliderFill(el) {
    if (!el) return;
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max) || 100;
    const val = parseFloat(el.value) || 0;
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--pct', Math.max(0, Math.min(100, pct)) + '%');
  }

  // Human label for any playlist selection: 'all', a folder name, or a
  // virtual '@recent' / '@liked' / '@list:<id>'.
  function playlistLabel(name) {
    if (name === 'all') return 'All songs';
    if (name === '@recent') return 'Recently played';
    if (name === '@liked') return 'Liked';
    if (typeof name === 'string' && name.indexOf('@list:') === 0) {
      const l = AudioFeatures.customPlaylists.list().find(x => String(x.id) === name.slice(6));
      return l ? l.name : 'Playlist';
    }
    return name;
  }

  const AudioUI = {
    cacheElements() {
      els.panel = document.getElementById('audio-panel');
      els.topBtn = document.getElementById('audio-toggle-top');
      els.sideBtn = document.getElementById('audio-toggle');
      els.scanBtn = document.getElementById('audio-scan-btn');
      els.artwork = document.getElementById('audio-artwork');
      els.npTitle = document.getElementById('audio-np-title');
      els.npArtist = document.getElementById('audio-np-artist');
      els.elapsed = document.getElementById('audio-elapsed');
      els.duration = document.getElementById('audio-duration');
      els.seek = document.getElementById('audio-seek');
      els.playBtn = document.getElementById('audio-play-btn');
      els.prevBtn = document.getElementById('audio-prev-btn');
      els.nextBtn = document.getElementById('audio-next-btn');
      els.shuffleBtn = document.getElementById('audio-shuffle-btn');
      els.repeatBtn = document.getElementById('audio-repeat-btn');
      els.volume = document.getElementById('audio-volume');
      els.volumeValue = document.getElementById('audio-volume-value');
      els.sleep = document.getElementById('audio-sleep');
      els.rgMode = document.getElementById('audio-rg-mode');
      els.rgValue = document.getElementById('audio-rg-value');
      els.xf = document.getElementById('audio-xf');
      els.xfValue = document.getElementById('audio-xf-value');
      els.queue = document.getElementById('audio-queue');
      els.empty = document.getElementById('audio-empty');
      els.note = document.getElementById('audio-status-note');
      els.eqToggle = document.getElementById('audio-eq-toggle');
      els.eqPanel = document.getElementById('audio-eq-panel');
      els.eqBands = document.getElementById('audio-eq-bands');
      els.eqPreamp = document.getElementById('audio-eq-preamp');
      els.eqReset = document.getElementById('audio-eq-reset');
      els.playlistRow = document.getElementById('audio-playlist-row');
      els.playlistBtn = document.getElementById('audio-playlist-btn');
      els.playlistBtnLabel = document.getElementById('audio-playlist-btn-label');
      els.playlistBtnCount = document.getElementById('audio-playlist-btn-count');
      els.likeBtn = document.getElementById('audio-like-btn');
      els.addtoBtn = document.getElementById('audio-addto-btn');
      els.addtoList = document.getElementById('audio-addto-list');
      els.abRow = document.getElementById('audio-ab-row');
      els.abA = document.getElementById('audio-ab-a');
      els.abB = document.getElementById('audio-ab-b');
      els.abClear = document.getElementById('audio-ab-clear');
      els.abReadout = document.getElementById('audio-ab-readout');
      els.newRow = document.getElementById('audio-newlist-row');
      els.newInput = document.getElementById('audio-newlist-input');
      els.newSave = document.getElementById('audio-newlist-save');
      els.playlistList = document.getElementById('audio-playlist-list');
    },

    bindEvents() {
      els.scanBtn.addEventListener('click', () => MediaLibrary.scan());

      // Expands/collapses the inline playlist list in place (see the
      // #audio-playlist-list CSS comment for why this replaced a
      // separate floating menu). Nothing here ever rebuilds the list's
      // own DOM as a result of a click on one of its items — that's
      // handled once, in renderPlaylistOptions(), on open only.
      // Swipe left/right on the playlist button to jump to the next or
      // previous playlist without opening the list. A swipe also swallows
      // the click that follows it so it doesn't toggle the list.
      let plSwipeX = 0, plSwipeY = 0, plSwiping = false, plSwiped = false;
      els.playlistBtn.addEventListener('pointerdown', (e) => {
        plSwipeX = e.clientX; plSwipeY = e.clientY; plSwiping = true; plSwiped = false;
      });
      els.playlistBtn.addEventListener('pointermove', (e) => {
        if (!plSwiping || plSwiped) return;
        const dx = e.clientX - plSwipeX, dy = e.clientY - plSwipeY;
        if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          plSwiped = true;
          AudioUI.stepPlaylist(dx < 0 ? 1 : -1);
        }
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
        els.playlistBtn.addEventListener(ev, () => { plSwiping = false; }));

      els.playlistBtn.addEventListener('click', () => {
        if (plSwiped) { plSwiped = false; return; }
        if (els.playlistBtn.getAttribute('aria-expanded') === 'true') AudioUI.closePlaylistList();
        else AudioUI.openPlaylistList();
      });

      els.playBtn.addEventListener('click', () => AudioEngine.toggle());

      els.nextBtn.addEventListener('click', () => {
        const next = PlaybackQueue.advance();
        if (next) AudioEngine.play(next);
        else AudioUI.render();
      });

      els.prevBtn.addEventListener('click', () => {
        const prev = PlaybackQueue.previous();
        if (prev) AudioEngine.play(prev);
        else AudioUI.render();
      });

      els.shuffleBtn.addEventListener('click', () => {
        PlaybackQueue.setShuffle(!state.shuffle);
        Prefs.save();
      });

      els.repeatBtn.addEventListener('click', () => {
        PlaybackQueue.cycleRepeat();
        Prefs.save();
      });

      els.volume.addEventListener('input', () => {
        AudioEngine.setVolume(parseInt(els.volume.value, 10) / 100);
        syncSliderFill(els.volume);
      });

      if (els.rgMode) {
        els.rgMode.addEventListener('change', () => {
          AudioFeatures.replayGain.setMode(els.rgMode.value);
          AudioUI.render();
        });
      }

      if (els.xf) {
        els.xf.addEventListener('input', () => {
          AudioFeatures.crossfade.setSeconds(parseInt(els.xf.value, 10));
          syncSliderFill(els.xf);
          els.xfValue.textContent = AudioUI.crossfadeLabel();
        });
      }

      els.sleep.addEventListener('change', () => {
        AudioUI.setSleepTimer(parseInt(els.sleep.value, 10));
      });

      els.seek.addEventListener('input', () => {
        syncSliderFill(els.seek);
        if (!state.durationSec) return;
        AudioEngine.seek((parseInt(els.seek.value, 10) / 1000) * state.durationSec);
      });

      // Like / add to playlist (now-playing card).
      if (els.likeBtn) {
        els.likeBtn.addEventListener('click', () => {
          if (!state.currentTrackId) return;
          AudioFeatures.likes.toggle();
          AudioUI.render();
          if (navigator.vibrate) navigator.vibrate(8);
        });
      }
      if (els.addtoBtn) {
        els.addtoBtn.addEventListener('click', () => {
          if (!state.currentTrackId) return;
          if (!els.addtoList.classList.contains('hidden')) AudioUI.closeAddTo();
          else AudioUI.openAddTo();
        });
      }

      // A-B repeat.
      if (els.abA) {
        els.abA.addEventListener('click', () => {
          if (!state.currentTrackId) return;
          AudioFeatures.abRepeat.setA();
          AudioUI.render();
        });
        els.abB.addEventListener('click', () => {
          if (!state.currentTrackId) return;
          if (AudioFeatures.abRepeat.setB() === null) {
            AudioUI.setNote('Set A first, then tap B further along in the track.');
          } else {
            AudioUI.setNote('');
          }
          AudioUI.render();
        });
        els.abClear.addEventListener('click', () => {
          AudioFeatures.abRepeat.clear();
          AudioUI.setNote('');
          AudioUI.render();
        });
      }

      // New playlist name entry.
      if (els.newSave) {
        els.newSave.addEventListener('click', () => AudioUI._createList());
        els.newInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); AudioUI._createList(); }
        });
      }

      els.queue.addEventListener('click', (e) => {
        const li = e.target.closest('li[data-track-id]');
        if (!li) return;
        const next = PlaybackQueue.jumpTo(li.dataset.trackId);
        if (next) AudioEngine.play(next);
      });

      els.eqToggle.addEventListener('click', () => {
        const nowHidden = els.eqPanel.classList.toggle('hidden');
        els.eqToggle.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
      });

      // One delegated listener for all 10 band sliders, rather than 10
      // separate bindings — each slider's index lives in its own
      // data-band-index attribute (see buildEqSliders()).
      els.eqBands.addEventListener('input', (e) => {
        const slider = e.target.closest('input[data-band-index]');
        if (!slider) return;
        const bands = state.eqBands.slice();
        bands[parseInt(slider.dataset.bandIndex, 10)] = parseFloat(slider.value);
        syncSliderFill(slider);
        AudioEngine.setEqualizer(bands);
        AudioUI.updateEqReadouts();
      });

      els.eqPreamp.addEventListener('input', () => {
        syncSliderFill(els.eqPreamp);
        AudioEngine.setPreamp(parseFloat(els.eqPreamp.value));
        AudioUI.updateEqReadouts();
      });

      els.eqReset.addEventListener('click', () => {
        AudioEngine.setEqualizer(EQ_BAND_HZ.map(() => 0));
        AudioEngine.setPreamp(0);
        AudioUI.buildEqSliders();
      });

      AudioUI.buildEqSliders();
      AudioUI.renderPlaylistOptions();
    },

    /* Populates the playlist <select> from the current library, and
     * shows/hides the whole row — a library with no playlist subfolders
     * shouldn't show a picker with nothing to pick between. Rebuilt in
     * full each time (unlike the EQ sliders) since a <select> isn't
     * mid-drag state a rebuild could disrupt. */
    // Applies a playlist selection: rebuilds the queue from it, keeping
    // whatever's currently playing at its place in the new queue if it's
    // still in it (switching to a playlist that still contains what's
    // playing shouldn't interrupt it). Called from the playlist list
    // item's own click handler (see renderPlaylistOptions() below) —
    // critically, this must NOT rebuild #audio-playlist-list's DOM
    // (e.g. via innerHTML = '' or removing/re-adding <li> elements)
    // synchronously here, since that was the root cause of the
    // "selecting a playlist closes the whole panel" bug: destroying the
    // very <li> that's still mid-click detaches it from the document
    // before the click finishes bubbling, so document-level listeners
    // (closeOnOutsideClick in reader.js) see a target no longer inside
    // #audio-panel and close the panel as if the tap had landed outside
    // it entirely. Updating classes/text on the existing, still-attached
    // <li> elements (in _updatePlaylistSelectionUI below) avoids that
    // failure mode completely.
    selectPlaylist(name) {
      state.activePlaylist = name;
      Prefs.save();
      const currentId = state.currentTrackId;
      const ids = MediaLibrary.currentSelectionIds();
      PlaybackQueue.buildFrom(ids);
      if (currentId && ids.includes(currentId)) PlaybackQueue.jumpTo(currentId);
      AudioUI._updatePlaylistSelectionUI();
      AudioUI.render();
    },

    // Updates the playlist button's label and the list's active-row
    // highlight to match state.activePlaylist, WITHOUT touching the
    // list's DOM structure (no innerHTML, no add/removeChild) — safe to
    // call from inside a list item's own click handler. See the comment
    // on selectPlaylist() above for why that distinction matters.
    _updatePlaylistSelectionUI() {
      if (!els.playlistBtn) return;
      els.playlistBtnLabel.textContent = playlistLabel(state.activePlaylist);
      if (els.playlistBtnCount) {
        const n = MediaLibrary.currentSelectionIds().length;
        els.playlistBtnCount.textContent = n > 0 ? String(n) : '';
      }
      if (els.playlistList) {
        els.playlistList.querySelectorAll('li').forEach(li => {
          li.classList.toggle('active', li.dataset.playlistName === state.activePlaylist);
        });
      }
    },

    // Opens the playlist list with a staggered entrance. Rebuilds the rows
    // (safe: this runs from the button's click, never from a row's own
    // click) and parks the sliding highlight on the active row.
    openPlaylistList() {
      if (!els.playlistList) return;
      clearTimeout(AudioUI._plCloseT);
      AudioUI.renderPlaylistOptions();
      els.playlistList.classList.remove('hidden', 'closing');
      void els.playlistList.offsetHeight;
      els.playlistList.classList.add('open');
      els.playlistBtn.setAttribute('aria-expanded', 'true');
      AudioUI._movePlaylistIndicator(false);
      const active = els.playlistList.querySelector('li.active');
      if (active) els.playlistList.scrollTop = Math.max(0, active.offsetTop - 48);
    },

    // Fades the list out, then hides it.
    closePlaylistList() {
      if (!els.playlistList || els.playlistBtn.getAttribute('aria-expanded') !== 'true') return;
      els.playlistBtn.setAttribute('aria-expanded', 'false');
      els.playlistList.classList.remove('open');
      els.playlistList.classList.add('closing');
      clearTimeout(AudioUI._plCloseT);
      AudioUI._plCloseT = setTimeout(() => {
        els.playlistList.classList.add('hidden');
        els.playlistList.classList.remove('closing');
      }, 190);
    },

    // Slides the highlight pill (a CSS ::before on the list) to the active
    // row. animate=false snaps it there (used when the list opens).
    _movePlaylistIndicator(animate) {
      const list = els.playlistList;
      if (!list || list.classList.contains('hidden')) return;
      const li = list.querySelector('li.active');
      if (!li) { list.style.setProperty('--ind-o', '0'); return; }
      if (!animate) list.classList.add('no-ind-anim');
      list.style.setProperty('--ind-y', li.offsetTop + 'px');
      list.style.setProperty('--ind-h', li.offsetHeight + 'px');
      list.style.setProperty('--ind-o', '1');
      if (!animate) { void list.offsetHeight; list.classList.remove('no-ind-anim'); }
    },

    // Swipe on the playlist button: dir = +1 next, -1 previous. At either
    // end the button just gives a small nudge.
    stepPlaylist(dir) {
      const names = AudioUI._playlistNames();
      let i = names.indexOf(state.activePlaylist);
      if (i < 0) i = 0;
      const next = i + dir;
      const btn = els.playlistBtn;
      if (next < 0 || next >= names.length) {
        btn.classList.remove('pl-nudge-l', 'pl-nudge-r');
        void btn.offsetWidth;
        btn.classList.add(dir > 0 ? 'pl-nudge-l' : 'pl-nudge-r');
        return;
      }
      AudioUI.selectPlaylist(names[next]);
      AudioUI._movePlaylistIndicator(true);
      if (navigator.vibrate) navigator.vibrate(6);
      const lab = els.playlistBtnLabel;
      lab.classList.remove('pl-slide-next', 'pl-slide-prev');
      void lab.offsetWidth;
      lab.classList.add(dir > 0 ? 'pl-slide-next' : 'pl-slide-prev');
    },

    // Rebuilds the playlist list's DOM from scratch — only ever called
    // when the list is being opened (see the click handler in
    // bindEvents()), never as a side effect of selecting an item, so
    // there's no click still bubbling through a node this is about to
    // remove.
    // Every selectable playlist, in picker order: All songs, folder
    // playlists, then the virtual ones (recently played, liked, curated).
    _playlistNames() {
      const out = ['all', ...MediaLibrary.getPlaylists(), '@recent', '@liked'];
      AudioFeatures.customPlaylists.list().forEach(p => out.push('@list:' + p.id));
      return out;
    },

    _playlistCount(name) {
      if (name === 'all') return state.tracks.length;
      const v = AudioFeatures.selectionFor(name);
      return v ? v.length : MediaLibrary.tracksInPlaylist(name).length;
    },

    renderPlaylistOptions() {
      if (!els.playlistBtn) return;

      const folders = MediaLibrary.getPlaylists();

      // If the previously-active playlist no longer exists (folder
      // renamed/removed, curated list deleted), fall back to "All songs"
      // rather than silently showing an empty queue. Skipped before the
      // first scan of a session (state.tracks still empty) — we don't know
      // yet whether a restored preference is valid, and guessing "invalid"
      // would overwrite it with 'all' before the library had loaded.
      if (state.tracks.length > 0) {
        const a = state.activePlaylist;
        const stillValid = a === 'all' || folders.includes(a) || AudioFeatures.selectionFor(a) !== null;
        if (!stillValid) state.activePlaylist = 'all';
      }

      const names = AudioUI._playlistNames();
      const currentTrack = state.tracks.find(t => t.id === state.currentTrackId) || null;

      els.playlistList.innerHTML = '';
      names.forEach((name, i) => {
        const virtual = name.charAt(0) === '@';
        const li = document.createElement('li');
        li.dataset.playlistName = name;
        li.style.setProperty('--i', String(i));
        if (virtual) li.classList.add('pl-virtual');
        if (name === '@recent') li.classList.add('pl-first-virtual');

        const label = document.createElement('span');
        label.className = 'pl-name';
        label.textContent = playlistLabel(name);
        li.appendChild(label);

        // Track count pill.
        const n = AudioUI._playlistCount(name);
        if (n > 0) {
          const count = document.createElement('span');
          count.className = 'pl-count';
          count.textContent = String(n);
          li.appendChild(count);
        }

        // Little equalizer on the playlist the current track belongs to
        // (it dances while audio is playing — see the CSS). Folder lists
        // and "All songs" only.
        if (!virtual && currentTrack && (name === 'all' || currentTrack.playlist === name)) {
          const eq = document.createElement('span');
          eq.className = 'pl-eq';
          eq.setAttribute('aria-hidden', 'true');
          eq.innerHTML = '<i></i><i></i><i></i>';
          li.appendChild(eq);
        }

        // Curated lists can be deleted (tap once to arm, again to confirm).
        if (name.indexOf('@list:') === 0) {
          const listId = name.slice(6);
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'pl-del';
          del.setAttribute('aria-label', 'Delete playlist');
          del.appendChild(svgIcon('i-trash'));
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!del.classList.contains('confirm')) {
              del.classList.add('confirm');
              setTimeout(() => del.classList.remove('confirm'), 2500);
              return;
            }
            const wasActive = state.activePlaylist === name;
            AudioFeatures.customPlaylists.remove(listId);
            li.remove();
            if (wasActive) AudioUI.selectPlaylist('all');
            AudioUI._movePlaylistIndicator(false);
          });
          li.appendChild(del);
        }

        // Every row carries a check; CSS only reveals it on the active row,
        // so it follows the selection without any DOM rebuild.
        const check = svgIcon('i-check');
        check.classList.add('pl-check');
        li.appendChild(check);

        if (name === state.activePlaylist) li.classList.add('active');

        // Only updates classes/text, slides the highlight and closes the
        // list shortly after — never rebuilds #audio-playlist-list's own
        // DOM (see the comment on selectPlaylist() above).
        li.addEventListener('click', () => {
          AudioUI.selectPlaylist(name);
          AudioUI._movePlaylistIndicator(true);
          if (navigator.vibrate) navigator.vibrate(6);
          setTimeout(() => AudioUI.closePlaylistList(), 260);
        });
        els.playlistList.appendChild(li);
      });

      // "New playlist" row: opens the name box instead of selecting.
      const add = document.createElement('li');
      add.className = 'pl-new';
      add.style.setProperty('--i', String(names.length));
      add.appendChild(svgIcon('i-plus'));
      const addLabel = document.createElement('span');
      addLabel.className = 'pl-name';
      addLabel.textContent = 'New playlist';
      add.appendChild(addLabel);
      add.addEventListener('click', () => {
        AudioUI.closePlaylistList();
        AudioUI.showNewListRow(false);
      });
      els.playlistList.appendChild(add);

      els.playlistBtnLabel.textContent = playlistLabel(state.activePlaylist);
      if (els.playlistBtnCount) {
        const total = MediaLibrary.currentSelectionIds().length;
        els.playlistBtnCount.textContent = total > 0 ? String(total) : '';
      }
      // The picker is always available now: Recently played, Liked and
      // curated playlists live in it alongside the folder playlists.
      if (els.playlistRow) els.playlistRow.classList.remove('hidden');
      AudioUI._movePlaylistIndicator(false);
    },

    /* ---- Add current track to a curated playlist -------------------------- */
    openAddTo() {
      AudioUI.renderAddToList();
      els.addtoList.classList.remove('hidden');
      void els.addtoList.offsetHeight;
      els.addtoList.classList.add('open');
      els.addtoBtn.classList.add('active');
    },
    closeAddTo() {
      els.addtoList.classList.add('hidden');
      els.addtoList.classList.remove('open');
      els.addtoBtn.classList.remove('active');
    },
    renderAddToList() {
      const track = state.currentTrackId;
      els.addtoList.innerHTML = '';
      const heading = document.createElement('li');
      heading.className = 'addto-heading';
      heading.textContent = 'Add to playlist';
      els.addtoList.appendChild(heading);

      AudioFeatures.customPlaylists.list().forEach(p => {
        const li = document.createElement('li');
        const has = () => (AudioFeatures.customPlaylists.getIds(p.id) || []).indexOf(track) !== -1;
        const name = document.createElement('span');
        name.className = 'pl-name';
        name.textContent = p.name;
        const count = document.createElement('span');
        count.className = 'pl-count';
        count.textContent = String(p.count);
        const check = svgIcon('i-check');
        check.classList.add('pl-check');
        li.appendChild(name); li.appendChild(count); li.appendChild(check);
        li.classList.toggle('active', has());
        li.addEventListener('click', () => {
          if (has()) AudioFeatures.customPlaylists.removeTrack(p.id, track);
          else AudioFeatures.customPlaylists.addTracks(p.id, [track]);
          li.classList.toggle('active', has());
          count.textContent = String((AudioFeatures.customPlaylists.getIds(p.id) || []).length);
          if (navigator.vibrate) navigator.vibrate(6);
        });
        els.addtoList.appendChild(li);
      });

      const add = document.createElement('li');
      add.className = 'pl-new';
      add.appendChild(svgIcon('i-plus'));
      const lab = document.createElement('span');
      lab.className = 'pl-name';
      lab.textContent = 'New playlist';
      add.appendChild(lab);
      add.addEventListener('click', () => {
        AudioUI.closeAddTo();
        AudioUI.showNewListRow(true);
      });
      els.addtoList.appendChild(add);
    },

    /* ---- Name box for a new curated playlist ------------------------------ */
    _newListAddsCurrent: false,
    showNewListRow(addCurrent) {
      if (!els.newRow) return;
      AudioUI._newListAddsCurrent = !!addCurrent;
      els.newRow.classList.remove('hidden');
      els.newInput.value = '';
      els.newInput.focus();
    },
    _createList() {
      const name = els.newInput.value.trim();
      if (!name) { els.newInput.focus(); return; }
      const addCurrent = AudioUI._newListAddsCurrent && state.currentTrackId;
      const id = AudioFeatures.customPlaylists.create(name, addCurrent ? [state.currentTrackId] : []);
      els.newRow.classList.add('hidden');
      els.newInput.blur();
      if (id === null) return;
      if (addCurrent) AudioUI.setNote('Added to \u201c' + name.slice(0, 60) + '\u201d.');
      else AudioUI.selectPlaylist('@list:' + id);
      AudioUI._updatePlaylistSelectionUI();
    },

    /* Built once (not part of render()) since sliders are stateful DOM
     * elements — rebuilding them every render() would fight the user's
     * own drag. Called again only after an explicit reset. */
    buildEqSliders() {
      if (!els.eqBands) return;
      els.eqBands.innerHTML = '';
      EQ_BAND_HZ.forEach((hz, i) => {
        const col = document.createElement('div');
        col.className = 'eq-band';

        const input = document.createElement('input');
        input.type = 'range';
        input.min = '-12';
        input.max = '12';
        input.step = '1';
        input.value = String(state.eqBands[i] || 0);
        input.dataset.bandIndex = String(i);
        input.className = 'eq-band-slider';
        syncSliderFill(input);

        const label = document.createElement('span');
        label.className = 'eq-band-label';
        label.textContent = formatBandLabel(hz);

        col.appendChild(input);
        col.appendChild(label);
        els.eqBands.appendChild(col);
      });
      els.eqPreamp.value = String(state.eqPreampDb || 0);
      syncSliderFill(els.eqPreamp);
      this.updateEqReadouts();
    },

    updateEqReadouts() {
      if (!els.eqBands) return;
      els.eqBands.querySelectorAll('input[data-band-index]').forEach(input => {
        input.title = (parseFloat(input.value) > 0 ? '+' : '') + input.value + ' dB';
      });
      if (els.eqPreamp) {
        els.eqPreamp.title = (state.eqPreampDb > 0 ? '+' : '') + state.eqPreampDb + ' dB preamp';
      }
    },

    /* Two sleep modes: a wall-clock deadline in minutes, or -1 meaning
     * "stop at the end of whatever track is currently playing". Stored
     * as an absolute timestamp (sleepTimerDeadline), not a countdown, so
     * it stays correct across backgrounding — each engine checks it on
     * every progress tick and fades/stops when it's reached. */
    setSleepTimer(minutes) {
      state.sleepTimerMinutes = minutes;
      state.sleepTimerDeadline = minutes > 0 ? Date.now() + minutes * 60000 : null;
      if (els.sleep) els.sleep.value = String(minutes);
      this.render();
    },

    setNote(text) {
      if (els.note) els.note.textContent = text;
    },

    // "Off" or "6 s" — the text next to the Crossfade slider.
    crossfadeLabel() {
      const sec = state.features.crossfade.seconds;
      return sec > 0 ? sec + ' s' : 'Off';
    },

    /* Cheap update used on every progress tick (~2-4x/sec) — touches
     * only the seek bar and the two time labels, not the whole panel.
     * Skips the work entirely while the user has their finger on the
     * seek bar, so their drag isn't fought by the playback position. */
    updateProgressOnly() {
      if (!els.panel || document.activeElement === els.seek) return;
      els.elapsed.textContent = formatTime(state.positionSec);
      els.duration.textContent = formatTime(state.durationSec);
      els.seek.value = state.durationSec
        ? String(Math.round((state.positionSec / state.durationSec) * 1000))
        : '0';
      syncSliderFill(els.seek);
    },

    render() {
      if (!els.panel) return;

      const track = state.currentTrackId ? MediaLibrary.getTrack(state.currentTrackId) : null;

      els.npTitle.textContent = track ? track.title : (state.scanning ? 'Scanning…' : 'The sky is quiet');
      els.npArtist.textContent = track ? (track.artist || 'Unknown artist') : (state.scanning ? 'Looking through your music folder' : 'Pick a star below');
      updateArtwork(track);
      els.playBtn.classList.toggle('is-playing', !!state.playing);
      // Top-bar music shortcut: shown once a track is loaded or playing
      // (the sidebar's own button steps aside while it is visible).
      if (els.topBtn) {
        const active = !!(state.currentTrackId || state.playing);
        els.topBtn.style.display = active ? '' : 'none';
        els.topBtn.classList.toggle('playing', !!state.playing);
        if (els.sideBtn) els.sideBtn.style.display = active ? 'none' : '';
      }
      els.playBtn.title = state.playing ? 'Pause' : 'Play';

      els.elapsed.textContent = formatTime(state.positionSec);
      els.duration.textContent = formatTime(state.durationSec);
      els.seek.disabled = !track;
      els.seek.value = state.durationSec
        ? String(Math.round((state.positionSec / state.durationSec) * 1000))
        : '0';
      syncSliderFill(els.seek);

      els.shuffleBtn.classList.toggle('active', state.shuffle);
      els.repeatBtn.classList.toggle('active', state.repeat !== 'off');
      els.repeatBtn.classList.toggle('is-one', state.repeat === 'one');
      els.repeatBtn.title = state.repeat === 'one' ? 'Repeat one' : (state.repeat === 'all' ? 'Repeat all' : 'Repeat');

      els.volume.value = String(Math.round(state.volume * 100));
      syncSliderFill(els.volume);
      els.volumeValue.textContent = Math.round(state.volume * 100) + '%';

      // Volume normalisation: mode selector + what it is doing to this track.
      if (els.rgMode) {
        els.rgMode.value = state.features.replayGain.mode;
        const d = AudioFeatures.replayGain.describe(track);
        els.rgValue.textContent = !d ? '' : (!d.tagged ? 'no tag'
          : (d.db > 0 ? '+' : d.db < 0 ? '\u2212' : '') + Math.abs(d.db).toFixed(1) + ' dB');
      }

      // Crossfade length.
      if (els.xf) {
        els.xf.value = String(state.features.crossfade.seconds);
        syncSliderFill(els.xf);
        els.xfValue.textContent = AudioUI.crossfadeLabel();
      }

      els.prevBtn.disabled = !state.queue.length;
      els.nextBtn.disabled = !state.queue.length;
      els.playBtn.disabled = !state.queue.length;

      // Like / add-to / A-B state.
      if (els.likeBtn) {
        const liked = !!track && AudioFeatures.likes.isLiked();
        els.likeBtn.classList.toggle('liked', liked);
        els.likeBtn.setAttribute('aria-pressed', String(liked));
        els.likeBtn.title = liked ? 'Remove from Liked' : 'Like';
        els.likeBtn.disabled = !track;
        els.addtoBtn.disabled = !track;
      }
      if (els.abA) {
        const ab = AudioFeatures.abRepeat.get();
        els.abA.disabled = !track;
        els.abB.disabled = !track || ab.a === null;
        els.abA.classList.toggle('active', ab.a !== null);
        els.abB.classList.toggle('active', ab.b !== null);
        els.abClear.classList.toggle('hidden', ab.a === null);
        els.abRow.classList.toggle('looping', ab.a !== null && ab.b !== null);
        els.abReadout.textContent = ab.a === null
          ? 'A\u2013B repeat'
          : (ab.b === null
            ? 'A ' + formatTime(ab.a) + ' \u00b7 now tap B'
            : 'Looping ' + formatTime(ab.a) + ' \u2013 ' + formatTime(ab.b));
      }

      // Queue list. When viewing "All songs" with more than one playlist
      // in the library, each row also shows which playlist it belongs to
      // (or nothing, for an ungrouped track) — otherwise there's no way
      // to tell them apart once they're merged into one list. Not shown
      // while a specific playlist is selected, since every visible row
      // already belongs to it.
      const showPlaylistTags = state.activePlaylist === 'all' && MediaLibrary.getPlaylists().length > 0;
      const queueKey = showPlaylistTags + '|' + state.queue.map(id => {
        const t = MediaLibrary.getTrack(id);
        return id + ':' + (t ? t.durationSec + (t.playlist || '') : '');
      }).join(',');
      if (state.queue.length > 0 && queueKey === queueRenderKey && els.queue.childElementCount === state.queue.length) {
        // Same list as last time: just move the "playing" highlight
        // instead of tearing down and rebuilding every row.
        Array.prototype.forEach.call(els.queue.children, li => {
          li.classList.toggle('playing', li.dataset.trackId === String(state.currentTrackId));
        });
        return;
      }
      queueRenderKey = queueKey;
      els.queue.innerHTML = '';
      state.queue.forEach(id => {
        const t = MediaLibrary.getTrack(id);
        if (!t) return;
        const li = document.createElement('li');
        li.dataset.trackId = id;
        if (id === state.currentTrackId) li.classList.add('playing');

        const label = document.createElement('span');
        label.className = 'audio-track-label';
        // Two lines (title over artist) for the Spotify-kit song rows.
        const lt = document.createElement('span');
        lt.className = 'sp-t';
        lt.textContent = t.title;
        label.appendChild(lt);
        if (t.artist) {
          const la = document.createElement('span');
          la.className = 'sp-a';
          la.textContent = t.artist;
          label.appendChild(la);
        }

        li.appendChild(label);

        if (showPlaylistTags && t.playlist) {
          const tag = document.createElement('span');
          tag.className = 'audio-track-playlist';
          tag.textContent = t.playlist;
          li.appendChild(tag);
        }

        const dur = document.createElement('span');
        dur.className = 'audio-track-duration';
        dur.textContent = formatTime(t.durationSec);
        li.appendChild(dur);

        els.queue.appendChild(li);
      });

      const hasTracks = state.queue.length > 0;
      els.empty.style.display = hasTracks ? 'none' : '';
      els.queue.style.display = hasTracks ? '' : 'none';
      if (!hasTracks) {
        els.empty.innerHTML = state.tracks.length === 0
          ? 'No audio files yet. Put music in <code>/storage/emulated/0/Novel/Audio</code>, then tap Scan the sky.'
          : 'This playlist has no songs.';
      }
    },
  };

  /* =======================================================================
     9. PUBLIC API
     ======================================================================= */

  return {
    init() {
      AudioUI.cacheElements();
      if (!els.panel) return; // panel absent — nothing to do
      Prefs.load();
      syncVolumeFromSystem();
      LocalAudioEngine.init();
      NativeAudioEngine.init();
      AudioUI.bindEvents();
      AudioUI.render();
      // Scan for music as soon as the app opens, rather than waiting for
      // the user to open the music panel and tap Rescan — the whole
      // point of a library is that it's there when you look for it.
      MediaLibrary.scan(true);
    },

    // Called by MainActivity's inactivity timer so the app never closes
    // itself while music is playing on either engine (native or WebView).
    isPlaying() {
      return !!state.playing;
    },

    // Called by MainActivity after a hardware volume key changes the media
    // volume, so the slider/percentage in the open panel follow along.
    syncVolume() {
      syncVolumeFromSystem();
      MuteGuard.check();
      AudioUI.render();
    },

    // Called by reader.js each time the panel is opened.
    onPanelOpened() {
      syncVolumeFromSystem();
      MuteGuard.check();
      AudioUI.render();
    },

    /* Called once MainActivity has a live MediaController connected to
     * PlaybackService (window.onNativeAudioReady, at the bottom of this
     * file). Hands off whatever is currently playing to the native
     * engine at the same position, rather than restarting it — the
     * switch should be inaudible if playback was already under way. */
    _switchToNative() {
      if (AudioEngine === NativeAudioEngine) return; // duplicate ready callback — ignore
      const wasPlaying = state.playing;
      const currentId = state.currentTrackId;
      const positionSec = state.positionSec;

      if (wasPlaying) LocalAudioEngine.pause();
      if (currentId && positionSec) state.handoffPositionSec = positionSec;

      AudioEngine = NativeAudioEngine;
      AudioFeatures.emit('engineChanged', NativeAudioEngine);

      if (currentId && wasPlaying) {
        AudioEngine.play(currentId);
      } else {
        AudioUI.render();
      }
    },

    // window.onNativeAudio* callbacks, defined at the bottom of this
    // file, all funnel through here so NativeAudioEngine never has to be
    // referenced directly from outside this closure.
    _nativeOnLoaded(durationSec) { NativeAudioEngine.onLoaded(durationSec); },
    _nativeOnStateChanged(playing) { NativeAudioEngine.onStateChanged(playing); },
    _nativeOnProgress(positionSec, durationSec) { NativeAudioEngine.onProgress(positionSec, durationSec); },
    _nativeOnEnded() { NativeAudioEngine.onTrackEnded(); },
    _nativeOnError(message) { NativeAudioEngine.onError(message); },
    _nativeOnSkipNext() { NativeAudioEngine.onSkipNext(); },
    _nativeOnSkipPrevious() { NativeAudioEngine.onSkipPrevious(); },

    /* Called by the reading-session timer when a break overlay appears.
     * Pauses playback and remembers that it was *we* who paused, so
     * resumeAfterBreak() doesn't start music the user had already
     * stopped themselves. */
    pauseForBreak() {
      if (state.playing) {
        state.duckedForBreak = true;
        AudioEngine.pause();
      }
    },

    resumeAfterBreak() {
      if (state.duckedForBreak) {
        state.duckedForBreak = false;
        AudioEngine.toggle();
      }
    },

    // Native bridge callback — see MediaLibrary.scan() for the contract.
    onAudioListed(tracks) {
      MediaLibrary.onScanned(tracks);
    },

    // Optional-feature registry and modules: NovelAudio.features.abRepeat,
    // .replayGain, .history, .likes, .customPlaylists, .describe()...
    features: AudioFeatures,

    // Exposed for debugging and for the tests. `AudioEngine` is exposed
    // as a getter since the underlying binding is reassigned by
    // _switchToNative() — a plain property here would freeze at
    // whichever engine was active the moment _modules was built.
    _state: state,
    _modules: {
      MediaLibrary, PlaybackQueue, LocalAudioEngine, NativeAudioEngine, AudioUI, Prefs, AudioFeatures,
      get AudioEngine() { return AudioEngine; },
    },
  };
})();

/* Native → JS callback bridge. Each of these mirrors the existing
   window.onAudioListed / window.onNovelsListed pattern: the Kotlin side
   calls webView.evaluateJavascript("window.onXyz(...)"), and the
   function here does the minimal parsing needed before handing off to
   NovelAudio. See MainActivity.kt / PlaybackService.kt for the Kotlin
   side of each of these. */

window.onAudioListed = function (tracksJson) {
  try {
    const tracks = typeof tracksJson === 'string' ? JSON.parse(tracksJson) : tracksJson;
    window.NovelAudio.onAudioListed(tracks);
  } catch (e) {
    console.error('Failed to parse audio list', e);
  }
};

// Fired once MainActivity has successfully connected a MediaController
// to PlaybackService — see MainActivity.kt's connectNativePlayer().
window.onNativeAudioReady = function () {
  window.NovelAudio._switchToNative();
};

// Fired when the native player reaches Player.STATE_READY for the
// currently loaded item — this engine's equivalent of 'loadedmetadata'.
window.onNativeAudioLoaded = function (durationSec) {
  window.NovelAudio._nativeOnLoaded(durationSec);
};

// Fired on every Player.Listener#onIsPlayingChanged — covers both our
// own play()/pause() calls AND ones we didn't initiate (notification
// button, headset button, audio focus loss to another app).
window.onNativeAudioState = function (json) {
  try {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    window.NovelAudio._nativeOnStateChanged(!!data.playing);
  } catch (e) {
    console.error('Failed to parse native audio state', e);
  }
};

// Fired roughly every 500ms while playing (see MainActivity.kt's
// startProgressUpdates()).
window.onNativeAudioProgress = function (positionSec, durationSec) {
  window.NovelAudio._nativeOnProgress(positionSec, durationSec);
};

window.onNativeAudioEnded = function () {
  window.NovelAudio._nativeOnEnded();
};

window.onNativeAudioError = function (message) {
  window.NovelAudio._nativeOnError(message);
};

// The system notification's Next/Previous buttons land here — see
// PlaybackService.kt's QueueAwarePlayer for why these need a dedicated
// path instead of going through the normal seekToNext()/seekToPrevious().
window.onNativeAudioSkipNext = function () {
  window.NovelAudio._nativeOnSkipNext();
};
window.onNativeAudioSkipPrevious = function () {
  window.NovelAudio._nativeOnSkipPrevious();
};

// Native → JS: what the device's equalizer looks like (band layout, dB range,
// or available:false). Requested by AudioFeatures.nativeEffects.requestInfo()
// when the native engine takes over — see NativeAudioEffects.kt.
window.onNativeAudioEffectsInfo = function (json) {
  try {
    const info = typeof json === 'string' ? JSON.parse(json) : json;
    window.NovelAudio.features.nativeEffects.onInfo(info);
  } catch (e) {
    console.error('Failed to parse native effects info', e);
  }
};

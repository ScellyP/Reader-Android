// Checks the crossfade feature in app/src/main/assets/audio-player.js: when it triggers,
// the equal-power curve, the WebView engine's two-element ramp, the native engine's
// bridge call and its stale-event guards, and persistence. Run from the project root:
//   node tests/crossfade.test.js
// audio-player.js is loaded with stubbed browser globals, a fake clock and fake <audio>
// elements. The Kotlin side (NativeCrossfade.kt) is NOT exercised here — see README.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/audio-player.js'), 'utf8');
const noop = () => {};
const el = () => new Proxy(function () {}, { get: (t, k) => (k === 'classList' ? { add: noop, remove: noop, toggle: noop, contains: () => false } : k === 'style' ? {} : noop), set: () => true });

let fails = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
function check(name, ok) { if (!ok) { fails++; console.error('FAIL: ' + name); } else console.log('ok:   ' + name); }

// A stand-in for HTMLAudioElement that behaves like the real one where it matters here:
// .volume throws outside 0..1, and play/pause fire events.
class FakeAudio {
  constructor() {
    this._src = ''; this._vol = 1; this.paused = true; this.currentTime = 0; this.duration = NaN;
    this.readyState = 0; this.playbackRate = 1; this._l = {};
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.readyState = v ? 4 : 0; }
  get volume() { return this._vol; }
  set volume(v) { if (!(v >= 0 && v <= 1)) throw new RangeError('volume out of range: ' + v); this._vol = v; }
  removeAttribute(n) { if (n === 'src') { this._src = ''; } }
  load() { this.readyState = this._src ? 4 : 0; }
  play() { this.paused = false; this._fire('play'); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this._fire('pause'); } }
  addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  _fire(t) { (this._l[t] || []).forEach(f => f({ target: this })); }
}

// A fresh page for each group of checks. `now` is the fake clock; tick(ms) advances it
// and runs any setInterval callbacks that fall due.
function load(opts = {}) {
  const store = opts.store || {};
  let now = 1000000;
  const timers = [];
  let nextId = 1;
  const FakeDate = function () {}; FakeDate.now = () => now;
  const window = {
    addEventListener: noop, removeEventListener: noop,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    AndroidBridge: opts.bridge || null,
  };
  const document = { getElementById: () => null, createElement: el, createElementNS: el, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], body: el(), readyState: 'loading' };
  const ctx = {
    window, document, localStorage: window.localStorage, console, Promise,
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms, due: now + ms }); return id; },
    clearInterval: (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    Audio: FakeAudio, navigator: {}, Date: FakeDate, Math, JSON, Object, Array,
  };
  ctx.self = ctx.globalThis = window;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const NA = window.NovelAudio;
  const m = NA._modules;
  const tick = (ms) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 10);
      timers.slice().forEach(t => { if (timers.includes(t) && now >= t.due) { t.due += t.ms; t.fn(); } });
    }
  };
  return { NA, m, state: NA._state, window, tick, store, advanceClock: (ms) => { now += ms; }, now: () => now };
}

const track = (id, extra) => Object.assign({ id, title: 'Track ' + id, artist: 'Artist', album: 'Album', durationSec: 100, path: 'file:///Audio/' + id + '.mp3', webUrl: 'https://x/audio/' + id + '.mp3' }, extra || {});
const library = (...ids) => ids.map(i => track(i));

/* ---- 1. The curve ------------------------------------------------------------ */
{
  const { NA } = load();
  const xf = NA.features.crossfade;
  const c0 = xf.curve(0), c1 = xf.curve(1), ch = xf.curve(0.5);
  check('curve: starts all-old, ends all-new', near(c0.out, 1) && near(c0.inn, 0) && near(c1.out, 0) && near(c1.inn, 1));
  let flat = true;
  for (let t = 0; t <= 1; t += 0.05) { const c = xf.curve(t); if (!near(c.out * c.out + c.inn * c.inn, 1)) flat = false; }
  check('curve: equal power (out² + in² = 1) throughout', flat);
  check('curve: -3 dB each at the midpoint', near(ch.out, Math.SQRT1_2) && near(ch.inn, Math.SQRT1_2));
  check('curve: clamps outside 0..1', xf.curve(-1).inn === 0 && xf.curve(2).out < 1e-12 && near(xf.curve(2).inn, 1));
}

/* ---- 2. Settings & persistence -------------------------------------------------- */
{
  const store = {};
  const a = load({ store });
  const xf = a.NA.features.crossfade;
  check('setting: off by default', a.state.features.crossfade.seconds === 0 && a.m.AudioUI.crossfadeLabel() === 'Off');
  xf.setSeconds(7.4);
  check('setting: rounds to whole seconds', a.state.features.crossfade.seconds === 7 && a.m.AudioUI.crossfadeLabel() === '7 s');
  xf.setSeconds(99); check('setting: capped at 12', a.state.features.crossfade.seconds === 12);
  xf.setSeconds(-5); check('setting: floored at 0', a.state.features.crossfade.seconds === 0);
  xf.setSeconds('nope'); check('setting: junk ignored', a.state.features.crossfade.seconds === 0);
  xf.setSeconds(6);
  const b = load({ store });
  b.m.Prefs.load();
  check('setting: survives a restart', b.state.features.crossfade.seconds === 6);
  check('status: reported as working', a.NA.features.describe().find(f => f.id === 'crossfade').status === 'working');
}

/* ---- 3. When the trigger fires --------------------------------------------------- */
{
  const { NA, m, state, now } = load();
  m.MediaLibrary.onScanned(library('A', 'B', 'C'));
  m.PlaybackQueue.buildFrom(['A', 'B', 'C']);
  m.LocalAudioEngine.seek = noop;     // an A-B loop would seek; there is no real element here
  state.currentTrackId = 'A'; state.queueIndex = 0; state.playing = true; state.durationSec = 100;
  const calls = [];
  m.LocalAudioEngine.beginCrossfade = (id, sec) => { calls.push([id, sec]); return true; };
  // Each check is independent unless told otherwise, so the stub engine (which doesn't really
  // switch tracks) starts every one with the track "freshly started".
  const progress = (pos, dur, keepArming) => {
    if (!keepArming) NA.features.crossfade._armedFor = null;
    NA.features.emit('progress', { positionSec: pos, durationSec: dur === undefined ? 100 : dur });
  };
  const xf = NA.features.crossfade;

  progress(96, 100); check('trigger: nothing when crossfade is off', calls.length === 0);
  xf.setSeconds(5);
  progress(50); check('trigger: nothing mid-track', calls.length === 0);
  progress(94); check('trigger: nothing before the window (6 s left, window 5.5 s)', calls.length === 0);
  progress(94.6);
  check('trigger: fires inside the window, with the next track and the length', calls.length === 1 && calls[0][0] === 'B' && calls[0][1] === 5);
  calls.length = 0;

  progress(100); check('trigger: nothing at 0 s left', calls.length === 0);
  state.playing = false; progress(96); check('trigger: nothing while paused', calls.length === 0); state.playing = true;
  state.repeat = 'one'; progress(96); check('trigger: not with repeat-one', calls.length === 0); state.repeat = 'off';
  state.sleepTimerMinutes = -1; progress(96); check('trigger: not in stop-at-end-of-track sleep mode', calls.length === 0); state.sleepTimerMinutes = 0;
  { NA.features.abRepeat.setA(); state.positionSec = 90; NA.features.abRepeat.setB(); progress(96); check('trigger: not while an A-B loop is set', calls.length === 0); NA.features.abRepeat.clear(); }
  state.sleepTimerMinutes = 30; state.sleepTimerDeadline = now() + 10 * 1000; progress(96);
  check('trigger: not when a timed sleep ends inside the overlap', calls.length === 0);
  state.sleepTimerDeadline = now() + 10 * 60 * 1000; progress(96);
  check('trigger: fine when the sleep timer is far off', calls.length === 1);
  state.sleepTimerMinutes = 0; state.sleepTimerDeadline = null; calls.length = 0;

  state.queueIndex = 2; state.currentTrackId = 'C'; progress(96);
  check('trigger: nothing after the last track (repeat off)', calls.length === 0);
  state.repeat = 'all'; progress(96);
  check('trigger: wraps to the first track with repeat-all', calls.length === 1 && calls[0][0] === 'A');
  state.repeat = 'off'; calls.length = 0; state.queueIndex = 0; state.currentTrackId = 'A';

  progress(7, 8);   // an 8 s track with a 5 s setting: fade over half its length (4 s)
  check('trigger: short track fades over half its length', calls.length === 1 && calls[0][1] === 4);
  calls.length = 0;

  // A refused crossfade is retried on the next tick, then stops once it takes.
  let accept = false; const tries = [];
  m.LocalAudioEngine.beginCrossfade = (id, sec) => { tries.push(id); return accept; };
  progress(95); progress(95.5, 100, true); accept = true; progress(96, 100, true); progress(96.5, 100, true);
  check('trigger: retries while the engine says no, stops once it says yes', tries.length === 3);

  // An engine that doesn't answer at all (returns nothing) is asked once per track.
  state.currentTrackId = 'A'; state.queueIndex = 0; NA.features.emit('trackStart', m.MediaLibrary.getTrack('A'));
  const asked = [];
  m.LocalAudioEngine.beginCrossfade = (id, sec) => { asked.push(id); };
  progress(95); progress(95.5, 100, true); progress(96, 100, true);
  check('trigger: an engine that returns nothing is asked once per track', asked.length === 1);
}

/* ---- 4. WebView engine ---------------------------------------------------------------- */
{
  const { NA, m, state, tick } = load();
  const L = m.LocalAudioEngine;
  m.MediaLibrary.onScanned(library('A', 'B', 'C'));
  state.volume = 0.8;
  L.init();
  const first = L._el, spare = L._el2;
  L.play('A');
  first.duration = 100; first.currentTime = 95.5;
  NA.features.crossfade.setSeconds(4);
  NA.features.replayGain.setMode('track');
  m.MediaLibrary.getTrack('A').replayGainTrackDb = -6;     // A is loud; B has no tag
  const aGain = 0.8 * Math.pow(10, -6 / 20);

  check('local: starts as the first element, the other one idle', first.src.includes('A.mp3') && spare.src === '');
  NA.features.emit('progress', { positionSec: 95.5, durationSec: 100 });

  check('local: new track is current at once', state.currentTrackId === 'B' && state.queueIndex === 1 && state.positionSec === 0);
  check('local: elements swapped roles', L._el === spare && L._el2 === first && spare.src.includes('B.mp3'));
  check('local: old track keeps playing underneath', !first.paused && first.src.includes('A.mp3'));
  check('local: each track fades from its own replay-gain level', near(L._xf.outGain, aGain) && near(L._xf.inGain, 0.8));
  check('local: recently-played list picked up the new track', NA.features.history.getIds()[0] === 'B');

  tick(50);   // clock starts once the new element is ready
  tick(2000);
  const half = Math.SQRT1_2;
  check('local: halfway — both at -3 dB of their own level', near(spare.volume, 0.8 * half, 0.03) && near(first.volume, aGain * half, 0.03));

  first._fire('ended');            // the old track hitting its end must be ignored
  first._fire('timeupdate');
  check('local: events from the fading-out element are ignored', state.currentTrackId === 'B' && state.queueIndex === 1);

  const vols = [];
  tick(1000);                      // still fading: a volume change must not make the level jump
  const before = spare.volume;
  L.setVolume(0.5);
  check('local: volume change mid-fade does not jump the level', near(spare.volume, before, 1e-9) && near(L._xf.inGain, 0.5));

  tick(3000);
  check('local: fade ends — old element stopped and emptied', L._xf === null && first.paused && first.src === '');
  check('local: new element at its full level', near(spare.volume, 0.5) && !spare.paused);
  check('local: next-after-that is preloaded', L._preloadEl.src.includes('C.mp3'));

  // Interrupting: pause / seek / picking another track all end the overlap.
  const fresh = (id) => { L.play(id); L._el.duration = 100; L._el.currentTime = 95.5; NA.features.emit('progress', { positionSec: 95.5, durationSec: 100 }); };
  L.play('A'); L._el.duration = 100; L._el.currentTime = 95.5; NA.features.emit('progress', { positionSec: 95.5, durationSec: 100 });
  const tail1 = L._el2;
  check('local: second crossfade running', !!L._xf && state.currentTrackId === 'B');
  L.pause();
  check('local: pause ends the overlap and silences the old track', L._xf === null && tail1.paused && tail1.src === '' && L._el.paused);

  L.play('A'); L._el.duration = 100; L._el.currentTime = 95.5; NA.features.emit('progress', { positionSec: 95.5, durationSec: 100 });
  const tail2 = L._el2;
  L.play('C');
  check('local: choosing another track ends the overlap', L._xf === null && tail2.paused && state.currentTrackId === 'C' && L._el.src.includes('C.mp3'));

  L.play('A'); L._el.duration = 100; L._el.currentTime = 95.5; NA.features.emit('progress', { positionSec: 95.5, durationSec: 100 });
  const tail3 = L._el2; L._el.readyState = 4; state.durationSec = 100;
  L.seek(10);
  check('local: seeking ends the overlap', L._xf === null && tail3.paused);

  // Not enough of the old track left: no overlap, normal behaviour.
  L.play('A'); L._el.duration = 100; L._el.currentTime = 99.9;
  check('local: refuses when under 0.3 s is left', L.beginCrossfade('B', 4) === false && state.currentTrackId === 'A');
  check('local: refuses with no next track', L.beginCrossfade('nope', 4) === false);

  // Volumes must never leave 0..1 (a real <audio> throws).
  let threw = false;
  try { L.play('A'); L._el.duration = 100; L._el.currentTime = 95.5; state.volume = 1; NA.features.replayGain.setMode('off'); L.beginCrossfade('B', 4); tick(5000); } catch (e) { threw = true; }
  check('local: volumes stay inside 0..1', !threw);

  // Short fade truncated by the real time left.
  L.pause(); L.play('A'); L._el.duration = 100; L._el.currentTime = 98.9;
  L.beginCrossfade('B', 12); tick(60);
  check('local: fade shortened to the time actually left', L._xf && L._xf.fadeMs <= 1100);
}

/* ---- 5. Native engine ------------------------------------------------------------------ */
{
  const xfCalls = [], loads = [], vols = [];
  const bridge = {
    nativeAudioLoad: (...a) => loads.push(a), nativeAudioPlay: noop, nativeAudioPause: noop, nativeAudioSeek: noop,
    nativeAudioSetVolume: (v) => vols.push(v), nativeAudioSetSpeed: noop, nativeAudioSyncState: noop,
    nativeAudioCrossfade: (...a) => xfCalls.push(a),
  };
  const { NA, m, state, window, advanceClock } = load({ bridge });
  m.MediaLibrary.onScanned(library('A', 'B', 'C'));
  NA._switchToNative();
  const N = m.NativeAudioEngine;
  state.volume = 0.8;
  N.play('A');
  NA.features.crossfade.setSeconds(5);
  NA.features.replayGain.setMode('track');
  m.MediaLibrary.getTrack('A').replayGainTrackDb = -6;
  m.MediaLibrary.getTrack('B').replayGainTrackDb = -3;

  window.onNativeAudioProgress(90, 100);
  check('native: nothing to do before the window', xfCalls.length === 0);
  window.onNativeAudioProgress(95.2, 100);
  check('native: one bridge call, for the next track', xfCalls.length === 1 && xfCalls[0][0] === 'file:///Audio/B.mp3' && xfCalls[0][1] === 'Track B');
  const a = xfCalls[0];
  check('native: passes the fade length', a[4] === 5);
  check('native: passes each track\'s own level (out = A, in = B)', near(a[5], 0.8 * Math.pow(10, -6 / 20)) && near(a[6], 0.8 * Math.pow(10, -3 / 20)));
  check('native: app state moves to the new track at once', state.currentTrackId === 'B' && state.positionSec === 0 && state.queueIndex === 1);
  check('native: no separate load/play call for the new track', loads.length === 1 /* only the first play('A') */);

  // Reports already in flight from the old track must not move things back.
  window.onNativeAudioProgress(99.6, 100);
  window.onNativeAudioEnded();
  check('native: stale progress from the old track is ignored', state.positionSec === 0 && state.durationSec === 100 && xfCalls.length === 1);
  check('native: stale "ended" from the old track is ignored', state.currentTrackId === 'B' && state.queueIndex === 1 && xfCalls.length === 1);
  window.onNativeAudioState(JSON.stringify({ playing: false }));
  check('native: a brief "not playing" while the new player buffers is ignored', state.playing === true);

  advanceClock(2000);
  state.durationSec = 0; window.onNativeAudioProgress(2.0, 180);
  check('native: progress is accepted again after the hand-over', state.positionSec === 2.0 && state.durationSec === 180);
  window.onNativeAudioEnded();
  check('native: the new track\'s real end still advances the queue', state.currentTrackId === 'C');
  window.onNativeAudioState(JSON.stringify({ playing: false }));
  check('native: a real pause is honoured after the grace period', state.playing === false);
}
{
  // An older native host (no nativeAudioCrossfade): do nothing, keep the normal gap.
  const bridge = { nativeAudioLoad: noop, nativeAudioPlay: noop, nativeAudioPause: noop, nativeAudioSeek: noop, nativeAudioSetVolume: noop, nativeAudioSetSpeed: noop, nativeAudioSyncState: noop };
  const { NA, m, state, window } = load({ bridge });
  m.MediaLibrary.onScanned(library('A', 'B'));
  NA._switchToNative();
  m.NativeAudioEngine.play('A');
  NA.features.crossfade.setSeconds(5);
  window.onNativeAudioProgress(96, 100);
  check('native: old host without the call keeps playing normally', state.currentTrackId === 'A' && state.queueIndex === 0);
}
{
  // The bridge call throws: fall back to an ordinary start of the next track.
  const loads = [];
  const bridge = { nativeAudioLoad: (...a) => loads.push(a), nativeAudioPlay: noop, nativeAudioPause: noop, nativeAudioSeek: noop, nativeAudioSetVolume: noop, nativeAudioSetSpeed: noop, nativeAudioSyncState: noop, nativeAudioCrossfade: () => { throw new Error('boom'); } };
  const { NA, m, state, window } = load({ bridge });
  m.MediaLibrary.onScanned(library('A', 'B'));
  NA._switchToNative();
  m.NativeAudioEngine.play('A');
  NA.features.crossfade.setSeconds(5);
  const origError = console.error; console.error = noop;
  window.onNativeAudioProgress(96, 100);
  console.error = origError;
  check('native: a failing bridge call falls back to a plain load of the next track', state.currentTrackId === 'B' && loads.length === 2 && loads[1][0] === 'file:///Audio/B.mp3');
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nAll crossfade checks passed');
process.exit(fails ? 1 : 0);

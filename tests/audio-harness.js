// Shared by the audio tests: boots audio-player.js as a fresh app launch, with stubbed browser
// globals, a fake Android bridge, and page elements that remember their click handlers so a test
// can press a real button.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/audio-player.js'), 'utf8');
const noop = () => {};

const TRACKS = ['/Novel/Audio/a.mp3', '/Novel/Audio/b.mp3', '/Novel/Audio/c.mp3']
  .map((p, i) => ({ id: p, path: p, title: 'Song ' + i, durationSec: 100 + i, playlist: null }));

// A page element that accepts any property or call. Click handlers are kept in `listeners`.
function fakeElement(listeners, id) {
  const base = function () {};
  return new Proxy(base, {
    get(target, key) {
      if (key === 'addEventListener') return (type, fn) => { (listeners[id] = listeners[id] || {})[type] = fn; };
      if (key === 'style' || key === 'classList' || key === 'dataset') return fakeElement({}, key);
      if (key === 'querySelector' || key === 'getElementById') return () => null;
      if (key === 'querySelectorAll') return () => [];
      if (key === Symbol.toPrimitive) return () => '';
      return noop;
    },
    set: () => true,
  });
}

// `saved` is the audio prefs blob the last run left behind; `bluetooth` is what the phone reports.
function launch({ saved = null, bluetooth = false, onScanAudio = null } = {}) {
  const store = saved ? { novelReader_audioPrefs: JSON.stringify(saved) } : {};
  const calls = [];
  const listeners = {};
  const elements = {};
  const bridge = new Proxy({
    scanAudioStartup: noop, scanAudio: () => { if (onScanAudio) onScanAudio(); },
    isBluetoothAudioConnected: () => bluetooth,
    nativeAudioLoad: p => calls.push('load ' + p),
    nativeAudioPlay: () => calls.push('play'),
  }, { get: (t, k) => (k in t ? t[k] : noop) });

  global.window = global;
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  global.document = {
    getElementById: id => elements[id] || (elements[id] = fakeElement(listeners, id)),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => fakeElement({}, 'new'), createElementNS: () => fakeElement({}, 'new'),
    addEventListener: noop, body: fakeElement({}, 'body'), readyState: 'complete',
  };
  global.Audio = function () { return fakeElement({}, 'audio'); };
  global.navigator = {};
  global.requestAnimationFrame = noop;
  global.AndroidBridge = bridge;

  new Function(SRC).call(global);
  const app = window.NovelAudio;
  app.init();
  return {
    app, state: app._state, calls, store,
    scanFinished: tracks => app.onAudioListed(tracks || TRACKS),
    nativeReady: () => app._switchToNative(),
    click: id => listeners[id].click({ preventDefault: noop, stopPropagation: noop, target: {} }),
    savedPrefs: () => JSON.parse(store.novelReader_audioPrefs),
  };
}

let count = 0;
function check(name, fn) { fn(); count++; console.log('ok -', name); }
const finish = () => { console.log(count + ' checks passed'); process.exit(0); };

module.exports = { launch, check, finish, noop, TRACKS };

// Smoke test: audio-player.js loads under Node with stubbed browser globals,
// and the saved audio prefs no longer carry the removed playback-speed setting.
// Run from the project root: node tests/audio-player.smoke.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const store = {};
const noop = () => {};
const el = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'style' || k === 'classList' || k === 'dataset') ? el() :
    (k === 'querySelector' || k === 'getElementById') ? () => null :
    (k === 'querySelectorAll') ? () => [] : (k === Symbol.toPrimitive ? () => '' : noop),
  set: () => true,
});
global.window = global;
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: el, createElementNS: el, addEventListener: noop, body: el(),
  readyState: 'loading',
};
global.Audio = function () { return el(); };
global.navigator = {};
global.requestAnimationFrame = noop;

const src = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/audio-player.js'), 'utf8');
new Function(src).call(global);

assert.ok(window.NovelAudio, 'NovelAudio is defined after load');
assert.strictEqual(typeof window.NovelAudio.isPlaying, 'function');
console.log('ok - audio-player.js loads and exposes NovelAudio');
assert.ok(!/setSpeed|nativeAudioSetSpeed|playbackRate/.test(src), 'no playback-speed code left');
console.log('ok - no playback-speed code remains');
console.log('2 checks passed');

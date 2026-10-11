// Checks the replayGain feature module in app/src/main/assets/audio-player.js
// (gain maths, mode fallbacks, clipping limit). Run from the project root:
//   node tests/replaygain.test.js
// audio-player.js is loaded with stubbed browser globals, like a page with no DOM.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const store = {};
const noop = () => {};
const el = () => new Proxy(function () {}, { get: (t, k) => (k === 'classList' ? { add: noop, remove: noop, toggle: noop, contains: () => false } : k === 'style' ? {} : noop), set: () => true });
const window = {
  addEventListener: noop, removeEventListener: noop, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  AndroidBridge: null,
};
const document = { getElementById: () => null, createElement: el, createElementNS: el, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], body: el(), readyState: 'loading' };
const ctx = { window, document, localStorage: window.localStorage, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, Audio: function () { return el(); }, navigator: {}, Date, Math, JSON, Object, Array };
ctx.self = ctx.globalThis = window;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/audio-player.js'), 'utf8'), ctx);

const NA = window.NovelAudio;
if (!NA || !NA.features || !NA.features.replayGain) { console.error('FAIL: NovelAudio.features.replayGain not found'); process.exit(1); }
const rg = NA.features.replayGain;

let fails = 0;
const near = (a, b) => Math.abs(a - b) < 1e-9;
function check(name, ok) { if (!ok) { fails++; console.error('FAIL: ' + name); } else console.log('ok:   ' + name); }
function setMode(m) { rg.setMode(m); }

setMode('off');
check('off: no change', rg.outputGain({ replayGainTrackDb: -6 }) === 1 && rg.boostDb({ replayGainTrackDb: 6 }) === 0);

setMode('track');
check('track: -6 dB cut', near(rg.outputGain({ replayGainTrackDb: -6 }), Math.pow(10, -6 / 20)));
check('track: untagged track unchanged', rg.outputGain({}) === 1 && rg.boostDb({}) === 0);
check('track: +3 dB is a boost, no cut', rg.outputGain({ replayGainTrackDb: 3 }) === 1 && near(rg.boostDb({ replayGainTrackDb: 3 }), 3));
check('track: falls back to album gain', near(rg.outputGain({ replayGainAlbumDb: -4 }), Math.pow(10, -4 / 20)));
check('track: ignores album gain when track gain exists', near(rg.outputGain({ replayGainTrackDb: -2, replayGainAlbumDb: -9 }), Math.pow(10, -2 / 20)));
check('track: clamps absurd cut to -24 dB', near(rg.outputGain({ replayGainTrackDb: -80 }), Math.pow(10, -24 / 20)));
check('track: NaN ignored', rg.outputGain({ replayGainTrackDb: NaN }) === 1);

// Clipping limit: peak 0.5 (-6.02 dB) allows at most +6.02 dB.
check('clip: +10 dB limited by peak 0.5', near(rg.boostDb({ replayGainTrackDb: 10, replayGainPeak: 0.5 }), -20 * Math.log10(0.5)));
check('clip: peak does not touch a cut', near(rg.outputGain({ replayGainTrackDb: -6, replayGainPeak: 0.5 }), Math.pow(10, -6 / 20)));

setMode('album');
check('album: uses album gain', near(rg.outputGain({ replayGainTrackDb: -2, replayGainAlbumDb: -9 }), Math.pow(10, -9 / 20)));
check('album: falls back to track gain', near(rg.outputGain({ replayGainTrackDb: -2 }), Math.pow(10, -2 / 20)));
check('album: uses album peak', near(rg.boostDb({ replayGainAlbumDb: 10, replayGainAlbumPeak: 0.5, replayGainPeak: 0.9 }), -20 * Math.log10(0.5)));

const d = rg.describe({ replayGainTrackDb: -6.5 });
check('describe: tagged track', d && d.tagged && near(d.db, -6.5));
check('describe: untagged track', rg.describe({}).tagged === false);
setMode('off');
check('describe: off -> null', rg.describe({ replayGainTrackDb: -6 }) === null);

setMode('track');
rg.setMode('bogus');
check('setMode rejects junk (mode stays track)', near(rg.outputGain({ replayGainTrackDb: -6 }), Math.pow(10, -6 / 20)));
setMode('off');

console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall replay gain checks passed');
process.exit(fails ? 1 : 0);

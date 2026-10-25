// Run with: node tests/spotify-tabs.test.js
// The music panel's four tabs: their order (bottom bar and swiping agree), stepping through them
// from a swipe, and that the page has what the swipe and the bottom bar rely on.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot } = require('./spotify-harness');

const assets = path.join(__dirname, '../app/src/main/assets');
const read = (f) => fs.readFileSync(path.join(assets, f), 'utf8');
let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

const ORDER = ['library', 'album', 'track', 'download'];     // Home, Songs, Now playing, Download

check('stepping through the tabs follows the order of the bottom bar', () => {
  const t = boot();
  window.SpotifyUI.setView('library');
  const seen = [t.view()];
  while (window.SpotifyUI.stepView(1)) seen.push(t.view());
  assert.deepStrictEqual(seen, ORDER);
  const back = [t.view()];
  while (window.SpotifyUI.stepView(-1)) back.push(t.view());
  assert.deepStrictEqual(back, ORDER.slice().reverse());
});

check('past either end nothing happens: the tab stays and nothing is reported as changed', () => {
  const t = boot();
  window.SpotifyUI.setView('library');
  assert.strictEqual(window.SpotifyUI.stepView(-1), false);
  assert.strictEqual(t.view(), 'library');
  window.SpotifyUI.setView('download');
  assert.strictEqual(window.SpotifyUI.stepView(1), false);
  assert.strictEqual(t.view(), 'download');
});

check('stepping works from any tab, including a jump made by tapping the bottom bar', () => {
  const t = boot();
  window.SpotifyUI.setView('track');
  assert.strictEqual(window.SpotifyUI.stepView(-1), true);
  assert.strictEqual(t.view(), 'album');
  window.SpotifyUI.setView('download');
  assert.strictEqual(window.SpotifyUI.stepView(-1), true);
  assert.strictEqual(t.view(), 'track');
});

check('the bottom bar lists the tabs in that same order, Download last, and each has a view', () => {
  const html = read('index.html');
  const nav = html.slice(html.indexOf('<nav id="sp-nav"'), html.indexOf('</nav>', html.indexOf('<nav id="sp-nav"')));
  const buttons = [...nav.matchAll(/data-sp-view="(\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(buttons, ORDER);
  buttons.forEach((v) => assert.ok(html.includes('id="sp-view-' + v + '"'), 'no view for ' + v));
  assert.ok(new RegExp("const VIEWS = \\['library', 'album', 'track', 'download'\\]").test(read('spotify-ui.js')));
});

check('the bottom bar also shows on Now playing (only the mini player is hidden there)', () => {
  const html = read('index.html');
  assert.ok(!/data-view="track"\] #sp-nav/.test(html), 'a rule still hides the bottom bar on Now playing');
  assert.ok(/data-view="track"\] #sp-mini \{ display: none; \}/.test(html), 'the mini player should hide on Now playing');
});

check('the Download songs button is gone from Home', () => {
  assert.ok(!read('index.html').includes('dl-open-btn'));
  assert.ok(!read('song-download.js').includes('dl-open-btn'));
});

check('swiping the panel switches tabs and no longer closes it', () => {
  const js = read('reader.js');
  const swipe = js.slice(js.indexOf('Swipe the music panel sideways'), js.indexOf('// Close a panel when tapping anywhere outside'));
  assert.ok(swipe.includes('SpotifyUI.stepView(dx < 0 ? 1 : -1)'), 'swipe does not step the tabs');
  assert.ok(!swipe.includes('closeAllPanels'), 'the swipe still closes the panel');
  assert.ok(swipe.includes('#audio-playlist-btn'), 'the playlist button keeps its own sideways swipe');
});

check('text in the music player cannot be selected, but the fields you type in still can', () => {
  const html = read('index.html');
  assert.ok(/#audio-panel \{ user-select: none; -webkit-user-select: none;/.test(html));
  assert.ok(/#audio-panel input, #audio-panel textarea \{ user-select: text;/.test(html));
});

console.log(n + ' checks passed');

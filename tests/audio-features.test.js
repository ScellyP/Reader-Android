const fs = require('fs');
const assert = require('assert');
const store = {};
global.window = global;
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: null, createElementNS: () => ({ setAttribute() {}, appendChild() {} }) };
global.Audio = function () { return { addEventListener() {}, pause() {}, play() { return Promise.resolve(); }, load() {} }; };
const calls = [];
window.AndroidBridge = null;
eval(fs.readFileSync((process.argv[2] || require('path').join(__dirname, '..', 'app/src/main/assets/audio-player.js')), 'utf8'));

const NA = window.NovelAudio, F = NA.features, M = NA._modules, S = NA._state;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

S.tracks = ['a','b','c','d'].map(x => ({ id: '/m/' + x + '.mp3', path: 'file:///m/' + x + '.mp3', title: x, durationSec: 100 }));
S.queue = S.tracks.map(x => x.id);

t('registry lists all eight modules', () => {
  assert.deepStrictEqual(F.describe().map(d => d.id),
    ['abRepeat','replayGain','audioDelay','crossfade','history','likes','customPlaylists','nativeEffects']);
});
t('defaults are deep-copied (not shared with module defaults)', () => {
  F.likes.toggle('/m/a.mp3');
  assert.deepStrictEqual(F.likes.defaults.ids, []);
  F.likes.toggle('/m/a.mp3');
});
t('replay gain: off by default => unity', () => {
  S.currentTrackId = '/m/a.mp3'; S.tracks[0].replayGainTrackDb = -6;
  assert.strictEqual(F.outputGain(), 1);
});
t('replay gain: track mode cuts by -6 dB', () => {
  F.replayGain.setMode('track');
  assert.ok(Math.abs(F.outputGain() - 0.501) < 0.002, F.outputGain());
  assert.strictEqual(F.replayGain.boostDb(S.tracks[0]), 0);
});
t('replay gain: positive gain becomes a native boost, JS stays <= 1', () => {
  S.tracks[0].replayGainTrackDb = 3;
  assert.strictEqual(F.outputGain(), 1);
  assert.strictEqual(F.replayGain.boostDb(S.tracks[0]), 3);
});
t('replay gain: peak limits the boost (no clipping)', () => {
  S.tracks[0].replayGainTrackDb = 6; S.tracks[0].replayGainPeak = 0.9;
  assert.ok(Math.abs(F.replayGain.boostDb(S.tracks[0]) - 0.915) < 0.01);
});
t('replay gain: album mode prefers album value; bad mode rejected', () => {
  S.tracks[0].replayGainPeak = undefined; S.tracks[0].replayGainAlbumDb = -3; S.tracks[0].replayGainTrackDb = -9;
  F.replayGain.setMode('album');
  assert.ok(Math.abs(F.outputGain() - 0.708) < 0.002);
  F.replayGain.setMode('bogus'); assert.strictEqual(S.features.replayGain.mode, 'album');
  F.replayGain.setMode('off');
});
t('a-b repeat loops back to A, only when both set, clears on new track', () => {
  const seeks = []; M.LocalAudioEngine.seek = s => seeks.push(s);
  S.positionSec = 10; F.abRepeat.setA();
  assert.strictEqual(F.abRepeat.setB(), null);            // B must be after A
  S.positionSec = 20; assert.strictEqual(F.abRepeat.setB(), 20);
  F.emit('progress', { positionSec: 19, durationSec: 100 }); assert.deepStrictEqual(seeks, []);
  F.emit('progress', { positionSec: 20.2, durationSec: 100 }); assert.deepStrictEqual(seeks, [10]);
  F.emit('trackStart', S.tracks[1]); assert.strictEqual(F.abRepeat.isActive(), false);
});
t('a-b repeat is never persisted', () => {
  S.positionSec = 1; F.abRepeat.setA();
  assert.ok(!('abRepeat' in F.serialize()));
});
t('history: newest first, deduped, capped', () => {
  F.emit('trackStart', S.tracks[0]); F.emit('trackStart', S.tracks[1]); F.emit('trackStart', S.tracks[0]);
  assert.deepStrictEqual(F.history.getIds().slice(0, 2), ['/m/a.mp3', '/m/b.mp3']);
  for (let i = 0; i < 150; i++) F.emit('trackStart', { id: '/x/' + i });
  assert.strictEqual(F.history.getIds().length, 100);
  F.history.clear(); F.emit('trackStart', S.tracks[2]);
});
t('likes toggle on current track', () => {
  S.currentTrackId = '/m/b.mp3';
  assert.strictEqual(F.likes.toggle(), true); assert.strictEqual(F.likes.isLiked(), true);
});
t('custom playlists CRUD', () => {
  const id = F.customPlaylists.create('  Focus  ', ['/m/c.mp3']);
  assert.strictEqual(id, 1);
  assert.strictEqual(F.customPlaylists.create('   '), null);
  F.customPlaylists.addTracks(id, ['/m/c.mp3', '/m/d.mp3']);
  assert.deepStrictEqual(F.customPlaylists.getIds(id), ['/m/c.mp3', '/m/d.mp3']);
  F.customPlaylists.removeTrack(id, '/m/c.mp3');
  assert.strictEqual(F.customPlaylists.rename(id, 'Deep Focus'), true);
  assert.strictEqual(F.customPlaylists.list()[0].name, 'Deep Focus');
});
t('virtual selections drive the queue, unknown files dropped', () => {
  S.features.likes.ids.push('/gone.mp3');
  assert.deepStrictEqual(F.selectionFor('@liked'), ['/m/b.mp3']);
  assert.deepStrictEqual(F.selectionFor('@list:1'), ['/m/d.mp3']);
  assert.strictEqual(F.selectionFor('Lo-fi'), null);
  S.activePlaylist = '@liked';
  assert.deepStrictEqual(M.MediaLibrary.currentSelectionIds(), ['/m/b.mp3']);
  S.activePlaylist = 'all';
  assert.strictEqual(M.MediaLibrary.currentSelectionIds().length, 4);
  assert.ok(F.listVirtualPlaylists().some(p => p.id === '@list:1'));
});
t('removing the active custom playlist falls back to All', () => {
  S.activePlaylist = '@list:1'; F.customPlaylists.remove(1); assert.strictEqual(S.activePlaylist, 'all');
});
t('persistence round-trip through the real Prefs', () => {
  F.customPlaylists.create('Keep', ['/m/a.mp3']); F.audioDelay.setOffsetMs(150); F.crossfade.setSeconds(4);
  F.replayGain.setMode('track'); M.Prefs.save();
  const saved = JSON.parse(store.novelReader_audioPrefs);
  assert.ok(saved.features.likes && saved.features.history && saved.features.customPlaylists);
  assert.ok(!saved.features.abRepeat && !saved.features.nativeEffects);
  S.features.likes.ids = []; S.features.customPlaylists.lists = []; S.features.audioDelay.offsetMs = 0;
  M.Prefs.load();
  assert.deepStrictEqual(S.features.likes.ids.slice(0, 1), ['/m/b.mp3']);
  assert.strictEqual(S.features.customPlaylists.lists[0].name, 'Keep');
  assert.strictEqual(S.features.audioDelay.offsetMs, 150);
  assert.strictEqual(S.features.crossfade.seconds, 4);
  assert.strictEqual(S.features.replayGain.mode, 'track');
});
t('hostile / mistyped saved values are ignored', () => {
  F.restore({ likes: { ids: 'nope' }, audioDelay: { offsetMs: 'x', evil: 1 }, crossfade: { seconds: '9' }, __proto__x: 1 });
  assert.ok(Array.isArray(S.features.likes.ids));
  assert.strictEqual(S.features.audioDelay.offsetMs, 150);
  assert.ok(!('evil' in S.features.audioDelay));
  assert.strictEqual(S.features.crossfade.seconds, 4);
});
t('audio delay / crossfade clamp their ranges', () => {
  F.audioDelay.setOffsetMs(99999); assert.strictEqual(F.audioDelay.getOffsetMs(), 2000);
  F.audioDelay.setOffsetMs(-99999); assert.strictEqual(F.audioDelay.getOffsetMs(), -2000);
  F.crossfade.setSeconds(99); assert.strictEqual(S.features.crossfade.seconds, 12);
});
t('crossfade: inert without engine support, fires once with it', () => {
  S.currentTrackId = '/m/a.mp3'; S.queue = S.tracks.map(x => x.id); S.queueIndex = 0; S.repeat = 'off';
  F.crossfade.setSeconds(5); F.emit('trackStart', S.tracks[0]);
  F.emit('progress', { positionSec: 97, durationSec: 100 });               // no beginCrossfade: nothing happens
  const got = []; M.LocalAudioEngine.beginCrossfade = (id, s) => got.push([id, s]);
  F.emit('progress', { positionSec: 90, durationSec: 100 }); assert.deepStrictEqual(got, []);   // outside window
  F.emit('progress', { positionSec: 96, durationSec: 100 }); F.emit('progress', { positionSec: 97, durationSec: 100 });
  assert.deepStrictEqual(got, [['/m/b.mp3', 5]]);
  delete M.LocalAudioEngine.beginCrossfade;
});
t('a throwing module cannot break the others', () => {
  const orig = console.error; console.error = () => {};
  F.register({ id: 'boom', label: 'x', status: 'stub', defaults: {}, trackStart() { throw new Error('boom'); } });
  F.emit('trackStart', S.tracks[0]); console.error = orig;
  assert.ok(F.history.getIds().includes('/m/a.mp3'));
});
t('native EQ goes over the bridge when present, falls back to a note when not', () => {
  const sent = []; let note = '';
  M.AudioUI.setNote = s => { note = s; };
  S.eqBands = [0,1,2,3,4,5,6,7,8,9];
  M.NativeAudioEngine.setEqualizer([1,1,1,1,1,1,1,1,1,1]);
  assert.ok(/isn.t applied/.test(note));                                   // no bridge => old note
  window.AndroidBridge = { nativeAudioSetEqualizer: (j, p) => sent.push([JSON.parse(j), p]), nativeAudioSetBoostDb() {}, nativeAudioSetVolume() {} };
  note = ''; M.NativeAudioEngine.setEqualizer([2,2,2,2,2,2,2,2,2,2]); M.NativeAudioEngine.setPreamp(3);
  assert.strictEqual(note, ''); assert.deepStrictEqual(sent[0][0], [2,2,2,2,2,2,2,2,2,2]); assert.strictEqual(sent[1][1], 3);
});
t('device without effects reports itself via the info callback', () => {
  let note = ''; M.AudioUI.setNote = s => { note = s; };
  NA._modules.AudioEngine; // getter exists
  window.onNativeAudioEffectsInfo(JSON.stringify({ available: false }));
  assert.strictEqual(F.nativeEffects.info.available, false);
});
console.log('\n' + n + ' checks passed');

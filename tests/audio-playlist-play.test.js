// Run with: node tests/audio-playlist-play.test.js
// The big Play button inside a playlist: when the song that is loaded is not part of that playlist,
// it starts the playlist from its top song instead of carrying on with the other song.
const assert = require('assert');
const { launch, check, finish } = require('./audio-harness');

const mk = (name, playlist, i) => ({ id: '/Novel/Audio/' + (playlist ? playlist + '/' : '') + name + '.mp3',
  path: '/Novel/Audio/' + (playlist ? playlist + '/' : '') + name + '.mp3', title: name, durationSec: 100 + i, playlist });
const A = mk('a', 'Rock', 0), B = mk('b', 'Rock', 1), C = mk('c', 'Jazz', 2), D = mk('d', null, 3);
const LIBRARY = [A, B, C, D];

function start(saved) {
  const t = launch({ saved: saved || null, bluetooth: false });
  t.nativeReady(); t.scanFinished(LIBRARY);
  t.mods = t.app._modules;
  t.open = (name) => t.mods.AudioUI.selectPlaylist(name);        // what tapping a playlist row does
  t.play = (id) => t.mods.AudioEngine.play(id);
  t.calls.length = 0;
  return t;
}

check('a song from another playlist is loaded: Play starts the playlist from its top song', () => {
  const t = start();
  t.play(D.id); t.calls.length = 0;
  t.open('Rock');
  assert.strictEqual(t.app.currentSongInSelection(), false);
  assert.strictEqual(t.app.playSelectionFromTop(), true);
  assert.deepStrictEqual(t.calls, ['load ' + A.id, 'play']);
  assert.strictEqual(t.state.currentTrackId, A.id);
  assert.strictEqual(t.state.positionSec, 0);
  assert.deepStrictEqual(t.state.queue, [A.id, B.id]);          // only this playlist is in the queue
  assert.strictEqual(t.app.currentSongInSelection(), true);
});

check('it works the same when the other song is playing or paused', () => {
  const t = start();
  t.play(C.id); t.state.playing = false; t.calls.length = 0;
  t.open('Rock');
  assert.strictEqual(t.app.playSelectionFromTop(), true);
  assert.strictEqual(t.state.currentTrackId, A.id);
});

check('the song is already in that playlist: nothing special happens (normal play / pause)', () => {
  const t = start();
  t.play(B.id); t.calls.length = 0;
  t.open('Rock');
  assert.strictEqual(t.app.currentSongInSelection(), true);
  assert.strictEqual(t.app.playSelectionFromTop(), false);
  assert.deepStrictEqual(t.calls, []);
  assert.strictEqual(t.state.currentTrackId, B.id);            // carries on with song b, not a
});

check('All songs always contains the current song, so Play keeps its normal behaviour there', () => {
  const t = start();
  t.play(D.id); t.calls.length = 0;
  t.open('all');
  assert.strictEqual(t.app.playSelectionFromTop(), false);
  assert.deepStrictEqual(t.calls, []);
});

check('nothing loaded yet: the normal play (which starts the top song) is left to do it', () => {
  const t = start();
  t.open('Jazz');
  assert.strictEqual(t.app.currentSongInSelection(), true);
  assert.strictEqual(t.app.playSelectionFromTop(), false);
  t.mods.AudioEngine.play();                                   // what the normal Play button does
  assert.deepStrictEqual(t.calls, ['load ' + C.id, 'play']);
});

check('with shuffle on, the old song is not smuggled into the new queue', () => {
  const t = start();
  t.play(D.id);
  t.mods.PlaybackQueue.setShuffle(true);
  t.open('Rock');
  assert.strictEqual(t.app.playSelectionFromTop(), true);
  assert.deepStrictEqual(t.state.queue.slice().sort(), [A.id, B.id].sort());
  assert.ok(!t.state.queue.includes(D.id));
  assert.ok([A.id, B.id].includes(t.state.currentTrackId));
  assert.strictEqual(t.state.queue[t.state.queueIndex], t.state.currentTrackId);
});

check('it works for the virtual playlists too (Liked songs: its first song)', () => {
  const t = start();
  t.play(D.id); t.play(C.id);
  t.app.features.likes.toggle();                               // like song c
  t.play(A.id); t.calls.length = 0;
  t.open('@liked');
  assert.strictEqual(t.app.playSelectionFromTop(), true);
  assert.strictEqual(t.state.currentTrackId, C.id);
});

check('an empty playlist is left alone', () => {
  const t = start();
  t.play(D.id); t.calls.length = 0;
  t.open('@liked');                                            // nothing liked yet
  assert.strictEqual(t.app.playSelectionFromTop(), false);
  assert.deepStrictEqual(t.calls, []);
  assert.strictEqual(t.state.currentTrackId, D.id);
});

finish();

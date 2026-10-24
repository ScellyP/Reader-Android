// Run with: node tests/audio-gestures.test.js
// The player-side half of two gestures: the shuffle button starts the music when nothing is
// playing, and likeCurrent() (called by reader.js on a double tap in the middle of the screen)
// adds the current song to Liked without ever removing it.
const assert = require('assert');
const { launch, check, finish, TRACKS } = require('./audio-harness');

const [A, B, C] = TRACKS.map(t => t.id);
// Math.random() = 0 turns a shuffle of [a, b, c] into [b, c, a], so "shuffled" is checkable.
const realRandom = Math.random;
const withFixedShuffle = fn => { Math.random = () => 0; try { fn(); } finally { Math.random = realRandom; } };
const ready = t => { t.nativeReady(); t.scanFinished(); return t; };

check('shuffle tapped while stopped: shuffle turns on and a random song starts', () => withFixedShuffle(() => {
  const t = ready(launch());
  assert.deepStrictEqual(t.calls, []);
  t.click('audio-shuffle-btn');
  assert.strictEqual(t.state.shuffle, true);
  assert.deepStrictEqual(t.state.queue, [B, C, A]);
  assert.deepStrictEqual(t.calls, ['load ' + B, 'play']);
  assert.strictEqual(t.state.playing, true);
  assert.strictEqual(t.state.positionSec, 0);
  assert.strictEqual(t.savedPrefs().shuffle, true);
}));

check('a remembered but not playing song is not forced to the front of the shuffle', () => withFixedShuffle(() => {
  const t = ready(launch({ saved: { lastTrackId: A } }));
  assert.strictEqual(t.state.currentTrackId, A);
  t.click('audio-shuffle-btn');
  assert.deepStrictEqual(t.calls, ['load ' + B, 'play']);
}));

check('shuffle tapped while a song plays: only the rest is reshuffled, nothing restarts', () => withFixedShuffle(() => {
  const t = ready(launch());
  t.app._modules.AudioEngine.play(A);
  assert.deepStrictEqual(t.calls, ['load ' + A, 'play']);
  t.click('audio-shuffle-btn');
  assert.strictEqual(t.state.shuffle, true);
  assert.deepStrictEqual(t.state.queue, [A, C, B]);          // A stays first, the rest is shuffled
  assert.deepStrictEqual(t.calls, ['load ' + A, 'play']);    // no second load
}));

check('shuffle tapped to turn it off starts nothing, playing or not', () => withFixedShuffle(() => {
  const t = ready(launch());
  t.click('audio-shuffle-btn');                              // on, playing
  t.calls.length = 0;
  t.click('audio-shuffle-btn');                              // off while playing
  assert.strictEqual(t.state.shuffle, false);
  t.state.shuffle = true; t.state.playing = false;
  t.click('audio-shuffle-btn');                              // off while stopped
  assert.strictEqual(t.state.shuffle, false);
  assert.deepStrictEqual(t.calls, []);
}));

check('shuffle tapped with an empty library does nothing but switch on', () => {
  const t = launch();
  t.nativeReady(); t.scanFinished([]);
  t.click('audio-shuffle-btn');
  assert.strictEqual(t.state.shuffle, true);
  assert.deepStrictEqual(t.calls, []);
});

check('double-tap like: nothing to like until a song is current', () => {
  const t = ready(launch());
  assert.strictEqual(t.app.hasCurrentTrack(), false);
  assert.strictEqual(t.app.likeCurrent(), false);
  assert.deepStrictEqual(t.state.features.likes.ids, []);
});

check('double-tap like adds the current song, saves it, and never removes it', () => {
  const t = ready(launch());
  t.app._modules.AudioEngine.play(B);
  assert.strictEqual(t.app.hasCurrentTrack(), true);
  assert.strictEqual(t.app.likeCurrent(), true);
  assert.deepStrictEqual(t.state.features.likes.ids, [B]);
  assert.deepStrictEqual(t.savedPrefs().features.likes.ids, [B]);
  assert.strictEqual(t.app.likeCurrent(), true);             // a second double tap: still liked, once
  assert.deepStrictEqual(t.state.features.likes.ids, [B]);
});

check('double-tap like works for a remembered song that is not playing, and the heart button still unlikes', () => {
  const t = ready(launch({ saved: { lastTrackId: C } }));
  assert.strictEqual(t.app.likeCurrent(), true);
  assert.deepStrictEqual(t.state.features.likes.ids, [C]);
  t.click('audio-like-btn');                                 // the heart button is still a toggle
  assert.deepStrictEqual(t.state.features.likes.ids, []);
  assert.strictEqual(t.app.likeCurrent(), true);
  assert.deepStrictEqual(t.state.features.likes.ids, [C]);
});

finish();

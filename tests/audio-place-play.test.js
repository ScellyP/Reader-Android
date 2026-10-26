// Run with: node tests/audio-place-play.test.js
// NovelAudio.playAfterRescan: the Download tab placed a song in the library; rescan, then start
// playing it inside its playlist.
const assert = require('assert');
const { launch } = require('./audio-harness');

const R = '/storage/emulated/0/Novel/Audio/';
const mk = (rel, playlist) => ({ id: R + rel, path: 'file://' + R + rel, title: rel, durationSec: 100, playlist });
const A = mk('Rock/a.mp3', 'Rock'), B = mk('Rock/b.mp3', 'Rock'), C = mk('Jazz/c.mp3', 'Jazz');
const NEW = mk('Road Trip/New Song.mp3', 'Road Trip');
const ROOT_SONG = mk('Plain.mp3', null);

let n = 0;
async function check(name, fn) { await fn(); n++; console.log('ok -', name); }

// A phone whose scans return whatever `answers` says, one entry per scan request.
function start(answers) {
  let t = null;
  let scans = 0;
  t = launch({ onScanAudio: () => { const lib = answers[Math.min(scans++, answers.length - 1)]; setTimeout(() => t.scanFinished(lib), 5); } });
  t.nativeReady();
  t.scanFinished([A, B, C]);
  t.calls.length = 0;
  t.scanCount = () => scans;
  return t;
}

(async () => {
  await check('the placed song is found after the rescan and starts playing inside its playlist', async () => {
    const t = start([[A, B, C, NEW]]);
    const ok = await t.app.playAfterRescan(NEW.id, 'Road Trip');
    assert.strictEqual(ok, true);
    assert.strictEqual(t.state.currentTrackId, NEW.id);
    assert.strictEqual(t.state.activePlaylist, 'Road Trip');
    assert.deepStrictEqual(t.state.queue, [NEW.id]);
    assert.deepStrictEqual(t.calls, ['load ' + NEW.path, 'play']);
    assert.strictEqual(t.scanCount(), 1);
  });

  await check('a song with no playlist plays inside All songs', async () => {
    const t = start([[A, B, C, ROOT_SONG]]);
    assert.strictEqual(await t.app.playAfterRescan(ROOT_SONG.id, ''), true);
    assert.strictEqual(t.state.activePlaylist, 'all');
    assert.strictEqual(t.state.currentTrackId, ROOT_SONG.id);
    assert.ok(t.state.queue.includes(A.id) && t.state.queue.includes(ROOT_SONG.id));
  });

  await check('it replaces whatever was playing', async () => {
    const t = start([[A, B, C, NEW]]);
    t.app._modules.AudioEngine.play(A.id);
    t.calls.length = 0;
    await t.app.playAfterRescan(NEW.id, 'Road Trip');
    assert.strictEqual(t.state.currentTrackId, NEW.id);
    assert.deepStrictEqual(t.calls, ['load ' + NEW.path, 'play']);
  });

  await check('a scan that was already running and missed the song is followed by another', async () => {
    const t = start([[A, B, C], [A, B, C, NEW]]);
    const ok = await t.app.playAfterRescan(NEW.id, 'Road Trip');
    assert.strictEqual(ok, true);
    assert.strictEqual(t.scanCount(), 2);
    assert.strictEqual(t.state.currentTrackId, NEW.id);
  });

  await check('a song that never shows up: three scans, then false, and nothing is played', async () => {
    const t = start([[A, B, C]]);
    const before = t.state.currentTrackId;
    assert.strictEqual(await t.app.playAfterRescan(NEW.id, 'Road Trip'), false);
    assert.strictEqual(t.scanCount(), 3);
    assert.strictEqual(t.state.currentTrackId, before);
    assert.deepStrictEqual(t.calls, []);
  });

  console.log(n + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

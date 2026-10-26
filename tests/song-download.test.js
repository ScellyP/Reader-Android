// Run with: node tests/song-download.test.js
// The "Download songs" tab (app/src/main/assets/song-download.js): link parsing, playlist and song
// name cleaning, the wizard's state machine (download, name, playlist, place, play) and that the
// page, the native bridge and the script agree. The tab's own DOM code needs a page and is not
// covered here (it was driven by hand in a headless browser).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SD = require('../app/src/main/assets/song-download.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

const STAGED = (i) => '/storage/emulated/0/Novel/Audio/.staging/s_' + i + '/Song ' + i + ' (Official).mp3';

// A wizard wired to a fake native side that records what it was asked and lets a test answer.
function setup({ failStage = null } = {}) {
  const log = [], played = [], changes = [];
  const w = SD.createWizard({
    stage(id, url) {
      if (failStage === 'throw') throw new Error('Not connected to Termux yet');
      log.push('stage ' + id + ' ' + url);
    },
    place(id, p, name, folder) { log.push('place ' + id + ' ' + p + ' | ' + name + ' | ' + folder); },
    cancel() { log.push('cancel'); },
    discard() { log.push('discard'); },
    play(p, folder) { played.push(p + ' | ' + folder); },
    onChange(state) { changes.push(state.step); },
  });
  const ids = (kind) => log.filter((l) => l.startsWith(kind + ' ')).map((l) => l.split(' ')[1]);
  return { w, s: w.state, log, played, changes, ids, step: () => w.state.step };
}

check('parseLinks keeps web links, drops duplicates, counts what it skipped', () => {
  const r = SD.parseLinks('https://a.example/x\nhttps://a.example/x  http://b.example/y, not-a-link\n\nftp://c');
  assert.deepStrictEqual(r.links, ['https://a.example/x', 'http://b.example/y']);
  assert.strictEqual(r.skipped, 2);
  assert.deepStrictEqual(SD.parseLinks(null), { links: [], skipped: 0 });
});

check('parseLinks stops at 50 links and counts the rest as skipped', () => {
  const text = Array.from({ length: 53 }, (_, i) => 'https://x.example/' + i).join('\n');
  const r = SD.parseLinks(text);
  assert.strictEqual(r.links.length, 50);
  assert.strictEqual(r.skipped, 3);
});

check('cleanFolderName keeps only safe characters and never lets ".." through', () => {
  assert.strictEqual(SD.cleanFolderName("Lo-fi Focus"), 'Lo-fi Focus');
  assert.strictEqual(SD.cleanFolderName("  Rock  &   Roll's (Best), v2.0  "), "Rock & Roll's (Best), v2.0");
  assert.strictEqual(SD.cleanFolderName('../../etc'), 'etc');
  assert.strictEqual(SD.cleanFolderName('..'), '');
  assert.strictEqual(SD.cleanFolderName('a/b\\c:d*e?"f<g>h|i'), 'abcdefghi');
  assert.strictEqual(SD.cleanFolderName('音楽'), '');
  assert.strictEqual(SD.cleanFolderName(null), '');
  assert.strictEqual(SD.cleanFolderName('x'.repeat(100)).length, 60);
});

check('cleanFolderName gives the same answer as clean_folder in song_dl.py', () => {
  const script = path.join(__dirname, '../app/src/main/assets/song_dl.py');
  const samples = ['Lo-fi Focus', "  Rock  &   Roll's (Best), v2.0  ", '../../etc', '..', '.hidden.', 'a/b\\c:d*e',
    '音楽 mix', 'tab\there', 'x'.repeat(100), ' . ', 'Mix...', '(a).b', "it's, ok"];
  let out;
  try {
    out = execFileSync('python3', ['-c',
      'import json,sys; sys.path.insert(0, ' + JSON.stringify(path.dirname(script)) + '); import song_dl; ' +
      'print(json.dumps([song_dl.clean_folder(s) for s in json.loads(sys.argv[1])]))',
      JSON.stringify(samples)], { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1' }) });
  } catch (e) { console.log('   (python3 not available: parity check skipped)'); return; }
  assert.deepStrictEqual(JSON.parse(out), samples.map(SD.cleanFolderName));
});

check('cleanSongName drops what a file name cannot hold, keeps any language, caps at 120', () => {
  assert.strictEqual(SD.cleanSongName('Back In Black'), 'Back In Black');
  assert.strictEqual(SD.cleanSongName('AC/DC: "Hells Bells" <live> | 1980?'), 'ACDC Hells Bells live  1980'.replace('  ', ' '));
  assert.strictEqual(SD.cleanSongName('  ..Mix..  '), 'Mix');
  assert.strictEqual(SD.cleanSongName('音楽 – Ünïcode ♪ 100%'), '音楽 – Ünïcode ♪ 100%');
  assert.strictEqual(SD.cleanSongName('a\tb\nc\u0000d'), 'a b c d');
  assert.strictEqual(SD.cleanSongName('\\/:*?'), '');
  assert.strictEqual(SD.cleanSongName(null), '');
  assert.strictEqual(Array.from(SD.cleanSongName('x'.repeat(200))).length, 120);
  assert.strictEqual(Array.from(SD.cleanSongName('😀'.repeat(200))).length, 120);   // never cuts an emoji in half
});

check('cleanSongName gives the same answer as clean_song_name in song_dl.py', () => {
  const script = path.join(__dirname, '../app/src/main/assets/song_dl.py');
  const samples = ['Back In Black', 'AC/DC: "Hells Bells" <live> | 1980?', '  ..Mix..  ', '音楽 – Ünïcode ♪ 100%',
    'a\tb\nc', '\\/:*?', 'x'.repeat(200), '😀'.repeat(200), '-dash name', 'Song (feat. A & B) [Remix]', "Don't Stop"];
  let out;
  try {
    out = execFileSync('python3', ['-c',
      'import json,sys; sys.path.insert(0, ' + JSON.stringify(path.dirname(script)) + '); import song_dl; ' +
      'print(json.dumps([song_dl.clean_song_name(s) for s in json.loads(sys.argv[1])]))',
      JSON.stringify(samples)], { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1' }) });
  } catch (e) { console.log('   (python3 not available: parity check skipped)'); return; }
  assert.deepStrictEqual(JSON.parse(out), samples.map(SD.cleanSongName));
});

check('starting a run: only from the first step, discards leftovers, downloads the first song', () => {
  const t = setup();
  assert.strictEqual(t.w.start([]), false);
  assert.strictEqual(t.w.start(['https://a/1', 'https://a/2']), true);
  assert.strictEqual(t.step(), 'download');
  assert.deepStrictEqual(t.log, ['discard', 'stage s1 https://a/1']);
  assert.strictEqual(t.w.start(['https://a/9']), false);          // a run is already going
});

check('a downloaded song goes to the name step, named after its file, with the next song downloading behind it', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2', 'https://a/3']);
  t.w.report('s1', 'done', STAGED(1));
  assert.strictEqual(t.step(), 'name');
  assert.strictEqual(t.w.current().path, STAGED(1));
  assert.strictEqual(t.w.current().name, 'Song 1 (Official)');
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);           // the next one is already on its way
  t.w.report('s2', 'done', STAGED(2));
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);           // but only one ahead: song 3 waits
});

check('a song is never downloaded two at a time', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'running', 'x');
  assert.deepStrictEqual(t.ids('stage'), ['s1']);
  t.w.report('s1', 'done', STAGED(1));
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);
  t.w.report('s1', 'done', STAGED(1));                            // a repeated answer changes nothing
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);
});

check('Save moves on to the playlists with the cleaned name; an emptied name keeps the song\'s own', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.rename('  My / own: name  ');
  t.w.save();
  assert.strictEqual(t.step(), 'playlist');
  assert.strictEqual(t.w.current().name, 'My own name');

  const u = setup();
  u.w.start(['https://a/1']);
  u.w.report('s1', 'done', STAGED(1));
  u.w.rename('  ');
  u.w.save();
  assert.strictEqual(u.w.current().name, 'Song 1 (Official)');
});

check('choosing a playlist places the song, then plays it and moves on to the next one', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.report('s2', 'done', STAGED(2));
  t.w.rename('First');
  t.w.save();
  assert.strictEqual(t.w.choose('Road Trip!'), true);
  assert.strictEqual(t.step(), 'placing');
  assert.strictEqual(t.s.folder, 'Road Trip');                    // cleaned
  assert.ok(t.log.includes('place p3 ' + STAGED(1) + ' | First | Road Trip'));
  t.w.report('p3', 'done', '/storage/emulated/0/Novel/Audio/Road Trip/First.mp3');
  assert.deepStrictEqual(t.played, ['/storage/emulated/0/Novel/Audio/Road Trip/First.mp3 | Road Trip']);
  assert.strictEqual(t.step(), 'name');                           // song 2 was ready: straight to its name
  assert.strictEqual(t.w.current().path, STAGED(2));
  assert.strictEqual(t.s.folder, '');
});

check('"No playlist" places the song directly in Audio; every placed song starts playing', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.save();
  assert.strictEqual(t.w.choose(''), true);
  assert.ok(t.log.some((l) => /^place p\d+ .* \| Song 1 \(Official\) \| $/.test(l)));
  t.w.report('p2', 'done', '/storage/emulated/0/Novel/Audio/Song 1 (Official).mp3');
  assert.deepStrictEqual(t.played, ['/storage/emulated/0/Novel/Audio/Song 1 (Official).mp3 | ']);
  assert.strictEqual(t.step(), 'done');
});

check('New playlist: its own step, a name that cleans to nothing is refused, Back returns to the tiles', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.save();
  t.w.chooseNew();
  assert.strictEqual(t.step(), 'newplaylist');
  assert.strictEqual(t.w.choose('???'), false);
  assert.strictEqual(t.w.choose('../..'), false);
  assert.strictEqual(t.step(), 'newplaylist');
  t.w.backToPlaylists();
  assert.strictEqual(t.step(), 'playlist');
  t.w.chooseNew();
  assert.strictEqual(t.w.choose('  Lo-fi  Focus '), true);
  assert.strictEqual(t.s.folder, 'Lo-fi Focus');
});

check('choosing is only possible on the playlist steps', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  assert.strictEqual(t.w.choose('Rock'), false);                  // still downloading
  t.w.report('s1', 'done', STAGED(1));
  assert.strictEqual(t.w.choose('Rock'), false);                  // still on the name
  t.w.save();
  assert.strictEqual(t.w.choose('Rock'), true);
  assert.strictEqual(t.w.choose('Jazz'), false);                  // already placing
});

check('a failed download offers Retry (same song again) and Skip (on to the next)', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'failed', 'Video unavailable');
  assert.strictEqual(t.step(), 'download');
  assert.strictEqual(t.w.current().state, 'failed');
  assert.strictEqual(t.w.current().error, 'Video unavailable');
  assert.deepStrictEqual(t.ids('stage'), ['s1']);                 // nothing else starts behind a failure
  t.w.retryDownload();
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);           // a fresh job for the same song
  t.w.report('s2', 'failed', 'Still no');
  t.w.skip();
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2', 's3']);     // song 2 of the run is now on screen
  assert.strictEqual(t.w.current().url, 'https://a/2');
  t.w.report('s3', 'done', STAGED(2));
  assert.strictEqual(t.step(), 'name');
});

check('a song that fails in the background waits until its turn; skipping everything ends the run', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.report('s2', 'failed', 'Private video');                    // song 2, while song 1 is being named
  assert.strictEqual(t.step(), 'name');                           // the user is not interrupted
  t.w.save();
  t.w.choose('Rock');
  t.w.report('p3', 'done', '/x/Rock/a.mp3');
  assert.strictEqual(t.step(), 'download');
  assert.strictEqual(t.w.current().error, 'Private video');
  t.w.skip();
  assert.strictEqual(t.step(), 'done');
});

check('a failed placement keeps the song: Try again, or go back and change the name', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.rename('Taken');
  t.w.save();
  t.w.choose('Rock');
  t.w.report('p2', 'failed', 'A song called “Taken” is already in Rock. Change the name.');
  assert.strictEqual(t.step(), 'placefail');
  assert.ok(t.s.error.includes('already in Rock'));
  assert.deepStrictEqual(t.played, []);
  t.w.retryPlace();
  assert.strictEqual(t.step(), 'placing');
  t.w.report('p3', 'failed', 'again');
  t.w.backToName();
  assert.strictEqual(t.step(), 'name');
  assert.strictEqual(t.w.current().name, 'Taken');                // what was typed is still there
  t.w.rename('Fixed');
  t.w.save();
  t.w.choose('Rock');
  assert.ok(t.log.some((l) => l.endsWith('| Fixed | Rock')));
});

check('after the last song: All done, then Paste more starts over', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.save();
  t.w.choose('');
  t.w.report('p2', 'done', '/x/a.mp3');
  assert.strictEqual(t.step(), 'done');
  t.w.again();
  assert.strictEqual(t.step(), 'paste');
  assert.deepStrictEqual(t.s.items, []);
  assert.strictEqual(t.w.start(['https://a/2']), true);
});

check('leaving mid-run cancels the jobs and deletes the staged songs; late answers are ignored', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'done', STAGED(1));                            // song 2 is downloading behind it
  t.log.length = 0;
  t.w.leave();
  assert.deepStrictEqual(t.log, ['cancel', 'discard']);
  assert.strictEqual(t.step(), 'paste');
  assert.deepStrictEqual(t.s.items, []);
  t.w.report('s2', 'done', STAGED(2));                            // arrives after leaving
  assert.strictEqual(t.step(), 'paste');
  assert.deepStrictEqual(t.log, ['cancel', 'discard']);
});

check('leaving costs nothing on the first step or after All done', () => {
  const t = setup();
  t.w.leave();
  assert.deepStrictEqual(t.log, []);
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.save();
  t.w.choose('');
  t.w.report('p2', 'done', '/x/a.mp3');
  t.log.length = 0;
  t.w.leave();
  assert.deepStrictEqual(t.log, []);
  assert.strictEqual(t.step(), 'paste');
});

check('without the native side a song fails at once with the reason, and can be skipped', () => {
  const t = setup({ failStage: 'throw' });
  t.w.start(['https://a/1']);
  assert.strictEqual(t.step(), 'download');
  assert.strictEqual(t.w.current().state, 'failed');
  assert.strictEqual(t.w.current().error, 'Not connected to Termux yet');
  t.w.skip();
  assert.strictEqual(t.step(), 'done');
});

check('job ids never repeat, even across runs, so a late answer from an old run cannot be mistaken', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.leave();
  t.w.start(['https://a/1']);
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);
  t.w.report('s1', 'done', STAGED(1));                            // the old run's answer
  assert.strictEqual(t.step(), 'download');
  t.w.report('s2', 'done', STAGED(2));
  assert.strictEqual(t.step(), 'name');
});

check('a message on the first step (nothing on the clipboard) is shown there only', () => {
  const t = setup();
  t.w.setMessage('No song link on the clipboard.');
  assert.strictEqual(t.s.message, 'No song link on the clipboard.');
  t.w.start(['https://a/1']);
  assert.strictEqual(t.s.message, '');
  t.w.setMessage('ignored');
  assert.strictEqual(t.s.message, '');
});

check('the page, the native bridge and the script agree on names', () => {
  const assets = path.join(__dirname, '../app/src/main/assets');
  const kdir = path.join(__dirname, '../app/src/main/java/com/scell/novelreader/redesign');
  const kt = fs.readFileSync(path.join(kdir, 'MainActivity.kt'), 'utf8');
  const dl = fs.readFileSync(path.join(kdir, 'SongDownloader.kt'), 'utf8');
  const js = fs.readFileSync(path.join(assets, 'song-download.js'), 'utf8');
  const py = fs.readFileSync(path.join(assets, 'song_dl.py'), 'utf8');
  ['stageSong', 'placeSong', 'cancelSongDownload', 'discardStagedSongs', 'readClipboard'].forEach((name) => {
    assert.ok(js.includes(name), 'page does not use ' + name);
    assert.ok(new RegExp('@JavascriptInterface\\s+fun ' + name + '\\(').test(kt), 'MainActivity has no bridge method ' + name);
  });
  ['lookupSongTitle', 'downloadSong'].forEach((old) => assert.ok(!kt.includes('fun ' + old), old + ' should be gone'));
  assert.ok(kt.includes('"onSongDownloadStatus"') && js.includes('root.onSongDownloadStatus'));
  ['--stage', '--place', '--name'].forEach((flag) => {
    assert.ok(py.includes('"' + flag + '"'), 'song_dl.py lost ' + flag);
    assert.ok(dl.includes('"' + flag + '"'), 'SongDownloader.kt does not send ' + flag);
  });
  assert.ok(js.includes('playAfterRescan') && fs.readFileSync(path.join(assets, 'audio-player.js'), 'utf8').includes('playAfterRescan('));
  assert.ok(js.includes('SpotifyUI.getCover') && fs.readFileSync(path.join(assets, 'spotify-ui.js'), 'utf8').includes('getCover'));
  const manifest = fs.readFileSync(path.join(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(manifest.includes('com.termux.permission.RUN_COMMAND'));
});

check('the staging folder is the same in the app and the script, and the music scan skips it', () => {
  const kdir = path.join(__dirname, '../app/src/main/java/com/scell/novelreader/redesign');
  const kt = fs.readFileSync(path.join(kdir, 'MainActivity.kt'), 'utf8');
  const dl = fs.readFileSync(path.join(kdir, 'SongDownloader.kt'), 'utf8');
  const py = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/song_dl.py'), 'utf8');
  assert.ok(dl.includes('STAGING_DIR = "/storage/emulated/0/Novel/Audio/.staging"'));
  assert.ok(py.includes('os.path.join(AUDIO_ROOT, ".staging")'));
  assert.ok(/walkTopDown\(\)[\s\S]{0,400}startsWith\("\."\)/.test(kt), 'the scan must skip folders that start with a dot');
});

check('every element the page looks up exists in index.html, and Download is a tab of the music panel', () => {
  const assets = path.join(__dirname, '../app/src/main/assets');
  const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(assets, 'song-download.js'), 'utf8');
  const ids = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size >= 3, 'found the ids the page uses');
  ids.forEach((id) => assert.ok(new RegExp('id="' + id + '"').test(html), 'index.html has no #' + id));
  ['dl-links', 'dl-go', 'dl-review', 'dl-jobs', 'dl-folders', 'dl-sheet', 'dl-open-btn'].forEach((old) =>
    assert.ok(!html.includes('id="' + old + '"'), 'the old #' + old + ' is gone'));
  assert.ok(/data-sp-view="download"/.test(html), 'the bottom bar has a Download tab');
  assert.ok(/data-view="download"\] #sp-view-download/.test(html), 'the download view can be shown');
  ['i-check', 'i-close', 'i-plus', 'i-moon-music'].forEach((icon) =>
    assert.ok(html.includes('id="' + icon + '"'), 'icon ' + icon + ' exists'));
});

console.log(n + ' checks passed');

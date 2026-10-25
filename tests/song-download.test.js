// Run with: node tests/song-download.test.js
// The "Download songs" tab (app/src/main/assets/song-download.js): link parsing, playlist and song
// name cleaning, the download queue (including the "check the names first" step) and that the page,
// the native bridge and the script agree. The tab itself needs a page and is not covered.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SD = require('../app/src/main/assets/song-download.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

// A queue wired to a fake native side: records starts and lets a test answer them.
function setup({ failStart = null } = {}) {
  const started = [], cancels = [], changes = [], batches = [], calls = [];
  const queue = SD.createQueue({
    start(job) {
      if (failStart === 'throw') throw new Error('Not connected to Termux yet');
      if (failStart === 'false') return false;
      started.push(job.id);
      calls.push(job.phase + ' ' + job.id + (job.phase === 'download' ? ' as "' + job.name + '"' : ''));
    },
    cancel() { cancels.push(1); },
    onChange(jobs) { changes.push(jobs.map((j) => j.state).join(',')); },
    onBatchDone(r) { batches.push(r); },
  });
  const states = () => queue.jobs.map((j) => j.state);
  return { queue, started, calls, cancels, changes, batches, states };
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

check('the queue runs one job at a time, in order, and reports one result per job', () => {
  const t = setup();
  t.queue.add(['https://a/1', 'https://a/2', 'https://a/3'], 'Mix');
  assert.deepStrictEqual(t.started, ['j1']);
  assert.deepStrictEqual(t.states(), ['running', 'waiting', 'waiting']);
  assert.ok(t.queue.busy());
  t.queue.report('j1', 'running', 'Converting…');
  assert.strictEqual(t.queue.jobs[0].message, 'Converting…');
  t.queue.report('j1', 'done', 'Saved 1');
  t.queue.report('j1', 'failed', 'late and ignored');          // a second answer changes nothing
  assert.deepStrictEqual(t.started, ['j1', 'j2']);
  t.queue.report('j2', 'failed', 'Video unavailable');
  t.queue.report('j3', 'done', 'Saved 3');
  assert.deepStrictEqual(t.states(), ['done', 'failed', 'done']);
  assert.strictEqual(t.queue.jobs[1].message, 'Video unavailable');
  assert.ok(!t.queue.busy());
  assert.deepStrictEqual(t.queue.jobs.map((j) => j.folder), ['Mix', 'Mix', 'Mix']);
});

check('onBatchDone fires once, when the queue runs empty, with the totals', () => {
  const t = setup();
  t.queue.add(['https://a/1', 'https://a/2'], '');
  t.queue.report('j1', 'done', '');
  assert.strictEqual(t.batches.length, 0);
  t.queue.report('j2', 'failed', 'x');
  assert.deepStrictEqual(t.batches, [{ done: 1, failed: 1, stopped: 0 }]);
  t.queue.report('j2', 'failed', 'again');
  assert.strictEqual(t.batches.length, 1);
});

check('a job that cannot start fails at once with the reason, and the next one still runs', () => {
  const thrown = setup({ failStart: 'throw' });
  thrown.queue.add(['https://a/1', 'https://a/2'], '');
  assert.deepStrictEqual(thrown.states(), ['failed', 'failed']);
  assert.strictEqual(thrown.queue.jobs[0].message, 'Not connected to Termux yet');
  assert.ok(!thrown.queue.busy());

  const refused = setup({ failStart: 'false' });
  refused.queue.add(['https://a/1'], '');
  assert.strictEqual(refused.queue.jobs[0].state, 'failed');
  assert.strictEqual(refused.queue.jobs[0].message, 'Could not start the download');
});

check('Retry puts a failed job back in the line and runs it again', () => {
  const t = setup();
  t.queue.add(['https://a/1'], 'Mix');
  t.queue.report('j1', 'failed', 'Network down');
  t.queue.retry('j1');
  assert.strictEqual(t.queue.jobs[0].state, 'running');
  assert.deepStrictEqual(t.started, ['j1', 'j1']);
  t.queue.report('j1', 'done', 'ok');
  t.queue.retry('j1');                                          // only failed/stopped jobs retry
  assert.strictEqual(t.queue.jobs[0].state, 'done');
});

check('Stop drops the waiting jobs, asks the running one to stop, and shows it as Stopped', () => {
  const t = setup();
  t.queue.add(['https://a/1', 'https://a/2', 'https://a/3'], '');
  t.queue.stop();
  assert.strictEqual(t.cancels.length, 1);
  assert.deepStrictEqual(t.states(), ['running', 'stopped', 'stopped']);
  t.queue.report('j1', 'failed', 'Stopped');
  assert.deepStrictEqual(t.states(), ['stopped', 'stopped', 'stopped']);
  assert.strictEqual(t.queue.jobs[0].message, 'Stopped');
  assert.deepStrictEqual(t.batches, [{ done: 0, failed: 0, stopped: 3 }]);
  assert.deepStrictEqual(t.started, ['j1']);                    // nothing else was started
});

check('checking names first: every name is looked up, then the jobs wait for the go-ahead', () => {
  const t = setup();
  t.queue.add(['https://a/1', 'https://a/2'], 'Mix', true);
  assert.deepStrictEqual(t.calls, ['title j1']);                  // one look-up at a time
  assert.deepStrictEqual(t.states(), ['running', 'waiting']);
  t.queue.report('j1', 'done', 'AC/DC - Back In Black (Official)');
  assert.strictEqual(t.queue.jobs[0].state, 'named');
  assert.strictEqual(t.queue.jobs[0].name, 'ACDC - Back In Black (Official)');   // what will be saved, already cleaned
  assert.strictEqual(t.queue.jobs[0].title, 'AC/DC - Back In Black (Official)');
  assert.deepStrictEqual(t.calls, ['title j1', 'title j2']);
  t.queue.report('j2', 'done', 'Hells Bells');
  assert.deepStrictEqual(t.states(), ['named', 'named']);
  assert.ok(t.queue.reviewing() && !t.queue.busy());
  assert.deepStrictEqual(t.batches, []);                          // not finished: the user still has to decide
  assert.deepStrictEqual(t.calls, ['title j1', 'title j2']);      // and nothing has been downloaded
});

check('after the go-ahead the songs are downloaded under the names shown, one at a time', () => {
  const t = setup();
  t.queue.add(['https://a/1', 'https://a/2'], 'Mix', true);
  t.queue.report('j1', 'done', 'First Song');
  t.queue.report('j2', 'done', 'Second Song');
  t.queue.rename('j2', '  My / own: name  ');                     // edited by the user; "keep" = left alone
  assert.strictEqual(t.queue.confirm(), 2);
  assert.deepStrictEqual(t.calls, ['title j1', 'title j2', 'download j1 as "First Song"']);
  t.queue.report('j1', 'done', 'Saved First Song.mp3 to Mix');
  assert.deepStrictEqual(t.calls.slice(3), ['download j2 as "My own name"']);
  assert.strictEqual(t.batches.length, 0);
  t.queue.report('j2', 'done', 'Saved');
  assert.deepStrictEqual(t.batches, [{ done: 2, failed: 0, stopped: 0 }]);
  assert.strictEqual(t.queue.confirm(), 0);                       // nothing left to confirm
});

check('an emptied name means "keep the song\'s own name"; rename only works while a job waits for the go-ahead', () => {
  const t = setup();
  t.queue.add(['https://a/1'], '', true);
  t.queue.report('j1', 'done', 'Title');
  t.queue.rename('j1', '   ');
  t.queue.confirm();
  assert.deepStrictEqual(t.calls, ['title j1', 'download j1 as ""']);
  t.queue.rename('j1', 'too late');
  assert.strictEqual(t.queue.jobs[0].name, '');
});

check('a failed name look-up shows the reason; Retry looks it up again and the others carry on', () => {
  const t = setup();
  t.queue.add(['https://a/1', 'https://a/2'], '', true);
  t.queue.report('j1', 'failed', 'Video unavailable');
  assert.deepStrictEqual(t.states(), ['failed', 'running']);
  assert.strictEqual(t.queue.jobs[0].message, 'Video unavailable');
  t.queue.report('j2', 'done', 'Fine');
  t.queue.retry('j1');
  assert.deepStrictEqual(t.calls.slice(-1), ['title j1']);
  t.queue.report('j1', 'done', 'Now Found');
  assert.deepStrictEqual(t.states(), ['named', 'named']);
});

check('Discard drops the jobs waiting for the go-ahead; Stop also ends a look-up in progress', () => {
  const t = setup();
  t.queue.add(['https://a/1', 'https://a/2'], '', true);
  t.queue.report('j1', 'done', 'One');
  t.queue.report('j2', 'done', 'Two');
  t.queue.discard();
  assert.strictEqual(t.queue.jobs.length, 0);
  assert.ok(!t.queue.reviewing());

  const u = setup();
  u.queue.add(['https://a/1', 'https://a/2'], '', true);
  u.queue.stop();
  assert.strictEqual(u.cancels.length, 1);
  u.queue.report('j1', 'done', 'Found it anyway');                // answered after Stop: it still counts as stopped
  assert.deepStrictEqual(u.states(), ['stopped', 'stopped']);
  assert.deepStrictEqual(u.calls, ['title j1']);                  // the second look-up never started
  assert.deepStrictEqual(u.batches, [{ done: 0, failed: 0, stopped: 2 }]);
});

check('links added while names are waiting join the same batch', () => {
  const t = setup();
  t.queue.add(['https://a/1'], '', true);
  t.queue.report('j1', 'done', 'One');
  t.queue.add(['https://a/2'], '', true);                         // does not wipe the named row
  assert.deepStrictEqual(t.states(), ['named', 'running']);
  t.queue.report('j2', 'done', 'Two');
  assert.strictEqual(t.queue.confirm(), 2);
});

check('a new batch clears the old finished rows; a batch added mid-run joins the line', () => {
  const t = setup();
  t.queue.add(['https://a/1'], '');
  t.queue.report('j1', 'done', '');
  t.queue.add(['https://a/2'], 'Other');
  assert.deepStrictEqual(t.queue.jobs.map((j) => j.url), ['https://a/2']);
  t.queue.add(['https://a/3'], 'Other');                        // while j2 runs: appended, not cleared
  assert.deepStrictEqual(t.queue.jobs.map((j) => j.url), ['https://a/2', 'https://a/3']);
  assert.strictEqual(t.queue.summary().total, 2);
});

check('shortLink drops the scheme, www and tracking query', () => {
  assert.strictEqual(SD.shortLink('https://www.youtube.com/watch?v=abc&list=x'), 'youtube.com/watch');
  assert.strictEqual(SD.shortLink('https://youtu.be/abc/'), 'youtu.be/abc');
  assert.ok(SD.shortLink('https://example.com/' + 'a'.repeat(80)).length <= 48);
});

check('the page, the native bridge and the script agree on names', () => {
  const assets = path.join(__dirname, '../app/src/main/assets');
  const kt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/novelreader/redesign/MainActivity.kt'), 'utf8');
  const js = fs.readFileSync(path.join(assets, 'song-download.js'), 'utf8');
  ['lookupSongTitle', 'downloadSong', 'cancelSongDownload'].forEach((name) => {
    assert.ok(js.includes('bridge.' + name), 'page does not call ' + name);
    assert.ok(new RegExp('@JavascriptInterface\\s+fun ' + name + '\\(').test(kt), 'MainActivity has no bridge method ' + name);
  });
  assert.ok(kt.includes('"onSongDownloadStatus"') && js.includes('root.onSongDownloadStatus'));
  const py = fs.readFileSync(path.join(assets, 'song_dl.py'), 'utf8');
  assert.ok(py.includes('"--title"') && py.includes('"--name"'), 'song_dl.py lost an option');
  const dl = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/novelreader/redesign/SongDownloader.kt'), 'utf8');
  assert.ok(dl.includes('"--title"') && dl.includes('"--name"'), 'SongDownloader.kt does not send the options');
  const manifest = fs.readFileSync(path.join(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(manifest.includes('com.termux.permission.RUN_COMMAND'));
});

check('every element the page looks up exists in index.html, and Download is a tab of the music panel', () => {
  const assets = path.join(__dirname, '../app/src/main/assets');
  const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(assets, 'song-download.js'), 'utf8');
  const ids = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size >= 15, 'found the ids the page uses');
  ids.forEach((id) => assert.ok(new RegExp('id="' + id + '"').test(html), 'index.html has no #' + id));
  assert.ok(!html.includes('id="dl-sheet"'), 'the old sheet is gone');
  assert.ok(/data-sp-view="download"/.test(html), 'the bottom bar has a Download tab');
  const ui = fs.readFileSync(path.join(assets, 'spotify-ui.js'), 'utf8');
  assert.ok(/const VIEWS = \[[^\]]*'download'/.test(ui), 'spotify-ui.js knows the download view');
  assert.ok(/data-view="download"\] #sp-view-download/.test(html), 'the download view can be shown');
});

console.log(n + ' checks passed');

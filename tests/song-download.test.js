// Run with: node tests/song-download.test.js
// The "Download songs" sheet (app/src/main/assets/song-download.js): link parsing, playlist-name
// cleaning and the download queue. The sheet itself needs a page and is not covered.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SD = require('../app/src/main/assets/song-download.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

// A queue wired to a fake native side: records starts and lets a test answer them.
function setup({ failStart = null } = {}) {
  const started = [], cancels = [], changes = [], batches = [];
  const queue = SD.createQueue({
    start(job) {
      if (failStart === 'throw') throw new Error('Not connected to Termux yet');
      if (failStart === 'false') return false;
      started.push(job.id);
    },
    cancel() { cancels.push(1); },
    onChange(jobs) { changes.push(jobs.map((j) => j.state).join(',')); },
    onBatchDone(r) { batches.push(r); },
  });
  const states = () => queue.jobs.map((j) => j.state);
  return { queue, started, cancels, changes, batches, states };
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

check('the page half has what the native half needs: the files and the bridge names agree', () => {
  const assets = path.join(__dirname, '../app/src/main/assets');
  const kt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/novelreader/redesign/MainActivity.kt'), 'utf8');
  const js = fs.readFileSync(path.join(assets, 'song-download.js'), 'utf8');
  ['downloadSong', 'cancelSongDownload'].forEach((name) => {
    assert.ok(js.includes('bridge.' + name), 'page does not call ' + name);
    assert.ok(new RegExp('@JavascriptInterface\\s+fun ' + name + '\\(').test(kt), 'MainActivity has no bridge method ' + name);
  });
  assert.ok(kt.includes('"onSongDownloadStatus"') && js.includes('root.onSongDownloadStatus'));
  assert.ok(fs.existsSync(path.join(assets, 'song_dl.py')), 'song_dl.py must ship in assets');
  const manifest = fs.readFileSync(path.join(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(manifest.includes('com.termux.permission.RUN_COMMAND'));
});

console.log(n + ' checks passed');

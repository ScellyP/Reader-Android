// Run with: node tests/chapter-tools.test.js
// "Fetch new chapters" and "Delete chapters": the two Python scripts in assets/scripts (run for real:
// a local fake novel site for the downloader's --resume mode, a temp folder for the delete script;
// skipped when python3 with requests + beautifulsoup4 is missing) and that the page, the Kotlin
// side, the manifest and the scripts agree. ChapterTools.kt itself needs a device.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'app/src/main/assets');
const KT = path.join(ROOT, 'app/src/main/java/com/scell/novelreader/redesign');
const DOWNLOADER = path.join(ASSETS, 'scripts/chapter_downloader.py');
const DELETER = path.join(ASSETS, 'scripts/delete_chapters.py');
const read = (p) => fs.readFileSync(p, 'utf8');

let n = 0;
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }

// ---------- static agreement ----------
const chapterTools = read(path.join(KT, 'ChapterTools.kt'));
const mainActivity = read(path.join(KT, 'MainActivity.kt'));
const manifest = read(path.join(ROOT, 'app/src/main/AndroidManifest.xml'));
const reader = read(path.join(ASSETS, 'reader.js'));
const html = read(path.join(ASSETS, 'index.html'));

check('the bridge methods the page calls exist in MainActivity', () => {
  ['fetchNewChapters', 'deleteChapters', 'chapterJobState'].forEach((m) => {
    assert.ok(reader.includes('.' + m), 'reader.js never uses ' + m);
    assert.ok(new RegExp('@JavascriptInterface\\s+fun ' + m + '\\(').test(mainActivity), 'MainActivity has no ' + m);
  });
  assert.ok(!/openTermux/.test(mainActivity + reader), 'the old openTermux is still around');
  assert.ok(!html.includes('open-termux-btn') && !reader.includes('open-termux-btn'));
});

check('the page answers the native state callback', () => {
  assert.ok(mainActivity.includes('"onChapterJob"'));
  assert.ok(reader.includes('window.onChapterJob'));
  ['id', 'kind', 'status', 'novel', 'count', 'message'].forEach((k) =>
    assert.ok(chapterTools.includes('.put("' + k + '"'), 'state lacks ' + k));
});

check('every element id reader.js looks up for these buttons exists in index.html', () => {
  ['fetch-chapters-btn', 'fetch-chapters-label', 'delete-chapters-btn', 'delete-layer', 'delete-text',
    'delete-input', 'delete-preview', 'delete-confirm', 'delete-cancel'].forEach((id) => {
    assert.ok(reader.includes("getElementById('" + id + "')"), 'reader.js does not use ' + id);
    assert.ok(html.includes('id="' + id + '"'), 'index.html lacks ' + id);
  });
});

check('manifest: Termux permission and package visibility', () => {
  assert.ok(manifest.includes('com.termux.permission.RUN_COMMAND'));
  assert.ok(manifest.includes('<package android:name="com.termux" />'));
  assert.ok(chapterTools.includes('RUN_COMMAND_PERMISSION = "com.termux.permission.RUN_COMMAND"'));
});

check('the scripts ChapterTools copies exist in assets, and its arguments match their options', () => {
  assert.ok(chapterTools.includes('DOWNLOADER = "chapter_downloader.py"'));
  assert.ok(chapterTools.includes('DELETER = "delete_chapters.py"'));
  const dl = read(DOWNLOADER), del = read(DELETER);
  ['--resume', '"-o"', '"-n"'].forEach((a) => assert.ok(chapterTools.includes(a), 'Kotlin lacks ' + a));
  assert.ok(dl.includes('"--resume"') && dl.includes('"-o"') && dl.includes('"-n"'));
  assert.ok(chapterTools.includes('"--yes"') && del.includes('"--yes"'));
});

check('the novel list skips dot folders and chapter loading skips next_chapter.txt', () => {
  assert.ok(/startsWith\("\."\)/.test(mainActivity));
  assert.ok(mainActivity.includes('ChapterTools.isChapterFile(f.name)'));
});

check('nothing is ever put together into a shell string', () => {
  assert.ok(!/RUN_COMMAND_(?:SHELL|STDIN)|"-c"|bash|\/bin\/sh/.test(chapterTools));
});

// ---------- the scripts, for real ----------
const py = spawnSync('python3', ['-c', 'import requests, bs4'], { encoding: 'utf8' });
const HAVE_PY = py.status === 0;

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { encoding: 'utf8' });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

function page(num, { next = true } = {}) {
  const paras = Array.from({ length: 5 }, (_, i) => '<p>Paragraph ' + (i + 1) + ' of chapter ' + num + ', long enough to count as real text.</p>').join('');
  return '<html><head><title>The Novel</title></head><body><h1>Chapter ' + num + ': Title ' + num + '</h1>' +
    '<div class="chapter-content">' + paras + '</div>' +
    (next ? '<a rel="next" href="/ch/' + (num + 1) + '">Next Chapter</a>' : '') + '</body></html>';
}

function startSite({ last = 6, broken = null } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const m = /^\/ch\/(\d+)$/.exec(req.url);
    hits.push(req.url);
    if (!m || +m[1] > last) { res.writeHead(404); return res.end('nope'); }
    if (broken === +m[1]) { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(+m[1], { next: +m[1] < last }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, hits, base: 'http://127.0.0.1:' + server.address().port })));
}

function novelFolder(base, upTo, { sourceOnLast = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-'));
  for (let i = 1; i <= upTo; i++) {
    const src = i === upTo && !sourceOnLast ? '' : 'Source: ' + base + '/ch/' + i + '\n';
    fs.writeFileSync(path.join(dir, 'Chapter ' + i + ' Title ' + i + '.txt'),
      'Chapter ' + i + ': Title ' + i + '\n' + src + '='.repeat(60) + '\n\nold body ' + i + '\n');
  }
  fs.writeFileSync(path.join(dir, 'next_chapter.txt'), base + '/ch/99\n'); // must be ignored
  return dir;
}

const chapterFiles = (dir) => fs.readdirSync(dir).filter((f) => /^Chapter/.test(f)).sort();

if (HAVE_PY) {
  const RESUME = (dir) => ['--resume', '-o', dir, '-n', '100000', '-d', '0'];

  check('--resume downloads everything after the newest chapter, up to the latest, and does not save the starting page again', async () => {
    const { server, hits, base } = await startSite({ last: 6 });
    try {
      const dir = novelFolder(base, 3);
      const before = read(path.join(dir, 'Chapter 3 Title 3.txt'));
      const r = await run('python3', [DOWNLOADER, ...RESUME(dir)]);
      assert.strictEqual(r.code, 0, r.out);
      assert.deepStrictEqual(chapterFiles(dir).map((f) => f.replace(/ Title \d+\.txt$/, '')),
        ['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5', 'Chapter 6']);
      assert.strictEqual(read(path.join(dir, 'Chapter 3 Title 3.txt')), before, 'the starting chapter was rewritten');
      assert.deepStrictEqual(hits, ['/ch/3', '/ch/4', '/ch/5', '/ch/6']);
      assert.ok(/Source: \S+\/ch\/6/.test(read(path.join(dir, 'Chapter 6 Title 6.txt'))));
      assert.ok(r.out.includes('3 chapter(s) saved'), r.out);
    } finally { server.close(); }
  });

  check('--resume with nothing new is a clean "up to date" (exit 0, nothing saved)', async () => {
    const { server, hits, base } = await startSite({ last: 3 });
    try {
      const dir = novelFolder(base, 3);
      const r = await run('python3', [DOWNLOADER, ...RESUME(dir)]);
      assert.strictEqual(r.code, 0, r.out);
      assert.strictEqual(chapterFiles(dir).length, 3);
      assert.deepStrictEqual(hits, ['/ch/3']);
      assert.ok(r.out.includes('up to date'), r.out);
    } finally { server.close(); }
  });

  check('--resume picks the highest chapter number, not the last file written', async () => {
    const { server, hits, base } = await startSite({ last: 5 });
    try {
      const dir = novelFolder(base, 4);
      const now = Date.now() / 1000;
      fs.utimesSync(path.join(dir, 'Chapter 1 Title 1.txt'), now + 100, now + 100); // newest file is chapter 1
      const r = await run('python3', [DOWNLOADER, ...RESUME(dir)]);
      assert.strictEqual(r.code, 0, r.out);
      assert.deepStrictEqual(hits, ['/ch/4', '/ch/5']);
    } finally { server.close(); }
  });

  check('--resume stops with exit 3 when a page fails, keeps what it got, and leaves the starting chapter alone', async () => {
    const { server, base } = await startSite({ last: 6, broken: 5 });
    try {
      const dir = novelFolder(base, 3);
      const r = await run('python3', [DOWNLOADER, ...RESUME(dir)]);
      assert.strictEqual(r.code, 3, r.out);
      assert.strictEqual(chapterFiles(dir).length, 4); // 1-3 plus the new 4
      assert.ok(/\[!\] Failed to fetch \S+\/ch\/5/.test(r.out), r.out);
      assert.ok(read(path.join(dir, 'next_chapter.txt')).includes('/ch/5'));
    } finally { server.close(); }
  });

  check('--resume refuses (exit 2) when the newest chapter has no Source line, or the folder is empty', async () => {
    const { server, hits, base } = await startSite();
    try {
      const noSource = novelFolder(base, 3, { sourceOnLast: false });
      let r = await run('python3', [DOWNLOADER, ...RESUME(noSource)]);
      assert.strictEqual(r.code, 2, r.out);
      assert.ok(r.out.includes('Source'), r.out);
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-'));
      r = await run('python3', [DOWNLOADER, ...RESUME(empty)]);
      assert.strictEqual(r.code, 2, r.out);
      assert.deepStrictEqual(hits, [], 'no request should have been made');
    } finally { server.close(); }
  });

  check('a normal run with a link still works as before', async () => {
    const { server, base } = await startSite({ last: 3 });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-'));
      const r = await run('python3', [DOWNLOADER, base + '/ch/2', '-o', dir, '-n', '10', '-d', '0']);
      assert.strictEqual(r.code, 0, r.out);
      assert.deepStrictEqual(chapterFiles(dir).map((f) => f.replace(/ Title \d+\.txt$/, '')), ['Chapter 2', 'Chapter 3']);
      let bad = await run('python3', [DOWNLOADER, '-o', dir]);
      assert.notStrictEqual(bad.code, 0); // neither a link nor --resume
    } finally { server.close(); }
  });

  check('delete_chapters.py --yes removes chapters 1..N, only .txt chapter files of that folder', async () => {
    const dir = novelFolder('http://x.test', 5);
    fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    const r = await run('python3', [DELETER, dir, '3', '--yes']);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(chapterFiles(dir).map((f) => f.replace(/ Title \d+\.txt$/, '')), ['Chapter 4', 'Chapter 5']);
    ['cover.jpg', 'notes.txt', 'next_chapter.txt'].forEach((f) => assert.ok(fs.existsSync(path.join(dir, f)), f + ' was deleted'));
    assert.ok(r.out.includes('Deleted 3 file(s)'), r.out);
    const bad = await run('python3', [DELETER, dir, '0', '--yes']);
    assert.strictEqual(bad.code, 1);
  });
} else {
  console.log('skip - python3 with requests and beautifulsoup4 not found; the script checks are skipped');
}

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); } catch (e) { console.log('FAIL -', name); throw e; }
    n++; console.log('ok -', name);
  }
  console.log(n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

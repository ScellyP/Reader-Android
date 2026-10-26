// Run with: node tests/song-dl-script.test.js
// The Termux script (app/src/main/assets/song_dl.py), run exactly the way the app runs it
// (python -c <script> ...) with stand-in yt-dlp and ffmpeg programs: --stage, --place, the old
// direct download, odd names, collisions, failures and Stop. Skipped when python3 or sh is missing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/song_dl.py'), 'utf8');
if (process.platform === 'win32' || spawnSync('python3', ['--version']).status !== 0) {
  console.log('(python3 or sh not available: script checks skipped)');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'songdl-'));
const bin = path.join(root, 'bin'), audio = path.join(root, 'audio'), tmp = path.join(root, 'tmp');
[bin, audio, tmp].forEach((d) => fs.mkdirSync(d, { recursive: true }));
const staging = path.join(audio, '.staging');

// A yt-dlp that "downloads" Cool Song.mp3 (or fails / hangs depending on the link) ...
fs.writeFileSync(path.join(bin, 'yt-dlp'), `#!/bin/sh
HOME_DIR=""; OUT=""; URL=""
for a in "$@"; do
  case "$a" in home:*) HOME_DIR="\${a#home:}";; --output=*) OUT="\${a#--output=}";; esac
  URL="$a"
done
case "$URL" in *bad*) echo "ERROR: Video unavailable" >&2; exit 1;; *slow*) sleep 30;; esac
FILE=$(printf '%s' "$OUT" | sed 's/%(title)s/Cool Song/; s/%(ext)s/mp3/; s/%%/%/g')
mkdir -p "$HOME_DIR"; echo audio > "$HOME_DIR/$FILE"; echo "$HOME_DIR/$FILE"
`, { mode: 0o755 });
// ... and an ffmpeg that copies the file and records the title tag it was asked to write.
fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!/bin/sh
IN=""; OUT=""; TITLE=""; prev=""
for a in "$@"; do
  [ "$prev" = "-i" ] && IN="$a"
  case "$a" in title=*) TITLE="\${a#title=}";; esac
  prev="$a"; OUT="$a"
done
case "$TITLE" in *failffmpeg*) exit 1;; esac
cp "$IN" "$OUT" && echo "TITLE=$TITLE" >> "$OUT"
`, { mode: 0o755 });

const env = Object.assign({}, process.env, {
  PATH: bin + path.delimiter + process.env.PATH, NOVEL_AUDIO_DIR: audio, TMPDIR: tmp, PYTHONDONTWRITEBYTECODE: '1',
});
delete env.NOVEL_STAGING_DIR;

function run(...args) {
  const r = spawnSync('python3', ['-c', SCRIPT, ...args], { encoding: 'utf8', env });
  const line = r.stdout.trim().split('\n').pop();
  assert.ok(line.startsWith('RESULT '), 'last line is a RESULT: ' + JSON.stringify(r.stdout) + r.stderr);
  const result = JSON.parse(line.slice(7));
  assert.strictEqual(r.status === 0, result.status === 'done', 'exit code is 0 exactly when the song was done');
  return result;
}
const stagedFiles = () => (fs.existsSync(staging) ? fs.readdirSync(staging, { recursive: true }).filter((f) => f.endsWith('.mp3')) : []);

let n = 0;
async function check(name, fn) { await fn(); n++; console.log('ok -', name); }

(async () => {
  let staged;

  await check('--stage downloads into its own folder under Audio/.staging and reports the file path', () => {
    const r = run('--stage', 'https://example.com/ok');
    assert.strictEqual(r.status, 'done');
    assert.ok(r.message.startsWith(staging + path.sep + 's_'), r.message);
    assert.ok(r.message.endsWith(path.sep + 'Cool Song.mp3'));
    assert.ok(fs.existsSync(r.message));
    staged = r.message;
    assert.deepStrictEqual(fs.readdirSync(audio).sort(), ['.staging', ], 'nothing but the staging folder appeared');
  });

  await check('--place renames (file name and title tag), moves into the playlist and tidies up', () => {
    const r = run('--place', staged, '--name', 'My Own Name', 'Rock');
    assert.strictEqual(r.status, 'done');
    assert.strictEqual(r.message, path.join(audio, 'Rock', 'My Own Name.mp3'));
    assert.ok(fs.readFileSync(r.message, 'utf8').includes('TITLE=My Own Name'), 'the title tag was written');
    assert.ok(!fs.existsSync(staged));
    assert.deepStrictEqual(fs.readdirSync(staging), [], 'the song\'s staging folder is gone');
  });

  await check('--place without a playlist puts the song directly in Audio; a clean name is passed through', () => {
    const s = run('--stage', 'https://example.com/ok').message;
    const r = run('--place', s, '--name', 'Plain', '');
    assert.strictEqual(r.message, path.join(audio, 'Plain.mp3'));
  });

  await check('a name that is already taken is refused and the staged song stays', () => {
    const s = run('--stage', 'https://example.com/ok').message;
    const r = run('--place', s, '--name', 'My Own Name', 'Rock');
    assert.strictEqual(r.status, 'failed');
    assert.ok(/already in Rock/.test(r.message), r.message);
    assert.ok(fs.existsSync(s), 'nothing was lost');
    assert.strictEqual(fs.readFileSync(path.join(audio, 'Rock', 'My Own Name.mp3'), 'utf8').includes('TITLE=My Own Name'), true, 'the existing song was not touched');
    staged = s;
  });

  await check('a failing ffmpeg fails the placement and leaves the staged song as it was', () => {
    const r = run('--place', staged, '--name', 'failffmpeg', 'Rock');
    assert.strictEqual(r.status, 'failed');
    assert.ok(/title/.test(r.message), r.message);
    assert.ok(fs.existsSync(staged));
    assert.strictEqual(fs.readFileSync(staged, 'utf8'), 'audio\n', 'the file was not changed');
    assert.ok(!fs.existsSync(staged + '.part'));
  });

  await check('only staged files can be placed: other paths, missing files and ".." tricks are refused', () => {
    fs.writeFileSync(path.join(audio, 'Rock', 'precious.mp3'), 'x');
    [path.join(audio, 'Rock', 'precious.mp3'), '/etc/passwd', path.join(staging, 'nope', 'x.mp3'),
      path.join(staging, '..', 'Rock', 'precious.mp3')].forEach((bad) => {
      const r = run('--place', bad, '--name', 'Stolen');
      assert.strictEqual(r.status, 'failed', bad);
    });
    assert.ok(fs.existsSync(path.join(audio, 'Rock', 'precious.mp3')));
    assert.ok(!fs.existsSync(path.join(audio, 'Stolen.mp3')));
  });

  await check('names in any language, with %, quotes, and a leading dash survive to the file and the tag', () => {
    ['音楽 – Ünï ♪', "100% sure — it's", '-dash name'].forEach((name, i) => {
      const s = run('--stage', 'https://example.com/ok').message;
      const r = run('--place', s, '--name', name, 'Mix');
      assert.strictEqual(r.status, 'done', name + ' ' + r.message);
      assert.strictEqual(r.message, path.join(audio, 'Mix', name + '.mp3'));
      assert.ok(fs.readFileSync(r.message, 'utf8').includes('TITLE=' + name));
    });
  });

  await check('without --name the song keeps its downloaded name', () => {
    const s = run('--stage', 'https://example.com/ok').message;
    const r = run('--place', s, 'Kept');
    assert.strictEqual(r.message, path.join(audio, 'Kept', 'Cool Song.mp3'));
    assert.ok(!fs.readFileSync(r.message, 'utf8').includes('TITLE='), 'no retag when there is no new name');
  });

  await check('a failed download reports why and leaves nothing behind', () => {
    const before = fs.readdirSync(staging).sort();                // earlier checks left a song or two staged on purpose
    const r = run('--stage', 'https://example.com/bad');
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.message, 'Video unavailable');
    assert.deepStrictEqual(fs.readdirSync(staging).sort(), before, 'no new run folder is left behind');
  });

  await check('bad input is refused: not a link, a link with the placement options, no ffmpeg name', () => {
    assert.strictEqual(run('--stage', 'not a link').status, 'failed');
    assert.strictEqual(run('--stage', 'https://a.example/x', 'Rock').status, 'failed');
    assert.strictEqual(run('--place').status, 'failed');
  });

  await check('the original direct download still works (URL and optional playlist)', () => {
    const r = run('https://example.com/ok', 'Direct');
    assert.strictEqual(r.status, 'done');
    assert.ok(fs.existsSync(path.join(audio, 'Direct', 'Cool Song.mp3')));
    const named = run('--name', 'By Hand', 'https://example.com/ok');
    assert.strictEqual(named.status, 'done');
    assert.ok(fs.readFileSync(path.join(audio, 'By Hand.mp3'), 'utf8').includes('TITLE=By Hand'));
  });

  await check('a playlist literally called "--stage" is still just a playlist name', () => {
    const r = run('https://example.com/ok', '--stage');
    assert.strictEqual(r.status, 'done');
    assert.ok(fs.existsSync(path.join(audio, '--stage', 'Cool Song.mp3')));
  });

  await check('Stop: SIGTERM to the pid in $TMPDIR/song_dl.<pid>.pid ends a running download as "Stopped" and cleans up', async () => {
    const beforeStop = fs.readdirSync(staging).sort();
    const child = spawn('python3', ['-c', SCRIPT, '--stage', 'https://example.com/slow'], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const pidFile = path.join(tmp, 'song_dl.' + child.pid + '.pid');
    for (let i = 0; i < 60 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(pidFile), 'the script keeps a pid file named after its pid');
    // The same loop the app sends through Termux to stop everything:
    const stop = spawnSync('sh', ['-c', 'd="$TMPDIR"; for f in "$d"/song_dl.*.pid; do [ -f "$f" ] && kill -TERM "$(cat "$f")" 2>/dev/null; done; true'], { env });
    assert.strictEqual(stop.status, 0);
    const code = await new Promise((resolve) => child.on('close', resolve));
    const result = JSON.parse(out.trim().split('\n').pop().slice(7));
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(result, { status: 'failed', message: 'Stopped' });
    assert.ok(!fs.existsSync(pidFile), 'the pid file is removed');
    assert.deepStrictEqual(fs.readdirSync(staging).sort(), beforeStop, 'the half-made run folder is removed');
  });

  console.log(n + ' checks passed');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); fs.rmSync(root, { recursive: true, force: true }); process.exit(1); });

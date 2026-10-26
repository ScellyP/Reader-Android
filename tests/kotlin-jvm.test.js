// Run with: node tests/kotlin-jvm.test.js
// The pure-Kotlin parts of the "Download songs" tab, run on a plain JVM (no Android needed):
//   - Id3Title.kt (renaming a song rewrites its title tag: tests/jvm/Id3TitleTest.kt)
//   - SongNames.kt (the same name-cleaning rules as song-download.js: compared answer by answer)
// Needs `kotlinc` (on PATH, or in $KOTLINC) and a JDK; when they are missing the checks are skipped,
// the way the old Python parity check was when python3 was missing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const SD = require('../app/src/main/assets/song-download.js');

const kotlinc = process.env.KOTLINC || 'kotlinc';
const probe = spawnSync(kotlinc, ['-version'], { encoding: 'utf8' });
const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
if (probe.error || java.error) {
  console.log('(kotlinc or java not available: Kotlin JVM checks skipped)');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const src = (f) => path.join(root, 'app/src/main/java/com/scell/novelreader/redesign', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-jvm-'));
const jar = path.join(tmp, 'checks.jar');

execFileSync(kotlinc, [src('Id3Title.kt'), src('SongNames.kt'),
  path.join(__dirname, 'jvm/Id3TitleTest.kt'), path.join(__dirname, 'jvm/SongNamesDump.kt'),
  '-include-runtime', '-d', jar], { stdio: ['ignore', 'ignore', 'ignore'] });

const run = (mainClass, args) => execFileSync('java', ['-Dfile.encoding=UTF-8', '-cp', jar, mainClass, ...args], { encoding: 'utf8' });

// 1. ID3 title rewriting (also on a real ffmpeg-made file when ffmpeg is installed)
const env = Object.assign({}, process.env);
const real = path.join(tmp, 'real.mp3');
const ff = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-c:a', 'libmp3lame', '-id3v2_version', '3', '-write_id3v1', '1', '-metadata', 'title=Original', real]);
if (!ff.error && ff.status === 0) env.REAL_MP3 = real;
const out = execFileSync('java', ['-Dfile.encoding=UTF-8', '-cp', jar, 'com.scell.novelreader.redesign.Id3TitleTestKt'], { encoding: 'utf8', env });
process.stdout.write(out);
assert.ok(/all checks passed/.test(out), 'Id3TitleTest failed');

// 2. SongNames.kt gives the same answers as song-download.js
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const folders = ['Lo-fi Focus', "  Rock  &   Roll's (Best), v2.0  ", '../../etc', '..', '.hidden.', 'a/b\\c:d*e',
  '音楽 mix', 'tab\there', 'x'.repeat(100), ' . ', 'Mix...', '(a).b', "it's, ok", '', '😀 party'];
const songs = ['Back In Black', 'AC/DC: "Hells Bells" <live> | 1980?', '  ..Mix..  ', '音楽 – Ünïcode ♪ 100%',
  'a\tb\nc', '\\/:*?', 'x'.repeat(200), '😀'.repeat(200), '-dash name', 'Song (feat. A & B) [Remix]', "Don't Stop", '', 'a\u0000b\u007fc'];
const lines = folders.map((s) => 'folder ' + hex(s)).concat(songs.map((s) => 'song ' + hex(s)));
const inputFile = path.join(tmp, 'names.txt');
fs.writeFileSync(inputFile, lines.join('\n') + '\n');
const got = run('com.scell.novelreader.redesign.SongNamesDumpKt', [inputFile]).trim().split('\n')
  .map((h) => Buffer.from(h, 'hex').toString('utf8'));
const want = folders.map(SD.cleanFolderName).concat(songs.map(SD.cleanSongName));
assert.deepStrictEqual(got, want);
console.log('ok - SongNames.kt gives the same answer as song-download.js for ' + lines.length + ' names');

fs.rmSync(tmp, { recursive: true, force: true });

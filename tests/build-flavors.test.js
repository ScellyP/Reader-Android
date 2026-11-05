// The two builds ("full" = with the music player, "noaudio" = without), see "Two versions" in README.md.
// Checks that Gradle, the overlays, the guards in the page / Kotlin, the updater and the workflow agree.
// Run with: node tests/build-flavors.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MAIN = 'app/src/main/';
const OVER = 'app/src/noaudio/';
let n = 0;
function check(name, fn) { fn(); n++; }

const gradle = read('app/build.gradle');
const workflow = read('.github/workflows/build-apk.yml');
const reader = read(MAIN + 'assets/reader.js');
const mainActivity = read(MAIN + 'java/com/scell/novelreader/redesign/MainActivity.kt');
const updater = read(MAIN + 'java/com/scell/novelreader/redesign/AppUpdater.kt');

check('gradle: two flavors in one dimension, BuildConfig on, same application id', () => {
  assert.ok(/flavorDimensions 'audio'/.test(gradle));
  const full = /full \{([\s\S]*?)\n        \}/.exec(gradle)[1];
  const noaudio = /noaudio \{([\s\S]*?)\n        \}/.exec(gradle)[1];
  assert.ok(/'HAS_AUDIO', 'true'/.test(full) && !/applicationIdSuffix/.test(full));
  assert.ok(!/applicationIdSuffix/.test(noaudio), 'both builds must share one application id');
  assert.ok(/'HAS_AUDIO', 'false'/.test(noaudio));
  assert.ok(/buildFeatures \{\s*buildConfig true/.test(gradle));
});

check('overlay manifest removes the service and the player-only permissions', () => {
  const m = read(OVER + 'AndroidManifest.xml');
  for (const p of ['FOREGROUND_SERVICE"', 'FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'POST_NOTIFICATIONS']) {
    assert.ok(new RegExp('android\\.permission\\.' + p + '[^>]*tools:node="remove"').test(m), p);
  }
  assert.ok(/<service android:name="\.PlaybackService" tools:node="remove"/.test(m));
  // ...and those are really what the main manifest declares (so the removal hits something)
  const main = read(MAIN + 'AndroidManifest.xml');
  assert.ok(main.includes('android.permission.FOREGROUND_SERVICE"') && main.includes('android:name=".PlaybackService"'));
});

check('overlay assets replace exactly the three audio scripts, and they exist in main', () => {
  const over = fs.readdirSync(path.join(ROOT, OVER + 'assets')).sort();
  assert.deepStrictEqual(over, ['audio-player.js', 'song-download.js', 'spotify-ui.js']);
  for (const f of over) assert.ok(fs.existsSync(path.join(ROOT, MAIN + 'assets/' + f)), f + ' is not in main');
  assert.ok(read(OVER + 'res/values/strings.xml').includes('name="app_name"'));
});

check('the no-audio audio-player.js defines no NovelAudio, sets NO_AUDIO and hides every way in', () => {
  const hidden = [];
  const styles = [];
  const row = { style: {} };
  const toggle = { closest: (sel) => (sel === '.theme-panel-row' ? row : null) };
  const sandbox = {
    window: {},
    document: {
      head: { appendChild: (el) => styles.push(el) },
      createElement: () => ({}),
      getElementById: (id) => (id === 'audio-volume-keys-toggle' ? toggle : null),
    },
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(read(OVER + 'assets/audio-player.js'), sandbox);
  assert.strictEqual(sandbox.window.NO_AUDIO, true);
  assert.strictEqual(sandbox.window.NovelAudio, undefined);
  assert.strictEqual(row.style.display, 'none');
  const css = styles[0].textContent;
  for (const sel of ['#audio-toggle', '#audio-toggle-top', '#audio-panel', '#novel-picker-player-hint']) {
    assert.ok(css.includes(sel), sel);
  }
  assert.ok(/display: none !important/.test(css));
  // the stubs for the other two scripts are comments only (nothing to run)
  for (const f of ['spotify-ui.js', 'song-download.js']) {
    assert.strictEqual(read(OVER + 'assets/' + f).replace(/\/\*[\s\S]*?\*\//g, '').trim(), '');
  }
});

check('the page still loads those three scripts by name, and the shared reader.js stops the swipe opening the panel', () => {
  const html = read(MAIN + 'assets/index.html');
  for (const f of ['audio-player.js', 'spotify-ui.js', 'song-download.js']) assert.ok(html.includes('<script src="' + f + '">'), f);
  assert.ok(/function toggleAudioPanel\(\) \{\s*if \(window\.NO_AUDIO\) return;/.test(reader));
  assert.ok(/function openAudioFromSwipe\(\) \{\s*if \(window\.NO_AUDIO\) return;/.test(reader));
  // every other use of the player in reader.js is behind `window.NovelAudio &&` (on the line itself or
  // in the `if` / `else if` just above it); comments do not count
  const all = reader.split('\n');
  const loose = [];
  all.forEach((l, i) => {
    if (!/window\.NovelAudio\./.test(l) || /^\s*(\*|\/\/|\/\*)/.test(l) || /\bas window\.NovelAudio\./.test(l)) return;
    if (/window\.NovelAudio &&/.test(l)) return;
    if (all.slice(Math.max(0, i - 3), i).some((p) => /window\.NovelAudio &&/.test(p))) return;
    loose.push(l.trim());
  });
  assert.deepStrictEqual(loose, ['if (!window.NovelAudio.likeCurrent()) return;'],
    'unguarded NovelAudio use: only likeFromDoubleTap() is allowed, and it is only reached after hasCurrentTrack()');
});

check('the music code is split by source set: full has the real AudioBackend, noaudio an empty one, main has none', () => {
  const KT = 'java/com/scell/novelreader/redesign/';
  const full = 'app/src/full/' + KT;
  for (const f of ['AudioBackend', 'PlaybackService', 'NativeCrossfade', 'NativeAudioEffects', 'ReplayGainReader', 'SongDownloader', 'SongNames', 'Id3Title']) {
    assert.ok(fs.existsSync(path.join(ROOT, full + f + '.kt')), f + '.kt must be in app/src/full');
    assert.ok(!fs.existsSync(path.join(ROOT, MAIN + KT + f + '.kt')), f + '.kt must not be in app/src/main');
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'app/src/full/res/drawable/ic_stat_music.xml')));
  const stub = read(OVER + KT + 'AudioBackend.kt');
  const real = read(full + 'AudioBackend.kt');
  // every member of the real backend that MainActivity can call exists in the stub too
  const members = (src) => [...src.matchAll(/^    fun (\w+)\(/gm)].map((m) => m[1]).sort();
  assert.deepStrictEqual(members(stub), members(real));
  assert.ok(!/androidx\.media3|yausername|SongDownloader|PlaybackService/.test(stub.replace(/\/\*[\s\S]*?\*\//g, '')), 'the stub must not touch the music libraries');
  // nothing left in the shared sources that needs the music libraries
  for (const f of fs.readdirSync(path.join(ROOT, MAIN + KT))) {
    const src = read(MAIN + KT + f).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    assert.ok(!/import androidx\.media3|import com\.yausername|import com\.google\.common/.test(src), f + ' imports a music library');
    assert.ok(!/\b(PlaybackService|SongDownloader|NativeCrossfade|ReplayGainReader)\./.test(src), f + ' uses a music class');
  }
});

check('gradle: media3 and yt-dlp are dependencies of the full flavor only', () => {
  for (const lib of ['androidx.media3:media3-exoplayer', 'androidx.media3:media3-session', 'youtubedl-android:library', 'youtubedl-android:ffmpeg']) {
    assert.ok(new RegExp("fullImplementation '[^']*" + lib.replace(/[.]/g, '\\.')).test(gradle), lib + ' must be fullImplementation');
    assert.ok(!new RegExp("^\\s*implementation '[^']*" + lib.replace(/[.]/g, '\\.'), 'm').test(gradle), lib + ' must not be a shared dependency');
  }
});

check('MainActivity: the music paths go through AudioBackend and the no-audio build skips the idle work', () => {
  assert.ok(/private val audio = AudioBackend\(this\)/.test(mainActivity));
  assert.ok(/audio\.connect\(\)/.test(mainActivity) && /audio\.warmUp\(\)/.test(mainActivity));
  assert.ok(/BuildConfig\.HAS_AUDIO && Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU/.test(mainActivity));
  assert.ok(/if \(BuildConfig\.HAS_AUDIO\) registerVolumeReceiver\(\)/.test(mainActivity));
  assert.ok(/if \(BuildConfig\.HAS_AUDIO\) nightLockHandler\.post\(nightLockCheck\)/.test(mainActivity));
  assert.ok(mainActivity.includes('audio.serveAudio('));
});

check('AppUpdater: each build takes the Release asset that is its own', () => {
  assert.ok(updater.includes('assetName.contains("noaudio", ignoreCase = true) == !BuildConfig.HAS_AUDIO'));
  // the same test, in JS, over a Release that has both files
  const pick = (hasAudio, names) => names.find((a) => a.toLowerCase().endsWith('.apk') && a.toLowerCase().includes('noaudio') === !hasAudio);
  const assets = ['novel-reader-v1.16.00.apk', 'novel-reader-noaudio-v1.16.00.apk'];
  assert.strictEqual(pick(true, assets), 'novel-reader-v1.16.00.apk');
  assert.strictEqual(pick(false, assets), 'novel-reader-noaudio-v1.16.00.apk');
  assert.strictEqual(pick(true, ['novel-reader-v1.15.01.apk']), 'novel-reader-v1.15.01.apk'); // an old Release
});

check('workflow: builds both versions, uploads four artifacts, publishes the full APK first and the no-audio one second', () => {
  assert.ok(workflow.includes('./gradlew assembleRelease assembleDebug'));
  for (const p of [
    'apk/full/release/app-full-release.apk', 'apk/full/debug/app-full-debug.apk',
    'apk/noaudio/release/app-noaudio-release.apk', 'apk/noaudio/debug/app-noaudio-debug.apk',
  ]) assert.ok(workflow.includes(p), p);
  for (const a of ['novel-reader-release-apk', 'novel-reader-debug-apk', 'novel-reader-noaudio-release-apk', 'novel-reader-noaudio-debug-apk']) {
    assert.ok(workflow.includes('name: ' + a), a);
  }
  const step = workflow.slice(workflow.indexOf('Publish GitHub Release'));
  assert.ok(step.includes('APK="novel-reader-$TAG.apk"') && step.includes('APK_NOAUDIO="novel-reader-noaudio-$TAG.apk"'));
  const createAt = step.indexOf('gh release create "$TAG" "$APK"');
  const noAudioAt = step.indexOf('gh release upload "$TAG" "$APK_NOAUDIO"');
  assert.ok(createAt > 0 && noAudioAt > createAt, 'the no-audio APK must be attached after the full one');
  assert.ok(!/gh release create[^\n]*APK_NOAUDIO/.test(step), 'create must not carry the no-audio file (order of assets)');
});

check('the version was bumped and documented', () => {
  assert.ok(/APP_VERSION = 'v1\.16\.01'/.test(read(MAIN + 'assets/version.js')));
  assert.ok(read('Agent.md').includes('v1.16.00'));
  assert.ok(read('README.md').includes('## Two versions'));
});

console.log(n + ' checks passed');

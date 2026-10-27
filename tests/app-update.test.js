// Run with: node tests/app-update.test.js
// The in-app updater. AppUpdater.kt needs a device (and kotlinc is not assumed), so this checks:
//   - the page's plan() for every state the native side can send,
//   - the version rules, using the very regular expressions found in AppUpdater.kt,
//   - that page, Kotlin, manifest and workflow agree (bridge names, state names, permissions,
//     the Release step and the tag it makes from version.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'app/src/main/assets');
const KT = path.join(ROOT, 'app/src/main/java/com/scell/novelreader/redesign');
const read = (p) => fs.readFileSync(p, 'utf8');

const updater = read(path.join(KT, 'AppUpdater.kt'));
const mainActivity = read(path.join(KT, 'MainActivity.kt'));
const manifest = read(path.join(ROOT, 'app/src/main/AndroidManifest.xml'));
const workflow = read(path.join(ROOT, '.github/workflows/build-apk.yml'));
const html = read(path.join(ASSETS, 'index.html'));
const versionJs = read(path.join(ASSETS, 'version.js'));
const pageSource = read(path.join(ASSETS, 'app-update.js'));
const page = require(path.join(ASSETS, 'app-update.js'));

let n = 0;
function check(name, fn) {
  try { fn(); } catch (e) { console.log('FAIL -', name); throw e; }
  n++; console.log('ok -', name);
}

// The Kotlin source writes regexes as "..." strings, so every \ is doubled there.
function kotlinRegex(name) {
  const m = new RegExp(name + ' = Regex\\("((?:[^"\\\\]|\\\\.)*)"\\)').exec(updater);
  assert.ok(m, 'no ' + name + ' in AppUpdater.kt');
  return new RegExp(m[1].replace(/\\\\/g, '\\'));
}
const VERSION_RE = kotlinRegex('VERSION_RE');
const APP_VERSION_RE = kotlinRegex('APP_VERSION_RE');
function parse(text) {
  const m = VERSION_RE.exec(String(text || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewer(remote, local) {
  const r = parse(remote), l = parse(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) if (r[i] !== l[i]) return r[i] > l[i];
  return false;
}

check('version rules: numbers, not text', () => {
  assert.ok(isNewer('v1.15.00', 'v1.14.00'));
  assert.ok(isNewer('v1.14.01', 'v1.14.00'));
  assert.ok(isNewer('v2.00.00', 'v1.99.99'));
  assert.ok(isNewer('v1.10.00', 'v1.9.00'), '1.10 must beat 1.9');
  assert.ok(!isNewer('v1.14.00', 'v1.14.00'), 'same version is not an update');
  assert.ok(!isNewer('v1.13.09', 'v1.14.00'), 'older is not an update');
  assert.ok(!isNewer('latest', 'v1.14.00'), 'a tag that is no version is ignored');
  assert.ok(!isNewer('v1.15.00', ''), 'unknown installed version offers nothing');
  assert.ok(isNewer('v1.15.00-beta', 'v1.14.00'), 'a suffix after the three numbers is allowed');
});

check('the installed version is read out of version.js', () => {
  const m = APP_VERSION_RE.exec(versionJs);
  assert.ok(m, 'APP_VERSION not found by the Kotlin regex');
  assert.ok(parse(m[1]), 'not a version: ' + m[1]);
  assert.ok(!/APP_VERSION\s*=\s*'/.test(versionJs.split('window.APP_VERSION')[0]), 'an earlier APP_VERSION = \'...\' in a comment would be read instead');
});

check('plan(): quiet when an automatic check finds nothing or fails', () => {
  assert.strictEqual(page.plan({ status: 'checking', manual: false }).show, false);
  assert.strictEqual(page.plan({ status: 'uptodate', manual: false }).show, false);
  assert.strictEqual(page.plan({ status: 'failed', step: 'check', manual: false }).show, false);
  assert.strictEqual(page.plan(null).show, false);
  assert.strictEqual(page.plan({ status: 'something-new' }).show, false);
});

check('plan(): a manual check always answers', () => {
  assert.ok(/Checking/.test(page.plan({ status: 'checking', manual: true }).text));
  const up = page.plan({ status: 'uptodate', manual: true, current: 'v1.15.00' });
  assert.ok(up.show && up.autoHide && up.text.includes('v1.15.00'));
  const bad = page.plan({ status: 'failed', step: 'check', manual: true, message: 'Could not reach GitHub.' });
  assert.ok(bad.show && bad.text === 'Could not reach GitHub.' && bad.action.call === 'checkForUpdate');
});

check('plan(): available -> downloading -> ready -> installing', () => {
  const a = page.plan({ status: 'available', version: 'v1.16.00' });
  assert.ok(a.show && a.dot && a.text.includes('v1.16.00') && a.action.call === 'downloadUpdate');
  const d = page.plan({ status: 'downloading', version: 'v1.16.00', percent: 41.6 });
  assert.strictEqual(d.progress, 42);
  assert.ok(d.text.includes('42%') && d.action === null);
  assert.strictEqual(page.plan({ status: 'downloading', percent: 250 }).progress, 100);
  assert.strictEqual(page.plan({ status: 'downloading', percent: -3 }).progress, 0);
  const r = page.plan({ status: 'ready', version: 'v1.16.00' });
  assert.ok(r.action.call === 'installUpdate' && r.dot);
  assert.strictEqual(page.plan({ status: 'ready', message: 'Install cancelled.' }).text, 'Install cancelled.');
  const i = page.plan({ status: 'installing' });
  assert.ok(i.show && i.action === null && i.dot);
  const p = page.plan({ status: 'needpermission', message: 'Allow it.' });
  assert.ok(p.action.call === 'installUpdate' && p.text === 'Allow it.');
});

check('plan(): a failed download or install is shown and retries the right step', () => {
  const d = page.plan({ status: 'failed', step: 'download', manual: false, message: 'cut short' });
  assert.ok(d.show && d.action.call === 'downloadUpdate');
  const i = page.plan({ status: 'failed', step: 'install', manual: false });
  assert.ok(i.show && i.action.call === 'installUpdate');
});

check('every bridge method the page calls exists in MainActivity, and the other way round', () => {
  const methods = ['checkForUpdate', 'downloadUpdate', 'installUpdate', 'updateState', 'getAutoUpdate', 'setAutoUpdate'];
  methods.forEach((m) => {
    assert.ok(pageSource.includes(m), 'app-update.js never uses ' + m);
    assert.ok(new RegExp('@JavascriptInterface\\s+fun ' + m + '\\(').test(mainActivity), 'MainActivity has no ' + m);
  });
  assert.ok(mainActivity.includes('"onUpdateState"') && /root\.onUpdateState\s*=/.test(pageSource));
});

check('every status the page knows is one AppUpdater.kt sends, and every one it sends is known', () => {
  const sent = new Set();
  const re = /setState\(\s*"([a-z]+)"/g;
  let m;
  while ((m = re.exec(updater))) sent.add(m[1]);
  sent.add('failed'); // fail() builds it
  const known = new Set();
  const re2 = /case '([a-z]+)':/g;
  while ((m = re2.exec(pageSource))) known.add(m[1]);
  sent.forEach((s) => assert.ok(known.has(s), 'the page does not know status ' + s));
  known.forEach((s) => assert.ok(sent.has(s), 'the page handles ' + s + ' but the app never sends it'));
  ['check', 'download', 'install'].forEach((step) => {
    assert.ok(updater.includes('fail("' + step + '"'), 'AppUpdater.kt never fails with step ' + step);
    assert.ok(pageSource.includes("'" + step + "'") || step === 'check', 'page ignores step ' + step);
  });
});

check('every element id app-update.js looks up exists in index.html', () => {
  const ids = [...pageSource.matchAll(/getElementById\('([^']+)'\)/g)].map((x) => x[1]);
  assert.ok(ids.length >= 7);
  ids.forEach((id) => assert.ok(html.includes('id="' + id + '"'), 'index.html has no #' + id));
  assert.ok(/<script src="app-update\.js"><\/script>/.test(html));
});

check('manifest has the two permissions and the app keeps the update out of the way of closing', () => {
  assert.ok(manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES'));
  assert.ok(manifest.includes('android.permission.ACCESS_NETWORK_STATE'));
  assert.ok(/appUpdater\.isBusy\(\)/.test(mainActivity), 'closeRunnable ignores the updater');
  assert.ok(mainActivity.includes('appUpdater.start()') && mainActivity.includes('appUpdater.release()'));
  assert.ok(/private val appUpdater: AppUpdater/.test(mainActivity), 'give appUpdater an explicit type (recursive-type build error before)');
});

check('AppUpdater.kt reads the same repo the build pushes to and never uses the context while being built', () => {
  assert.ok(/OWNER_REPO = "[\w.-]+\/[\w.-]+"/.test(updater));
  assert.ok(/private val prefs by lazy/.test(updater) && /private val updatesDir by lazy/.test(updater));
  assert.ok(/fun start\(\)/.test(updater));
  assert.ok(!/https?:\/\/(?!api\.github\.com)/.test(updater.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'only api.github.com is hard-coded');
});

check('workflow: publishes a Release, only for real-key builds, with a tag that matches version.js', () => {
  assert.ok(/permissions:\s*\n\s*contents: write/.test(workflow), 'the build job cannot write releases');
  assert.ok(workflow.includes('SIGNED_WITH_REAL_KEY=true'), 'signed builds are not marked');
  const step = workflow.slice(workflow.indexOf('Publish GitHub Release'));
  assert.ok(step.includes("if: env.SIGNED_WITH_REAL_KEY == 'true'"));
  assert.ok(step.includes('gh release upload') && step.includes('--clobber') && step.includes('gh release create'));
  assert.ok(/\.apk/.test(step) && step.includes('app-release.apk'));
  // run the step's own tag extraction on the real version.js
  const line = step.split('\n').find((l) => l.includes('TAG=$('));
  const cmd = line.trim().replace(/app\/src\/main\/assets\/version\.js/g, path.join(ASSETS, 'version.js')) + '\necho "$TAG"';
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const expected = /window\.APP_VERSION = '(v\d+\.\d+\.\d+)'/.exec(versionJs)[1];
  assert.strictEqual(r.stdout.trim(), expected);
});

console.log(n + ' checks passed');

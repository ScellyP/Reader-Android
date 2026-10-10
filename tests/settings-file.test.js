const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load settings-file.js in a tiny fake browser: a Storage class, a bridge that
// hands back the text of "settings.txt", and no-op timers.
function run(text) {
  class FakeStorage {
    constructor() { Object.defineProperty(this, '_d', { value: new Map() }); }
    get length() { return this._d.size; }
    key(i) { return Array.from(this._d.keys())[i] ?? null; }
    getItem(k) { return this._d.has(k) ? this._d.get(k) : null; }
    setItem(k, v) { this._d.set(k, String(v)); }
    removeItem(k) { this._d.delete(k); }
  }
  const ls = new FakeStorage();
  const written = [];
  const sandbox = {
    Storage: FakeStorage, localStorage: ls, sessionStorage: new FakeStorage(),
    document: { addEventListener() {}, visibilityState: 'visible' },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    location: { reload() {} },
    AndroidBridge: { readSettingsFile: () => text, writeSettingsFile: t => { written.push(t); return true; } }
  };
  sandbox.window = sandbox;
  const code = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/settings-file.js'), 'utf8');
  new Function(...Object.keys(sandbox), code)(...Object.values(sandbox));
  return ls;
}

const get = (ls, k) => JSON.parse(ls.getItem(k) || 'null');

// Good values are applied.
let ls = run([
  '# comment',
  'appearance.fontSize = 20', 'appearance.readBg = "#112233"', 'appearance.smartScroll = true',
  'audio.volume = 0.5', 'audio.repeat = "all"', 'audio.eqBands = [0,1,2,3,4,5,6,7,8,9]',
  'sessionLimitMode = "time"', 'sessionLimitTime = "22:30"', 'sessionLimitSeconds = 3600',
  'currentNovel = "Shadow Slave"', 'lastChapter.Shadow Slave = "Chapter 0412.txt"'
].join('\n'));
assert.deepEqual(get(ls, 'novelReader_appearance'), { fontSize: 20, readBg: '#112233', smartScroll: true });
assert.deepEqual(get(ls, 'novelReader_audioPrefs'), { volume: 0.5, repeat: 'all', eqBands: [0,1,2,3,4,5,6,7,8,9] });
assert.equal(ls.getItem('novelReader_sessionLimitMode'), 'time');
assert.equal(ls.getItem('novelReader_sessionLimitTime'), '22:30');
assert.equal(ls.getItem('novelReader_sessionLimitSeconds'), '3600');
assert.equal(ls.getItem('novelReader_currentNovel'), 'Shadow Slave');
assert.equal(ls.getItem('novelReader_lastChapter_Shadow Slave'), 'Chapter 0412.txt');

// Wrong types, out-of-range numbers, unknown keys and bad strings are ignored.
ls = run([
  'appearance.fontSize = 9999', 'appearance.fontSize2 = 1', 'appearance.readBg = "url(javascript:x)"',
  'appearance.fontFamily = "x; background:url(http://evil)"', 'appearance.smartScroll = "yes"',
  'audio.volume = 7', 'audio.repeat = "forever"', 'audio.eqBands = [1,2,3]', 'audio.eqBands = [99,0,0,0,0,0,0,0,0,0]',
  'audio.features = [1,2]', 'evil.x = 1', 'unknownKey = "x"',
  'sessionLimitMode = "sometimes"', 'sessionLimitTime = "25:99"', 'sessionLimitSeconds = "12abc"',
  'currentNovel = "a/b"', 'currentNovel = {"x":1}', 'lastChapter.Novel = "../../etc/passwd"', 'lastChapter.A%0AB = "ok.txt"'
].join('\n'));
assert.equal(ls.length, 0, 'invalid lines change nothing: ' + JSON.stringify(Array.from({ length: ls.length }, (_, i) => ls.key(i))));

// Prototype-pollution keys inside nested features are dropped; size cap on features.
ls = run('audio.features = {"__proto__":{"polluted":true},"abRepeat":{"a":1}}');
assert.deepEqual(get(ls, 'novelReader_audioPrefs'), { features: { abRepeat: { a: 1 } } });
assert.equal({}.polluted, undefined, 'Object.prototype is untouched');
ls = run('audio.features = {"x":"' + 'a'.repeat(9000) + '"}');
assert.equal(ls.length, 0, 'oversized features object is ignored');

// Line count cap: only the first 5000 lines are looked at.
const many = Array.from({ length: 6000 }, (_, i) => `lastChapter.N${i} = "c.txt"`).join('\n');
ls = run(many);
assert.equal(ls.length, 5000, 'at most 5000 lines are read');

console.log('Settings file validation checks passed.');

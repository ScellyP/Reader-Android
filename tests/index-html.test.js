// Run with: node tests/index-html.test.js
// Structural checks on index.html that no other test can see: duplicate ids (an id used twice
// makes `<use href="#id">` and getElementById pick the first one, which can be the wrong element),
// icons that point at nothing, and script files that are not loaded.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '../app/src/main/assets');
const html = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8');
const uncommented = html.replace(/<!--[\s\S]*?-->/g, '');
const markup = uncommented.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }
const all = (re, text, group = 1) => Array.from(text.matchAll(re), m => m[group]);

check('no id is used twice in the page', () => {
  const ids = all(/\sid="([^"]+)"/g, markup);
  const seen = new Set(), repeated = new Set();
  ids.forEach(id => { if (seen.has(id)) repeated.add(id); seen.add(id); });
  assert.deepStrictEqual([...repeated], []);
  // <style id> and <script id> count too: they share the document's id space
  const tagged = all(/<(?:style|script)\b[^>]*\sid="([^"]+)"/g, html);
  tagged.forEach(id => assert.ok(!seen.has(id), 'a <style>/<script> id clashes with an element id: ' + id));
});

check('every icon the markup uses exists', () => {
  const symbols = new Set(all(/<symbol\b[^>]*\sid="([^"]+)"/g, markup));
  const used = all(/<use\b[^>]*href="#([^"]+)"/g, markup);
  assert.ok(symbols.size > 20 && used.length > 20);
  assert.deepStrictEqual([...new Set(used.filter(id => !symbols.has(id)))], []);
});

check('every icon the scripts ask for by name exists', () => {
  const symbols = new Set(all(/<symbol\b[^>]*\sid="([^"]+)"/g, markup));
  const missing = [];
  fs.readdirSync(ASSETS).filter(f => f.endsWith('.js')).forEach(file => {
    const src = fs.readFileSync(path.join(ASSETS, file), 'utf8');
    all(/\b(?:svgIcon|makeIcon)\('([\w-]+)'\)/g, src).forEach(id => { if (!symbols.has(id)) missing.push(file + ': ' + id); });
  });
  assert.deepStrictEqual(missing, []);
});

check('every script tag points at a file, and every script file is loaded', () => {
  const loaded = all(/<script\s+src="([^"]+)"/g, uncommented);
  loaded.forEach(src => assert.ok(fs.existsSync(path.join(ASSETS, src)), 'missing file: ' + src));
  const files = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'));
  assert.deepStrictEqual(files.filter(f => !loaded.includes(f)), []);
  assert.ok(loaded.indexOf('chapter-swipe.js') < loaded.indexOf('reader.js'), 'chapter-swipe.js must load before reader.js');
});

check('the library swipe handle sits right after the library (the CSS shows it with a + selector)', () => {
  assert.ok(/<div id="novel-grid"><\/div>\s*<\/div>\s*<\/div>\s*<div id="novel-picker-player-hint"/.test(markup));
  const css = html.match(/<style[^>]*>[\s\S]*?<\/style>/g).join('\n');
  assert.ok(css.includes('#novel-picker:not(.hidden) + #novel-picker-player-hint'));
  assert.ok(css.includes('body.picker-open #audio-panel'));
});

console.log(n + ' checks passed');

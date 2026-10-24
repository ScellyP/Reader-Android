// Shared by the music-panel tests: loads spotify-ui.js against a small fake page. Elements the
// tests care about are real enough to hold children, attributes and click handlers; everything
// else is a stand-in that accepts any call.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/spotify-ui.js'), 'utf8');
const noop = () => {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Any page element the script touches but a test does not care about.
const anyElement = () => new Proxy(function () {}, {
  get(t, k) {
    if (k === 'textContent' || k === 'innerHTML' || k === 'className') return '';
    if (k === 'value') return '0';
    if (k === 'max') return '1';
    if (k === 'disabled') return true;
    if (k === 'classList') return { contains: () => false, add: noop, remove: noop, toggle: noop };
    if (k === 'style') return { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' };
    if (k === 'children' || k === 'childNodes') return [];
    if (k === 'querySelectorAll') return () => [];
    if (k === 'querySelector' || k === 'closest' || k === 'getAttribute') return () => null;
    if (k === 'contains') return () => false;
    if (k === Symbol.toPrimitive) return () => '';
    return noop;
  },
  set: () => true,
});

// Matches the few selector shapes spotify-ui.js uses: tag, .class and [attr], alone or combined
// (li[data-playlist-name], li.active, .sp-card-del, [data-sp-new]), and comma-separated lists.
function matches(node, selector) {
  return selector.split(',').some(part => {
    const m = part.trim().match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/);
    if (!m) return false;
    if (m[1] && node.tag !== m[1]) return false;
    const classes = (m[2].match(/\.[\w-]+/g) || []).map(c => c.slice(1));
    const attrs = (m[3].match(/\[[\w-]+\]/g) || []).map(a => a.slice(1, -1));
    return classes.every(c => node.classList.contains(c)) && attrs.every(a => node.hasAttribute(a));
  });
}

class FakeNode {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.parent = null; this.attrs = {}; this.props = {};
    this.listeners = {}; this.hidden = false; this.clicks = 0; this._classes = new Set(); this._text = '';
    this.style = { setProperty: (k, v) => { this.props[k] = v; }, removeProperty: k => { delete this.props[k]; }, getPropertyValue: k => this.props[k] || '' };
    this.classList = {
      contains: c => this._classes.has(c), add: c => this._classes.add(c), remove: c => this._classes.delete(c),
      toggle: (c, on) => { (on === undefined ? !this._classes.has(c) : on) ? this._classes.add(c) : this._classes.delete(c); },
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { this.clicks++; }
  closest(selector) { for (let n = this; n; n = n.parent) if (matches(n, selector)) return n; return null; }
  querySelectorAll(selector) {
    const out = [];
    const walk = n => n.children.forEach(c => { if (matches(c, selector)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

// A playlist row as audio-player.js builds it (a hidden <li> the Home screen forwards taps to).
function makeRow(name, title, count, { active = false } = {}) {
  const row = new FakeNode('li');
  row.isConnected = true;
  row.setAttribute('data-playlist-name', name);
  row.classList.toggle('active', active);
  const label = new FakeNode('span'); label.textContent = title; label.className = 'pl-name';
  row.appendChild(label);
  if (count) { const n = new FakeNode('span'); n.textContent = String(count); n.className = 'pl-count'; row.appendChild(n); }
  if (name.indexOf('@list:') === 0) {
    const del = new FakeNode('button'); del.className = 'pl-del';
    del.click = function () { this.clicks++; this.classList.toggle('confirm', this.clicks % 2 === 1); };
    row.appendChild(del);
  }
  return row;
}
const makeNewPlaylistRow = () => { const row = new FakeNode('li'); row.className = 'pl-new'; return row; };

// Loads spotify-ui.js. `rows` are the player's playlist rows; `tracks` its library.
function boot({ tracks = [], withArt = true } = {}) {
  const list = new FakeNode('ul');
  const named = {};
  ['audio-panel', 'sp-view-library', 'sp-greeting', 'sp-home-grid', 'sp-shelf-made', 'sp-shelf-made-row',
    'sp-shelf-lists', 'sp-shelf-lists-row'].forEach(id => { named[id] = new FakeNode('div'); });
  named['audio-playlist-list'] = list;
  // The same nesting as index.html: the grid and both shelves sit inside the Home view.
  const homeView = named['sp-view-library'];
  homeView.appendChild(named['sp-home-grid']);
  named['sp-shelf-made'].appendChild(named['sp-shelf-made-row']); homeView.appendChild(named['sp-shelf-made']);
  named['sp-shelf-lists'].appendChild(named['sp-shelf-lists-row']); homeView.appendChild(named['sp-shelf-lists']);
  const observers = [];
  let canvases = 0;
  global.window = global;
  global.document = {
    getElementById: id => named[id] || anyElement(),
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, hidden: false,
    createElement: tag => (tag === 'canvas'
      ? { getContext: () => ({ drawImage: noop, fillRect: noop }), toDataURL: () => 'data:image/jpeg;mosaic' + (++canvases) }
      : new FakeNode(tag)),
    createElementNS: (ns, tag) => new FakeNode(tag),
  };
  global.Image = function () { setTimeout(() => this.onload && this.onload(), 0); this.naturalWidth = 10; this.naturalHeight = 10; };
  global.MutationObserver = function (cb) { observers.push(cb); this.observe = noop; };
  global.requestAnimationFrame = fn => setTimeout(fn, 0);
  global.setInterval = noop;
  global.AndroidBridge = { getArtwork: p => (withArt ? 'data:image/png;art-' + p : '') };
  global.NovelAudio = { _state: { tracks }, features: { selectionFor: () => null } };
  new Function(SRC).call(global);

  const notify = () => observers.forEach(cb => cb([]));
  return {
    named, list,
    home: { root: named['sp-view-library'], greeting: named['sp-greeting'], grid: named['sp-home-grid'],
      made: named['sp-shelf-made'], madeRow: named['sp-shelf-made-row'], lists: named['sp-shelf-lists'], listsRow: named['sp-shelf-lists-row'] },
    // The player draws (or redraws) its playlist rows.
    showRows(rows) { list.children.forEach(r => { r.isConnected = false; }); list.children = []; rows.forEach(r => list.appendChild(r)); notify(); },
    // A tap on `node` inside the Home screen.
    tap(node) { named['sp-view-library'].listeners.click({ target: node }); },
    view: () => named['audio-panel'].getAttribute('data-view'),
  };
}

module.exports = { boot, makeRow, makeNewPlaylistRow, FakeNode, sleep, noop };

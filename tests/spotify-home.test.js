// Run with: node tests/spotify-home.test.js
// The music panel's main screen ("Home"): the greeting, which playlists land in the quick-access
// tiles and on each shelf, and that taps are forwarded to the player's own playlist rows.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Pure helpers (spotify-ui.js exports them when there is no page to build).
global.document = { getElementById: () => null };
const { greetingForHour, planHome, captionFor } = require('../app/src/main/assets/spotify-ui.js');
const { boot, makeRow, makeNewPlaylistRow, sleep } = require('./spotify-harness');

let n = 0;
function check(name, fn) { return Promise.resolve(fn()).then(() => { n++; console.log('ok -', name); }); }
const named = (node, cls) => node.querySelectorAll('.' + cls).map(x => x.textContent);

const STANDARD = () => [
  makeRow('all', 'All songs', 227, { active: true }), makeRow('@recent', 'Recently played', 100), makeRow('@liked', 'Liked', 9),
  makeRow('@list:7', 'Road trip', 1), makeRow('Classical', 'Classical', 90), makeRow('lofi', 'lofi', 1),
  makeRow('Loud', 'Loud', 102), makeRow('Loud but good', 'Loud but good', 33), makeNewPlaylistRow(),
];

(async () => {
  await check('the greeting follows the time of day', () => {
    const expected = { 0: 'Good night', 4: 'Good night', 5: 'Good morning', 11: 'Good morning', 12: 'Good afternoon',
      17: 'Good afternoon', 18: 'Good evening', 21: 'Good evening', 22: 'Good night', 23: 'Good night' };
    Object.keys(expected).forEach(h => assert.strictEqual(greetingForHour(Number(h)), expected[h], h + ':00'));
  });

  await check('the plan: six quick tiles, built-in lists on one shelf, everything else on the other', () => {
    const rows = ['all', '@recent', '@liked', '@list:7', 'Classical', 'lofi', 'Loud'].map(name => ({ name, title: name, count: '5' }));
    const plan = planHome(rows);
    assert.deepStrictEqual(plan.tiles.map(r => r.name), ['all', '@recent', '@liked', '@list:7', 'Classical', 'lofi']);
    assert.deepStrictEqual(plan.made.map(r => r.name), ['all', '@recent', '@liked']);
    assert.deepStrictEqual(plan.lists.map(r => r.name), ['@list:7', 'Classical', 'lofi', 'Loud']);
    assert.deepStrictEqual(planHome([{ name: 'all', title: 'All songs', count: '' }]).lists, []);
    assert.deepStrictEqual(planHome([{ name: 'Rock', title: 'Rock', count: '3' }]).made, []);
  });

  await check('card captions: a note for the built-in lists, otherwise a song count', () => {
    assert.strictEqual(captionFor({ name: '@liked', count: '9' }), 'Songs you hearted');
    assert.strictEqual(captionFor({ name: 'Classical', count: '90' }), '90 songs');
    assert.strictEqual(captionFor({ name: 'lofi', count: '1' }), '1 song');
    assert.strictEqual(captionFor({ name: 'Empty', count: '' }), 'No songs yet');
  });

  await check('Home is built from the player\'s rows: greeting, tiles, both shelves', async () => {
    const t = boot();
    t.showRows(STANDARD());
    await sleep(50);
    assert.strictEqual(t.home.greeting.textContent, greetingForHour(new Date().getHours()));
    assert.deepStrictEqual(named(t.home.grid, 'sp-tile-name'), ['All songs', 'Recently played', 'Liked', 'Road trip', 'Classical', 'lofi']);
    assert.deepStrictEqual(named(t.home.madeRow, 'sp-card-name'), ['All songs', 'Recently played', 'Liked']);
    assert.deepStrictEqual(named(t.home.listsRow, 'sp-card-name'),
      ['Road trip', 'Classical', 'lofi', 'Loud', 'Loud but good', 'New playlist']);
    assert.deepStrictEqual(named(t.home.listsRow, 'sp-card-sub'), ['1 song', '90 songs', '1 song', '102 songs', '33 songs']);
    assert.strictEqual(t.home.made.hidden, false);
    assert.strictEqual(t.home.lists.hidden, false);
  });

  await check('the selected playlist is marked everywhere it appears', async () => {
    const t = boot();
    const rows = STANDARD();
    t.showRows(rows);
    await sleep(50);
    const active = () => t.home.root.querySelectorAll('[data-sp-playlist]').filter(x => x.classList.contains('active')).map(x => x.getAttribute('data-sp-playlist'));
    assert.deepStrictEqual(active(), ['all', 'all']);        // its tile and its card
    rows[0].classList.toggle('active', false); rows[4].classList.toggle('active', true);   // chosen elsewhere
    t.showRows(rows);
    await sleep(50);
    assert.deepStrictEqual(active(), ['Classical', 'Classical']);
  });

  await check('tapping a tile or a card selects that playlist through its own row', async () => {
    const t = boot();
    const rows = STANDARD();
    t.showRows(rows);
    await sleep(50);
    const tile = t.home.grid.querySelectorAll('.sp-tile')[4];            // Classical
    t.tap(tile.children[1]);                                             // tapping its label counts
    assert.strictEqual(rows[4].clicks, 1);
    const card = t.home.listsRow.querySelectorAll('.sp-card').find(c => c.getAttribute('data-sp-playlist') === 'Loud');
    t.tap(card.querySelector('.sp-card-main'));
    assert.strictEqual(rows[6].clicks, 1);
    assert.strictEqual(rows[0].clicks, 0);                               // nothing else was touched
  });

  await check('your own playlists get a delete button that uses the player\'s two-tap confirm', async () => {
    const t = boot();
    const rows = STANDARD();
    t.showRows(rows);
    await sleep(50);
    assert.strictEqual(t.home.madeRow.querySelectorAll('.sp-card-del').length, 0);
    const dels = t.home.listsRow.querySelectorAll('.sp-card-del');
    assert.strictEqual(dels.length, 1);                                  // only "Road trip" is yours
    const rowDelete = rows[3].querySelector('.pl-del');
    t.tap(dels[0]);                                                      // first tap arms it
    assert.strictEqual(rowDelete.clicks, 1);
    assert.ok(dels[0].classList.contains('confirm'));
    assert.strictEqual(rows[3].clicks, 0);                               // and does not select the playlist
    t.tap(dels[0]);                                                      // second tap deletes
    assert.strictEqual(rowDelete.clicks, 2);
  });

  await check('"New playlist" forwards to the player\'s row and shows the Now playing view for the name box', async () => {
    const t = boot();
    const rows = STANDARD();
    t.showRows(rows);
    await sleep(50);
    const card = t.home.listsRow.querySelectorAll('.sp-card').pop();
    t.tap(card.querySelector('.sp-card-main'));
    assert.strictEqual(rows[8].clicks, 1);
    assert.strictEqual(t.view(), 'track');
  });

  await check('Home is the screen the player opens on', () => {
    const t = boot();
    assert.strictEqual(t.view(), 'library');
  });

  await check('covers show on tiles and cards, and stay there after a rescan', async () => {
    const tracks = [{ id: '/a/1.mp3', path: '/a/1.mp3', title: 'One', playlist: 'Classical' }, { id: '/b/2.mp3', path: '/b/2.mp3', title: 'Two', playlist: null }];
    const t = boot({ tracks });
    const rows = () => [makeRow('all', 'All songs', 2), makeRow('Classical', 'Classical', 1)];
    t.showRows(rows());
    await sleep(700);
    const covers = () => t.home.root.querySelectorAll('[data-sp-playlist]').map(node => node.querySelector('.sp-cover').hasAttribute('data-sp-cover'));
    assert.ok(covers().length >= 4 && covers().every(Boolean), 'every playlist tile and card has its cover');
    t.showRows(rows());                                                   // a rescan rebuilds the rows
    await sleep(700);
    assert.ok(covers().every(Boolean), 'still there after the rescan');
  });

  await check('the new Home markup is in index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/index.html'), 'utf8');
    ['sp-greeting', 'sp-home-grid', 'sp-shelf-made', 'sp-shelf-made-row', 'sp-shelf-lists', 'sp-shelf-lists-row'].forEach(id =>
      assert.ok(html.includes('id="' + id + '"'), id));
    assert.ok(html.includes('id="sp-lib-avatar"') && html.includes('id="sp-lib-stats"') && html.includes('id="audio-scan-btn"'));   // the moon strip is still there
  });

  console.log(n + ' checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

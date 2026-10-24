// Run with: node tests/spotify-covers.test.js
// Playlist cover mosaics (spotify-ui.js) must survive a rescan. A rescan makes audio-player.js
// rebuild every playlist row from scratch, and the new rows start without a cover.
const assert = require('assert');
const { boot, makeRow, sleep } = require('./spotify-harness');

const TRACKS = [
  { id: '/a/1.mp3', path: '/a/1.mp3', title: 'One', playlist: 'Classical' },
  { id: '/a/2.mp3', path: '/a/2.mp3', title: 'Two', playlist: 'Classical' },
  { id: '/b/3.mp3', path: '/b/3.mp3', title: 'Three', playlist: null },
];
const rowsNow = () => [makeRow('all', 'All songs', 3), makeRow('Classical', 'Classical', 2)];
const allCovered = rows => rows.every(r => r.hasAttribute('data-sp-cover') && /^url\("data:image\/jpeg;mosaic/.test(r.props['--sp-cover']));

(async () => {
  const t = boot({ tracks: TRACKS });
  const first = rowsNow();
  t.showRows(first);
  await sleep(700);
  assert.ok(allCovered(first), 'covers are drawn the first time');
  console.log('ok - covers are drawn for every playlist with art');

  // A rescan: same library, but every row is a brand-new element with no cover.
  const rescanned = rowsNow();
  t.showRows(rescanned);
  await sleep(700);
  assert.ok(allCovered(rescanned), 'covers are back after a rescan');
  console.log('ok - covers come back on the rebuilt rows after a rescan');

  const again = rowsNow();                                  // and again, the way a user taps Scan repeatedly
  t.showRows(again);
  await sleep(700);
  assert.ok(allCovered(again));
  console.log('ok - and after another rescan');

  // The Home screen shows covers 138 px wide, at up to 3x pixel density: drawn any smaller they look soft.
  assert.ok(t.canvasSizes.length >= 2 && t.canvasSizes.every(size => size >= 360), 'covers drawn at ' + t.canvasSizes);
  console.log('ok - covers are drawn big enough to stay sharp');

  console.log('4 checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

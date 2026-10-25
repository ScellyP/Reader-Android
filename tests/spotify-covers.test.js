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

  // ---- A failed look-up must never be remembered for good -----------------------------------
  // The phone can fail to hand over art once (storage not ready yet, a file still being written,
  // a busy moment during the first scan). The covers then have to come back by themselves.
  const art = p => 'data:image/png;art-' + p;

  {
    let failing = true;
    const t2 = boot({ tracks: TRACKS, getArtwork: p => (failing ? '' : art(p)) });
    const first2 = rowsNow();
    t2.showRows(first2);
    await sleep(700);
    assert.ok(!first2.some(r => r.hasAttribute('data-sp-cover')), 'no art could be read yet, so no covers');
    failing = false;                                             // the phone can read art again

    const scanned = rowsNow();                                   // the user taps "Scan the sky": same songs, new rows
    t2.showRows(scanned);
    await sleep(700);
    assert.ok(allCovered(scanned), 'a rescan brings the covers back after a failed first attempt');
    console.log('ok - covers appear after a rescan even if the first art look-up failed');
  }

  {
    let failing = true;
    const t3 = boot({ tracks: TRACKS, getArtwork: p => (failing ? '' : art(p)) });
    const rows3 = rowsNow();
    t3.showRows(rows3);
    await sleep(700);
    failing = false;                                             // nobody rescans: it has to retry by itself
    await sleep(4600);
    assert.ok(allCovered(rows3), 'covers appear on their own a few seconds later');
    console.log('ok - covers appear by themselves after a failed first attempt (no rescan needed)');
  }

  {
    // A rescan lands in the middle of the cover pass: the rows it was working on are replaced.
    let slow = true;
    const t4 = boot({ tracks: TRACKS, getArtwork: p => art(p) });
    const a = rowsNow();
    t4.showRows(a);
    await sleep(170);                                            // the pass has just started (150 ms debounce)
    const b = rowsNow();
    t4.showRows(b);                                              // every row it knew is now a stale element
    await sleep(900);
    assert.ok(allCovered(b), 'rows rebuilt during the pass still get their covers');
    console.log('ok - rows rebuilt in the middle of a pass still get covers');
  }

  console.log('7 checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

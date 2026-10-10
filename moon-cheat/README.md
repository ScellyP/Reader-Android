# Moon-lock cheat code (with crack + moon-phase feedback)

Copy `src/` into the app. Needs `react-native-svg` and AsyncStorage.

1. Use `LockScreen` (or copy its wiring) for the 12:00 lock screen.
2. On app start / resume: `if (await isCheatUnlocked()) skipLock();`
3. Holidays: `src/holidays.ts` (DSATM III Sem calendar + Republic Day 2027).
   Sundays and odd Saturdays are rule-based and work for any year.

Active days: holiday OR Sunday OR 1st/3rd/5th Saturday. Other days: the moon is
a static full moon with no handler and no cracks.

## Mechanic
- A hidden target 1-100 is rolled each time the lock screen appears.
- Every moon tap advances one phase (New -> Waxing Crescent -> First Quarter ->
  Waxing Gibbous -> Full -> Waning Gibbous -> Last Quarter -> Waning Crescent -> New).
- progress = taps / target drives the glass (`src/cracks.ts`, adapted from the "Glass Crack
  Effect" canvas pen). **Four impacts**, one on each screen edge (top, right, bottom, left),
  each a **26-ray** web (radial lines + rings + diagonals, bent quadratic curves, fracture
  shards, scratches) growing inward. The webs start in a shuffled order (stagger), so the first
  crack can come from any side. Every segment has a progress window, so reach, crack count and
  stroke weight all scale with taps / target.
- **Glass facets**: the triangles between neighbouring cracks are filled in three brightness
  tiers (batched into one path per tier). Each facet snaps in from 84% to full size when the
  crack reaches it; about 1 in 5 is displaced (tilted up to ~8 degrees and nudged outward).
- **Impact flash**: an 8-ray starburst at each impact grows with that web's own progress.
- **Screen shake**: every tap shakes the screen horizontally; amplitude (2 to 12 px) and
  duration scale with progress. The final tap also fires a full-screen flash. Both are skipped
  when the OS "reduce motion" setting is on.
- **Terminal state (100%)**: reverse contrast. Dark mode = solid white screen, black cracks;
  light mode = solid black screen, white cracks. The one-hour unlock is stored and the app
  opens to the normal interface.
- Performance: path strings are rebuilt only on 40 quantised progress steps
  (`renderProgress`), segments/facets are precomputed once per seed + screen size, and each
  frame is a handful of batched `<Path>`s (about 1,900 segments / 1,600 facets at 390x844).

`npm test` runs date + tap + moon-phase + crack tests.
`npx tsx tools/preview.ts` writes `preview.svg` (moon phases + crack frames).

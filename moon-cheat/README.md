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
- progress = taps / target drives the glass cracks (`src/cracks.ts`, adapted from the
  "Glass Crack Effect" canvas pen): 7 impact points sit on the SCREEN EDGES, each
  grows a web (radial lines + rings + diagonals, bent quadratic curves, fracture
  shards, scratches) inward. Every crack segment has a progress window, so reach,
  crack count and stroke weight all scale with the percentage of taps completed.
  Soft inverse-colour glow spreads from each impact and a full fill lands at 100%.
- Reverse contrast: dark mode = white glass with black cracks; light mode = black
  glass with white cracks.
- At target the screen is fully covered, the one-hour unlock is stored, and the
  app opens to the normal interface.

`npm test` runs date + tap + moon-phase + crack tests.
`npx tsx tools/preview.ts` writes `preview.svg` (moon phases + crack frames).

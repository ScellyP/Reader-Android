# Moon-lock cheat code

Copy `src/` into the app (e.g. next to the lock screen in the audio framework).

1. Replace the app's lock screen moon with `LockScreen`, or copy the `cheat`
   wiring from it into the existing component.
2. On app start / resume: `if (await isCheatUnlocked()) skipLock();`
3. Holidays live in `src/holidays.ts` (DSATM III Sem calendar, Aug-Dec 2026,
   plus Republic Day 2027). Sundays and odd Saturdays are rule-based and work
   for any year. Add more dates to HOLIDAYS for 2027 onwards.

Active days: holiday OR Sunday OR 1st/3rd/5th Saturday.
Mechanic: tap the moon in a burst (gaps < 1.5 s); the burst must equal the
hidden random target (1-100). Wrong burst resets the count. Success stores an
expiry timestamp, unlocking for exactly 1 hour (survives app restarts).

Run logic tests: `npm test` (via tsx).

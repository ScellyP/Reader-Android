import { isCheatDay, isOddSaturday } from "../src/cheatDay";
import { MoonTapCheat } from "../src/cheatCode";

const d = (s: string) => new Date(s + "T12:00:00");
let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} -> ${got}`);
};

eq("Sun 2026-10-11 active", isCheatDay(d("2026-10-11")), true);
eq("Sat 2026-10-03 (1st) active", isCheatDay(d("2026-10-03")), true);
eq("Sat 2026-10-10 (2nd) rule", isOddSaturday(d("2026-10-10")), false);
eq("Sat 2026-10-10 holiday Mahalaya active", isCheatDay(d("2026-10-10")), true);
eq("Sat 2026-09-26 (4th) Valmiki Jayanthi active", isCheatDay(d("2026-09-26")), true);
eq("Sat 2026-10-24 (4th) inactive", isCheatDay(d("2026-10-24")), false);
eq("Sat 2026-10-31 (5th) active", isCheatDay(d("2026-10-31")), true);
eq("Wed 2026-10-14 inactive", isCheatDay(d("2026-10-14")), false);
eq("Fri 2026-10-02 Gandhi Jayanti active", isCheatDay(d("2026-10-02")), true);
eq("Fri 2026-12-25 Christmas active", isCheatDay(d("2026-12-25")), true);

// tap logic
(async () => {
  let unlocked = 0;
  const c = new MoonTapCheat(() => unlocked++, 7);
  for (let i = 0; i < 7; i++) c.tap();
  await new Promise(r => setTimeout(r, 1700));
  eq("exact 7 taps unlocks", unlocked, 1);
  for (let i = 0; i < 6; i++) c.tap();
  await new Promise(r => setTimeout(r, 1700));
  eq("6 taps does not unlock", unlocked, 1);
  c.dispose();
  process.exit(fail ? 1 : 0);
})();

// General holidays from the DSATM III Semester BE academic calendar
// (24 Aug 2026 - 21 Dec 2026). Local dates, "YYYY-MM-DD".
// Odd Saturdays are ALSO computed by rule in cheatDay.ts; the Saturdays listed
// here are kept so the file mirrors the calendar 1:1.
export const HOLIDAYS: Record<string, string> = {
  "2026-08-26": "Id-Milad",
  "2026-08-29": "5th Saturday",
  "2026-09-05": "1st Saturday",
  "2026-09-14": "Ganesha Chaturthi",
  "2026-09-19": "3rd Saturday",
  "2026-09-26": "Valmiki Jayanthi",
  "2026-10-02": "Gandhi Jayanti",
  "2026-10-03": "1st Saturday",
  "2026-10-10": "Mahalaya Amavasya",
  "2026-10-17": "3rd Saturday",
  "2026-10-20": "Ayudha Pooja",
  "2026-10-21": "Vijayadashami",
  "2026-10-31": "5th Saturday",
  "2026-11-01": "Kannada Rajyothsava",
  "2026-11-07": "1st Saturday",
  "2026-11-10": "Diwali",
  "2026-11-21": "3rd Saturday",
  "2026-11-27": "Kanakadasa Jayanthi",
  "2026-12-05": "1st Saturday",
  "2026-12-19": "3rd Saturday",
  "2026-12-25": "Christmas",
  // Outside the calendar's range: standard national holiday, add more as needed.
  "2027-01-26": "Republic Day",
};

export const HOLIDAY_KEYS = new Set<string>(Object.keys(HOLIDAYS));

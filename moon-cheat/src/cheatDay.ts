import { HOLIDAY_KEYS } from "./holidays";

const pad = (n: number) => String(n).padStart(2, "0");

/** Local-time key, e.g. "2026-10-10". Uses device local date on purpose. */
export const toLocalKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const isSunday = (d: Date) => d.getDay() === 0;

/** 1st, 3rd, 5th Saturday of the month. */
export const isOddSaturday = (d: Date) =>
  d.getDay() === 6 && Math.ceil(d.getDate() / 7) % 2 === 1;

export const isHoliday = (d: Date, holidays: Set<string> = HOLIDAY_KEYS) =>
  holidays.has(toLocalKey(d));

export const isCheatDay = (d: Date = new Date(), holidays: Set<string> = HOLIDAY_KEYS) =>
  isHoliday(d, holidays) || isSunday(d) || isOddSaturday(d);

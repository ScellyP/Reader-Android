import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "cheat_unlock_until";
export const UNLOCK_MS = 60 * 60 * 1000; // exactly one hour

export async function grantOneHourUnlock(now: number = Date.now()) {
  await AsyncStorage.setItem(KEY, String(now + UNLOCK_MS));
}

export async function unlockRemainingMs(now: number = Date.now()) {
  const v = await AsyncStorage.getItem(KEY);
  return v === null ? 0 : Math.max(0, Number(v) - now);
}

/** Call on app start, on resume, and before showing the 12:00 lock screen. */
export async function isCheatUnlocked(now: number = Date.now()) {
  return (await unlockRemainingMs(now)) > 0;
}

export async function clearUnlock() {
  await AsyncStorage.removeItem(KEY);
}

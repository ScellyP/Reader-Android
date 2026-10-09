/** Strict astronomical order. Index 0 = New Moon ... 7 = Waning Crescent. */
export const MOON_PHASES = [
  "New Moon",
  "Waxing Crescent",
  "First Quarter",
  "Waxing Gibbous",
  "Full Moon",
  "Waning Gibbous",
  "Last Quarter",
  "Waning Crescent",
] as const;

/** Each tap advances one phase; wraps back to New Moon after Waning Crescent. */
export const phaseIndexForCount = (count: number) => ((count % 8) + 8) % 8;

/**
 * SVG path of the LIT part of the moon (draw it over a dim full disc).
 * Waxing (1-3): lit on the right. Waning (5-7): lit on the left.
 */
export function moonLitPath(index: number, cx: number, cy: number, r: number): string {
  const k = ((index % 8) + 8) % 8;
  if (k === 0) return ""; // new moon: nothing lit
  if (k === 4) {
    return `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`;
  }
  const waxing = k < 4;
  const top = `${cx} ${cy - r}`;
  const bottom = `${cx} ${cy + r}`;
  const limbSweep = waxing ? 1 : 0; // right limb clockwise, left limb counter-clockwise
  const rx = r * Math.abs(Math.cos((k * Math.PI) / 4)); // terminator half-width
  const quarter = k === 2 || k === 6;
  const termSweep = k === 3 || k === 7 ? 1 : 0; // bulges left for k=3,7; right for k=1,5
  const terminator = quarter ? `L ${top}` : `A ${rx} ${r} 0 0 ${termSweep} ${top}`;
  return `M ${top} A ${r} ${r} 0 0 ${limbSweep} ${bottom} ${terminator} Z`;
}

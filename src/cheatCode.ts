export const MIN_TAPS = 1;
export const MAX_TAPS = 100;
export const BURST_GAP_MS = 1500; // pause that ends one attempt

export const randomTarget = (): number => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return MIN_TAPS + (buf[0] % (MAX_TAPS - MIN_TAPS + 1));
};

/**
 * A "burst" = taps with gaps shorter than BURST_GAP_MS.
 * When the burst ends, count === target unlocks; otherwise the count resets.
 * Target is fixed for the lifetime of this instance (one lock-screen session).
 */
export class MoonTapCheat {
  private count = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly target: number;

  constructor(private onUnlock: () => void, target: number = randomTarget()) {
    this.target = target;
  }

  tap() {
    this.count += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.evaluate(), BURST_GAP_MS);
  }

  private evaluate() {
    const ok = this.count === this.target;
    this.count = 0;
    this.timer = null;
    if (ok) this.onUnlock();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

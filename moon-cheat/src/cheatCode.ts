import { phaseIndexForCount } from "./moonPhase";

export const MIN_TAPS = 1;
export const MAX_TAPS = 100;

export const randomTarget = (): number => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return MIN_TAPS + (buf[0] % (MAX_TAPS - MIN_TAPS + 1));
};

export interface TapState {
  count: number;
  target: number;
  progress: number;   // count / target, 0..1 -> drives crack intensity
  phaseIndex: number; // 0..7 -> moon phase
  done: boolean;      // count reached target
}

/** Target is picked once per lock-screen session; every tap advances progress. */
export class TapProgress {
  private count = 0;
  readonly target: number;

  constructor(target: number = randomTarget()) {
    this.target = target;
  }

  get state(): TapState {
    return {
      count: this.count,
      target: this.target,
      progress: Math.min(1, this.count / this.target),
      phaseIndex: phaseIndexForCount(this.count),
      done: this.count >= this.target,
    };
  }

  tap(): TapState {
    if (this.count < this.target) this.count += 1;
    return this.state;
  }
}

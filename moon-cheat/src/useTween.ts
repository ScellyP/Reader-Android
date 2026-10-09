import { useEffect, useRef, useState } from "react";

/** Smoothly animates a number toward `target` (ease-out cubic), restarting from the current value. */
export function useTween(target: number, ms = 350) {
  const [value, setValue] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    const from = current.current;
    const t0 = Date.now();
    let raf = 0;
    const step = () => {
      const t = Math.min(1, (Date.now() - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      current.current = t >= 1 ? target : from + (target - from) * e;
      setValue(current.current);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);

  return value;
}

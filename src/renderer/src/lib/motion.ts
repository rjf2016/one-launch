import { useEffect, useRef, useState } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Windows' "Animation effects" switch, read live. Anything that loops or moves on its own asks this first. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (): void => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** The number to show while counting from the last value to `target` over `ms`, so a total that arrives all at once still reads as being found. */
export function useCountUp(target: number, ms = 600): number {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const from = current.current;
    if (reduced || from === target) {
      current.current = target;
      setShown(target);
      return;
    }
    const started = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - started) / ms);
      const value = Math.round(from + (target - from) * (1 - (1 - t) ** 3));
      current.current = value;
      setShown(value);
      if (t < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, ms, reduced]);
  return shown;
}

/** A self-playing demo's clock: 0 to `steps - 1` and round again, one step every `everyMs`; held at `restAt` under reduced motion. */
export function useLoop(steps: number, everyMs: number, restAt: number): number {
  const reduced = usePrefersReducedMotion();
  const [tick, setTick] = useState(reduced ? restAt : 0);
  useEffect(() => {
    if (reduced) {
      setTick(restAt);
      return;
    }
    const id = window.setInterval(() => setTick((t) => (t + 1) % steps), everyMs);
    return () => window.clearInterval(id);
  }, [steps, everyMs, restAt, reduced]);
  return tick;
}

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
};

export interface TimerSet {
  timeouts: Set<NodeJS.Timeout>;
  immediates: Set<NodeJS.Immediate>;
}

let owner: TimerSet | null = null;
let installed = false;

export const newTimerSet = (): TimerSet => ({ timeouts: new Set(), immediates: new Set() });

// Every timer the app code sets while an instance is live is that instance's, so a crash can take them all at once, as the end of a process does.
export function installTimerTracking(): void {
  if (installed) return;
  installed = true;
  const timeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]): NodeJS.Timeout => {
    const set = owner;
    const handle = real.setTimeout(
      (...a: unknown[]) => {
        set?.timeouts.delete(handle);
        fn(...a);
      },
      ms,
      ...args,
    );
    set?.timeouts.add(handle);
    return handle;
  };
  const interval = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]): NodeJS.Timeout => {
    const handle = real.setInterval(fn, ms, ...args);
    owner?.timeouts.add(handle);
    return handle;
  };
  const immediate = (fn: (...a: unknown[]) => void, ...args: unknown[]): NodeJS.Immediate => {
    const set = owner;
    const handle = real.setImmediate(
      (...a: unknown[]) => {
        set?.immediates.delete(handle);
        fn(...a);
      },
      ...args,
    );
    set?.immediates.add(handle);
    return handle;
  };
  Object.assign(globalThis, {
    setTimeout: Object.assign(timeout, real.setTimeout),
    setInterval: interval,
    setImmediate: Object.assign(immediate, real.setImmediate),
  });
}

export function ownTimers(set: TimerSet | null): void {
  owner = set;
}

export function clearTimers(set: TimerSet): void {
  for (const handle of set.timeouts) {
    real.clearTimeout(handle);
    real.clearInterval(handle);
  }
  for (const handle of set.immediates) real.clearImmediate(handle);
  set.timeouts.clear();
  set.immediates.clear();
}

/** The harness's own waits never belong to an instance. */
export const pause = (ms: number): Promise<void> => new Promise((resolve) => real.setTimeout(resolve, ms));

/** One full turn of the event loop: the app code that was running has reached its next timer by the time this resolves. */
export const turn = (): Promise<void> => new Promise((resolve) => real.setImmediate(resolve));

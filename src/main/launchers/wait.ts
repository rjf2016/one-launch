/** Thrown by an aborted wait. runSwitch turns it into a cancelled result; it never reaches the renderer. */
export class SwitchAbortedError extends Error {
  readonly code = 'ABORTED';
  constructor() {
    super('The switch was stopped');
    this.name = 'SwitchAbortedError';
  }
}

/** Resolves after `ms`, or at once when the signal aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * An adapter's timing set with overrides applied. An override that shortens `pollMs` (tests, the simulators) without
 * naming the finer polls (`logPollMs`, `processPollMs`) brings those down to it too: a finer poll is never slower than the coarse one.
 */
export function mergeTiming<T extends { pollMs: number }>(defaults: T, over: Partial<T> | undefined): T {
  const merged: T = { ...defaults, ...over };
  if (over?.pollMs === undefined) return merged;
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    if (key === 'pollMs' || !key.endsWith('PollMs') || over[key] !== undefined) continue;
    merged[key] = Math.min(defaults[key] as number, over.pollMs) as T[typeof key];
  }
  return merged;
}

/** Polls `cond` until it holds (true) or `timeoutMs` passes (false). Throws SwitchAbortedError as soon as the signal aborts. */
export async function waitUntil(cond: () => Promise<boolean>, opts: { timeoutMs: number; pollMs: number; signal?: AbortSignal | undefined }): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) throw new SwitchAbortedError();
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(opts.pollMs, opts.signal);
  }
}

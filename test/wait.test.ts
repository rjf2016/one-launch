import { describe, expect, it } from 'vitest';
import { mergeTiming, sleep, SwitchAbortedError, waitUntil } from '../src/main/launchers/wait';

describe('mergeTiming', () => {
  it('applies overrides, and brings the finer polls down to a shortened pollMs they do not name', () => {
    const defaults = { pollMs: 500, logPollMs: 250, processPollMs: 1_000, shutdownMs: 20_000 };
    expect(mergeTiming(defaults, undefined)).toEqual(defaults);
    expect(mergeTiming(defaults, { shutdownMs: 5 })).toEqual({ ...defaults, shutdownMs: 5 });
    expect(mergeTiming(defaults, { pollMs: 2 })).toEqual({ pollMs: 2, logPollMs: 2, processPollMs: 2, shutdownMs: 20_000 });
    expect(mergeTiming(defaults, { pollMs: 2, processPollMs: 40 })).toEqual({ pollMs: 2, logPollMs: 2, processPollMs: 40, shutdownMs: 20_000 });
    expect(mergeTiming(defaults, { pollMs: 900 })).toEqual({ pollMs: 900, logPollMs: 250, processPollMs: 900, shutdownMs: 20_000 });
  });
});

describe('sleep', () => {
  it('waits out its time without a signal and returns at once when the signal aborts', async () => {
    let started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);

    const controller = new AbortController();
    started = Date.now();
    setTimeout(() => controller.abort(), 5);
    await sleep(5_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);

    started = Date.now();
    await sleep(5_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('waitUntil', () => {
  it('reports whether the condition held before the timeout', async () => {
    let polls = 0;
    expect(await waitUntil(async () => ++polls >= 3, { timeoutMs: 500, pollMs: 1 })).toBe(true);
    expect(polls).toBe(3);
    expect(await waitUntil(async () => false, { timeoutMs: 10, pollMs: 1 })).toBe(false);
  });

  it('throws SwitchAbortedError as soon as the signal aborts, even mid-poll', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const started = Date.now();
    await expect(waitUntil(async () => false, { timeoutMs: 5_000, pollMs: 2_000, signal: controller.signal })).rejects.toBeInstanceOf(SwitchAbortedError);
    expect(Date.now() - started).toBeLessThan(1_000);

    let polled = false;
    await expect(
      waitUntil(
        async () => {
          polled = true;
          return true;
        },
        { timeoutMs: 100, pollMs: 1, signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(SwitchAbortedError);
    expect(polled).toBe(false);
  });
});

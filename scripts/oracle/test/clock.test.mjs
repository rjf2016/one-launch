import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORACLE_CLOCK, installOracleClock } from '../lib/clock.mjs';

const RealDate = globalThis.Date;
const START = RealDate.parse(ORACLE_CLOCK);
const sinceStart = () => Date.now() - START;

afterEach(() => {
  vi.useRealTimers();
  globalThis.Date = RealDate;
});

describe('installOracleClock', () => {
  it('starts the clock at the pin and keeps it running', async () => {
    installOracleClock();
    const first = sinceStart();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(5_000);
    expect(new Date().getTime() - START).toBeLessThan(5_000);
    await new Promise((done) => setTimeout(done, 40));
    expect(sinceStart()).toBeGreaterThanOrEqual(first + 20);
  });

  it('leaves a date built from a value alone', () => {
    installOracleClock();
    expect(new Date(0).getTime()).toBe(0);
    expect(new Date('2020-02-03T04:05:06.007Z').toISOString()).toBe('2020-02-03T04:05:06.007Z');
    expect(new Date(2020, 0, 2, 3, 4, 5, 6).getTime()).toBe(new RealDate(2020, 0, 2, 3, 4, 5, 6).getTime());
    expect(Date.UTC(2020, 0, 2)).toBe(RealDate.UTC(2020, 0, 2));
    expect(Date.parse('2020-02-03T04:05:06Z')).toBe(RealDate.parse('2020-02-03T04:05:06Z'));
    expect(Number.isNaN(new Date(undefined).getTime())).toBe(true);
  });

  it('is still Date to the code under test', () => {
    installOracleClock();
    expect(Date.name).toBe('Date');
    expect(new Date()).toBeInstanceOf(Date);
    expect(new RealDate()).toBeInstanceOf(Date);
    expect(statSync(fileURLToPath(import.meta.url)).mtime).toBeInstanceOf(Date);
    expect(Object.prototype.toString.call(new Date())).toBe('[object Date]');
    expect(Date()).toBe(new Date().toString());
    class Stamp extends Date {}
    const stamp = new Stamp();
    expect(stamp).toBeInstanceOf(Stamp);
    expect(stamp.getTime() - START).toBeLessThan(5_000);
  });

  it('does not shift twice', () => {
    installOracleClock();
    const installed = globalThis.Date;
    installOracleClock();
    expect(globalThis.Date).toBe(installed);
    expect(Math.abs(sinceStart())).toBeLessThan(5_000);
  });

  it('comes back after fake timers, the way the suite uses them', () => {
    installOracleClock();
    vi.useFakeTimers({ toFake: ['Date'] });
    const faked = Date.now();
    expect(Math.abs(faked - START)).toBeLessThan(5_000);
    vi.setSystemTime(faked + 3_000);
    expect(Date.now()).toBe(faked + 3_000);
    vi.useRealTimers();
    expect(Math.abs(sinceStart())).toBeLessThan(5_000);
  });
});

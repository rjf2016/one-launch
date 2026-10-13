import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../src/shared/models';
import type { Logger } from '../src/main/services/logger';
import type { UpdateAvailability } from '../src/main/updates/availability';
import { keyIdOf, publicKeyOf, signManifest, type ManifestFile } from '../src/main/updates/manifest';
import { describeUpdateError, UpdateService, type UpdateDownload, type UpdateEngine } from '../src/main/updates/update-service';

const { privateKey } = generateKeyPairSync('ed25519');
const spki = publicKeyOf(privateKey);
const KEYS = [{ id: keyIdOf(spki), spki }];
const FILE: ManifestFile = { url: 'OneLaunch-1.0.0-beta.2-setup.exe', sha512: createHash('sha512').update('v2').digest('base64'), size: 1000 };
const PATH = 'C:\\cache\\pending\\OneLaunch-1.0.0-beta.2-setup.exe';
const SIGNED = { version: '1.0.0-beta.2', files: [FILE], ...signManifest('1.0.0-beta.2', FILE, privateKey) };
const FIRST = 15_000;
const INTERVAL = 6 * 60 * 60 * 1000;

interface PendingDownload {
  resolve(path: string | null): void;
  reject(err: unknown): void;
  progress(percent: number): void;
  cancelled: boolean;
}

class FakeEngine implements UpdateEngine {
  checks = 0;
  answer: () => Promise<unknown> = async () => null;
  downloads: PendingDownload[] = [];
  installs: boolean[] = [];
  check(): Promise<unknown> {
    this.checks++;
    return this.answer();
  }
  download(onProgress: (percent: number) => void): UpdateDownload {
    let resolve!: (path: string | null) => void;
    let reject!: (err: unknown) => void;
    const done = new Promise<string | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: PendingDownload = { resolve, reject, progress: onProgress, cancelled: false };
    this.downloads.push(pending);
    return {
      done,
      cancel: () => {
        pending.cancelled = true;
        resolve(null);
      },
    };
  }
  install(relaunch: boolean): boolean {
    this.installs.push(relaunch);
    return true;
  }
}

function setup(opts: { auto?: boolean; availability?: UpdateAvailability } = {}) {
  const engine = new FakeEngine();
  const hashes = new Map<string, string>();
  const lines: { level: string; message: string }[] = [];
  const log: Logger = {
    debug: (m) => void lines.push({ level: 'debug', message: m }),
    info: (m) => void lines.push({ level: 'info', message: m }),
    warn: (m) => void lines.push({ level: 'warn', message: m }),
    error: (m) => void lines.push({ level: 'error', message: m }),
    child: () => log,
  };
  const counts = { quits: 0, engines: 0 };
  const service = new UpdateService({
    availability: async () => opts.availability ?? { ok: true },
    engine: async () => {
      counts.engines++;
      return engine;
    },
    keys: KEYS,
    auto: opts.auto ?? true,
    quit: () => void counts.quits++,
    log,
    hashFile: async (p) => hashes.get(p) ?? 'unreadable',
    hashFileSync: (p) => hashes.get(p) ?? 'unreadable',
    now: () => new Date('2026-10-01T12:00:00.000Z'),
    firstCheckMs: FIRST,
    intervalMs: INTERVAL,
  });
  return { service, engine, hashes, lines, counts };
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

async function readyService(opts: { auto?: boolean } = {}) {
  const s = setup(opts);
  s.engine.answer = async () => SIGNED;
  s.hashes.set(PATH, FILE.sha512);
  s.service.check();
  await settle();
  s.engine.downloads[0]!.resolve(PATH);
  await settle();
  expect(s.service.status()).toEqual<UpdateStatus>({ state: 'ready', version: '1.0.0-beta.2' });
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UpdateService: when it checks', () => {
  it('checks nothing on its own while automatic updates are off, but the button still checks', async () => {
    const { service, engine } = setup({ auto: false });
    await service.start();
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(engine.checks).toBe(0);
    expect(service.check()).toEqual({ state: 'checking' });
    await settle();
    expect(engine.checks).toBe(1);
    expect(service.status()).toEqual({ state: 'up-to-date', checkedAt: '2026-10-01T12:00:00.000Z' });
  });

  it('checks 15 s after the start, then every 6 hours', async () => {
    const { service, engine } = setup();
    await service.start();
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(engine.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(engine.checks).toBe(2);
  });

  it('starts checking when automatic updates are turned on, and stops when they are turned off', async () => {
    const { service, engine } = setup({ auto: false });
    await service.start();
    service.setAuto(true);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(engine.checks).toBe(1);
    service.setAuto(false);
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(engine.checks).toBe(1);
  });

  it('never loads the updater for a copy that cannot update itself', async () => {
    const { service, counts } = setup({ availability: { ok: false, reason: 'custom-data-folder' } });
    await service.start();
    expect(service.status()).toEqual({ state: 'unavailable', reason: 'custom-data-folder' });
    expect(service.check()).toEqual({ state: 'unavailable', reason: 'custom-data-folder' });
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(counts.engines).toBe(0);
  });

  it('stops checking once a verified update is waiting', async () => {
    const { service, engine } = await readyService();
    await service.start();
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(engine.checks).toBe(1);
    expect(service.check()).toEqual({ state: 'ready', version: '1.0.0-beta.2' });
    expect(engine.checks).toBe(1);
  });

  it('stop() ends the schedule and cancels a download', async () => {
    const { service, engine } = setup();
    engine.answer = async () => SIGNED;
    await service.start();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(engine.downloads).toHaveLength(1);
    service.stop();
    await settle();
    expect(engine.downloads[0]!.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(engine.checks).toBe(1);
  });
});

describe('UpdateService: what it downloads', () => {
  it('downloads a signed update, reports progress, and is ready once the bytes hash to the signed value', async () => {
    const { service, engine, hashes, lines } = setup();
    engine.answer = async () => SIGNED;
    service.check();
    await settle();
    expect(service.status()).toEqual({ state: 'downloading', version: '1.0.0-beta.2', percent: 0 });
    engine.downloads[0]!.progress(42.7);
    expect(service.status()).toEqual({ state: 'downloading', version: '1.0.0-beta.2', percent: 42 });
    hashes.set(PATH, FILE.sha512);
    engine.downloads[0]!.resolve(PATH);
    await settle();
    expect(service.status()).toEqual({ state: 'ready', version: '1.0.0-beta.2' });
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('never downloads an unsigned update, or one signed with another key', async () => {
    const { service, engine, lines } = setup();
    const { signature: _s, keyId: _k, ...unsigned } = SIGNED;
    engine.answer = async () => unsigned;
    service.check();
    await settle();
    expect(service.status()).toEqual({ state: 'failed', step: 'verify', message: 'the release is not signed' });

    const other = generateKeyPairSync('ed25519').privateKey;
    engine.answer = async () => ({ ...SIGNED, ...signManifest('1.0.0-beta.2', FILE, other) });
    service.check();
    await settle();
    expect(service.status()).toMatchObject({ state: 'failed', step: 'verify' });
    expect(engine.downloads).toEqual([]);
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual(['update verify failed', 'update verify failed']);
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('refuses a download whose bytes do not hash to the signed value', async () => {
    const { service, engine, hashes } = setup();
    engine.answer = async () => SIGNED;
    service.check();
    await settle();
    hashes.set(PATH, createHash('sha512').update('something else').digest('base64'));
    engine.downloads[0]!.resolve(PATH);
    await settle();
    expect(service.status()).toEqual({ state: 'failed', step: 'verify', message: 'the downloaded file does not match the signed release' });
    service.installAtQuit(0);
    expect(engine.installs).toEqual([]);
  });

  it('turning automatic updates off cancels a background download, not one the user asked for', async () => {
    const background = setup();
    background.engine.answer = async () => SIGNED;
    await background.service.start();
    await vi.advanceTimersByTimeAsync(FIRST);
    background.service.setAuto(false);
    await settle();
    expect(background.engine.downloads[0]!.cancelled).toBe(true);
    expect(background.service.status()).toEqual({ state: 'idle' });

    const manual = setup();
    manual.engine.answer = async () => SIGNED;
    manual.service.check();
    await settle();
    manual.service.setAuto(false);
    expect(manual.engine.downloads[0]!.cancelled).toBe(false);
  });

  it('reports failures as warnings in plain words, never as errors', async () => {
    const { service, engine, lines } = setup();
    engine.answer = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'));
    service.check();
    await settle();
    expect(service.status()).toEqual({ state: 'failed', step: 'check', message: 'the update server could not be reached' });

    engine.answer = async () => SIGNED;
    service.check();
    await settle();
    engine.downloads[0]!.reject(Object.assign(new Error('HttpError: 503'), { statusCode: 503 }));
    await settle();
    expect(service.status()).toEqual({ state: 'failed', step: 'download', message: 'the update server answered HTTP 503' });
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
  });
});

describe('UpdateService: when it installs', () => {
  it('installs at quit when automatic updates are on, without starting One Launch again', async () => {
    const { service, engine } = await readyService();
    service.installAtQuit(0);
    expect(engine.installs).toEqual([false]);
  });

  it('Restart to update quits, then installs and starts One Launch again', async () => {
    const { service, engine, counts } = await readyService({ auto: false });
    service.requestInstall();
    expect(counts.quits).toBe(1);
    service.installAtQuit(0);
    expect(engine.installs).toEqual([true]);
  });

  it('waits for Restart to update when automatic updates are off', async () => {
    const { service, engine } = await readyService({ auto: false });
    service.installAtQuit(0);
    expect(engine.installs).toEqual([]);
  });

  it('never installs during a Windows shutdown, after a crash, or on a failed exit', async () => {
    const shutdown = await readyService();
    shutdown.service.onSessionEnd();
    shutdown.service.installAtQuit(0);
    expect(shutdown.engine.installs).toEqual([]);

    const crash = await readyService();
    crash.service.onCrash();
    crash.service.requestInstall();
    crash.service.installAtQuit(0);
    expect(crash.engine.installs).toEqual([]);

    const failed = await readyService();
    failed.service.installAtQuit(1);
    expect(failed.engine.installs).toEqual([]);
  });

  it('hashes the file again right before running it', async () => {
    const { service, engine, hashes, lines } = await readyService();
    hashes.set(PATH, 'tampered');
    service.installAtQuit(0);
    expect(engine.installs).toEqual([]);
    expect(lines.at(-1)).toEqual({ level: 'warn', message: 'update install refused: the downloaded file changed after it was verified' });
  });

  it('refuses an install request before anything is verified', () => {
    const { service, counts } = setup();
    expect(() => service.requestInstall()).toThrow(expect.objectContaining({ code: 'NOT_READY' }));
    expect(counts.quits).toBe(0);
  });
});

describe('describeUpdateError', () => {
  it.each([
    [new Error('net::ERR_NAME_NOT_RESOLVED'), 'the update server could not be reached'],
    [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }), 'the update server could not be reached'],
    [Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }), 'no release has been published yet'],
    [Object.assign(new Error('Cannot find latest.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), 'the latest release has no update manifest'],
    [Object.assign(new Error('404'), { statusCode: 404 }), 'the update server answered HTTP 404'],
    [
      Object.assign(new Error('sha512 checksum mismatch, expected abc, got def'), { code: 'ERR_CHECKSUM_MISMATCH' }),
      'the downloaded file does not match the release',
    ],
    [new Error('first line\nsecond line'), 'first line'],
    ['x'.repeat(300), `${'x'.repeat(159)}…`],
  ])('%s', (err, expected) => {
    expect(describeUpdateError(err)).toBe(expected);
  });
});

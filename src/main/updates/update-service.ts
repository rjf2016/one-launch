import type { UpdateStatus } from '@shared/models';
import type { Logger } from '../services/logger';
import type { UpdateAvailability } from './availability';
import { sha512OfFile, sha512OfFileSync, verifyManifest, type ReleaseKey } from './manifest';

export interface UpdateDownload {
  /** The downloaded installer's path, or null when the download was cancelled. */
  done: Promise<string | null>;
  cancel(): void;
}

export interface UpdateEngine {
  /** The release manifest when a newer version is published, else null. */
  check(): Promise<unknown>;
  download(onProgress: (percent: number) => void): UpdateDownload;
  install(relaunch: boolean): boolean;
}

export class UpdateNotReadyError extends Error {
  readonly code = 'NOT_READY';
  constructor() {
    super('No verified update has been downloaded yet');
    this.name = 'UpdateNotReadyError';
  }
}

export const FIRST_CHECK_MS = 15_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateServiceDeps {
  availability: () => Promise<UpdateAvailability>;
  engine: () => Promise<UpdateEngine>;
  keys: readonly ReleaseKey[];
  auto: boolean;
  quit: () => void;
  log: Logger;
  hashFile?: (path: string) => Promise<string>;
  hashFileSync?: (path: string) => string;
  now?: () => Date;
  firstCheckMs?: number;
  intervalMs?: number;
}

const UNREACHABLE =
  /net::ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_\w+|ADDRESS_UNREACHABLE|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|TIMED_OUT|PROXY_CONNECTION_FAILED)|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT/;

export function describeUpdateError(err: unknown): string {
  const e = (err && typeof err === 'object' ? err : {}) as { message?: unknown; code?: unknown; statusCode?: unknown };
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (UNREACHABLE.test(message)) return 'the update server could not be reached';
  if (e.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || e.code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND') return 'no release has been published yet';
  if (e.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return 'the latest release has no update manifest';
  if (e.code === 'ERR_CHECKSUM_MISMATCH' || /checksum mismatch/i.test(message)) return 'the downloaded file does not match the release';
  if (typeof e.statusCode === 'number') return `the update server answered HTTP ${e.statusCode}`;
  const first = message.split(/\r?\n/)[0]?.trim() ?? '';
  if (!first) return 'unknown error';
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

interface VerifiedUpdate {
  version: string;
  file: string;
  sha512: string;
}

export class UpdateService {
  private readonly deps: UpdateServiceDeps;
  private readonly hashFile: (path: string) => Promise<string>;
  private readonly hashFileSync: (path: string) => string;
  private readonly now: () => Date;
  private current: UpdateStatus = { state: 'idle' };
  private availability: Promise<UpdateAvailability> | null = null;
  private auto: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private download: { cancel(): void; background: boolean } | null = null;
  private engine: UpdateEngine | null = null;
  private verified: VerifiedUpdate | null = null;
  private installRequested = false;
  private installBlocked: string | null = null;
  private stopped = false;

  constructor(deps: UpdateServiceDeps) {
    this.deps = deps;
    this.auto = deps.auto;
    this.hashFile = deps.hashFile ?? sha512OfFile;
    this.hashFileSync = deps.hashFileSync ?? sha512OfFileSync;
    this.now = deps.now ?? (() => new Date());
  }

  status(): UpdateStatus {
    return { ...this.current };
  }

  start(): Promise<void> {
    return this.available().then((ok) => {
      if (ok) this.schedule(this.deps.firstCheckMs ?? FIRST_CHECK_MS);
    });
  }

  check(): UpdateStatus {
    if (this.stopped || this.current.state === 'unavailable' || this.verified || this.running) return this.status();
    void this.run('manual');
    return this.status();
  }

  setAuto(on: boolean): void {
    if (this.auto === on) return;
    this.auto = on;
    if (on) {
      if (this.current.state !== 'unavailable') this.schedule(this.deps.firstCheckMs ?? FIRST_CHECK_MS);
      return;
    }
    this.clearTimer();
    if (this.download?.background) {
      this.deps.log.info('update download cancelled: automatic updates turned off');
      this.download.cancel();
    }
  }

  requestInstall(): void {
    if (!this.verified) throw new UpdateNotReadyError();
    this.installRequested = true;
    this.deps.log.info('update install requested', { version: this.verified.version });
    this.deps.quit();
  }

  onSessionEnd(): void {
    this.installBlocked = 'Windows is shutting down or signing out';
  }

  onCrash(): void {
    this.installBlocked = 'an unexpected error happened in this run';
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.download?.cancel();
  }

  /** Runs from the app's quit event, after the database has closed; must stay synchronous. */
  installAtQuit(exitCode: number): void {
    const update = this.verified;
    if (!update || !this.engine) return;
    const relaunch = this.installRequested;
    if (!relaunch && !this.auto) {
      this.deps.log.info('update left for a restart: automatic updates are off', { version: update.version });
      return;
    }
    if (this.installBlocked) {
      this.deps.log.info('update not installed at quit', { version: update.version, reason: this.installBlocked });
      return;
    }
    if (exitCode !== 0) {
      this.deps.log.info('update not installed at quit', { version: update.version, exitCode });
      return;
    }
    let actual: string;
    try {
      actual = this.hashFileSync(update.file);
    } catch (err) {
      this.deps.log.warn('update install refused: the downloaded file cannot be read', { version: update.version, error: err });
      return;
    }
    if (actual !== update.sha512) {
      this.deps.log.warn('update install refused: the downloaded file changed after it was verified', { version: update.version });
      return;
    }
    const started = this.engine.install(relaunch);
    this.deps.log.info('update install', { version: update.version, relaunch, started });
  }

  private available(): Promise<boolean> {
    this.availability ??= this.deps.availability().catch((err: unknown): UpdateAvailability => {
      this.deps.log.warn('update availability check failed', { error: err });
      return { ok: false, reason: 'not-installed' };
    });
    return this.availability.then((a) => {
      if (a.ok) return true;
      if (this.current.state !== 'unavailable') this.deps.log.info('updates unavailable', { reason: a.reason });
      this.current = { state: 'unavailable', reason: a.reason };
      return false;
    });
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    if (this.stopped || !this.auto || this.verified) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run('background').finally(() => this.schedule(this.deps.intervalMs ?? CHECK_INTERVAL_MS));
    }, ms);
  }

  private run(origin: 'background' | 'manual'): Promise<void> {
    if (this.running) return this.running;
    this.current = { state: 'checking' };
    this.running = this.checkAndDownload(origin).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private fail(step: 'check' | 'download' | 'verify', message: string, meta: Record<string, unknown> = {}): void {
    this.current = { state: 'failed', step, message };
    this.deps.log.warn(`update ${step} failed`, { ...meta, message });
  }

  private async checkAndDownload(origin: 'background' | 'manual'): Promise<void> {
    if (!(await this.available())) return;
    this.deps.log.info('update check', { origin });
    let info: unknown;
    try {
      this.engine ??= await this.deps.engine();
      info = await this.engine.check();
    } catch (err) {
      if (!this.stopped) this.fail('check', describeUpdateError(err));
      return;
    }
    if (this.stopped) return;
    if (info === null || info === undefined) {
      this.current = { state: 'up-to-date', checkedAt: this.now().toISOString() };
      this.deps.log.info('update check: up to date');
      return;
    }
    if (origin === 'background' && !this.auto) {
      this.current = { state: 'idle' };
      return;
    }

    // Verify and start the download in one synchronous step, so no later check can replace the manifest in between.
    const verdict = verifyManifest(info, this.deps.keys);
    if (!verdict.ok) {
      const version = (info as { version?: unknown }).version;
      this.fail('verify', verdict.detail, { version: typeof version === 'string' ? version : null, reason: verdict.reason });
      return;
    }
    const { version, file } = verdict;
    this.current = { state: 'downloading', version, percent: 0 };
    const pending = this.engine.download((percent) => {
      if (this.current.state === 'downloading') this.current = { state: 'downloading', version, percent: Math.max(0, Math.min(100, Math.floor(percent))) };
    });
    this.download = { cancel: () => pending.cancel(), background: origin === 'background' };
    this.deps.log.info('update available', { version, keyId: verdict.keyId, size: file.size });

    let path: string | null;
    try {
      path = await pending.done;
    } catch (err) {
      if (!this.stopped) this.fail('download', describeUpdateError(err), { version });
      return;
    } finally {
      this.download = null;
    }
    if (this.stopped) return;
    if (path === null) {
      this.current = { state: 'idle' };
      return;
    }

    let actual: string;
    try {
      actual = await this.hashFile(path);
    } catch (err) {
      this.fail('verify', 'the downloaded file could not be read', { version, error: describeUpdateError(err) });
      return;
    }
    if (actual !== file.sha512) {
      this.fail('verify', 'the downloaded file does not match the signed release', { version, sha512: actual.slice(0, 12) });
      return;
    }
    this.verified = { version, file: path, sha512: file.sha512 };
    this.clearTimer();
    this.current = { state: 'ready', version };
    this.deps.log.info('update ready', { version, sha512: file.sha512.slice(0, 12) });
  }
}

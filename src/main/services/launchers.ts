import {
  LAUNCHER_DISPLAY_NAMES,
  LAUNCHER_IDS,
  type Account,
  type InstalledGame,
  type LauncherId,
  type LauncherInstall,
  type LauncherSession,
  type LauncherSessionState,
  type LauncherStatus,
  type RememberedAccount,
  type RestoreResult,
  type RunningGame,
  type SwitchPlan,
} from '@shared/models';
import type { AccountDirectory, AccountRef, LauncherAdapter, SwitchOptions, SwitchPreflight, SwitchResult } from '../launchers/types';
import type { AccountsService } from './accounts';
import type { Logger } from './logger';
import { isRefusal } from './refusals';
import type { LauncherSessionStore } from './sessions';

/**
 * Wraps a failure inside an adapter so it reaches the renderer as data with the launcher named.
 * Keeps the adapter's own code (NOT_INSTALLED, LAUNCHER_FILE, CONFIRM_REQUIRED, ...) when it has one.
 */
export class AdapterError extends Error {
  readonly code: string;
  constructor(
    readonly launcher: LauncherId,
    readonly operation: string,
    override readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${LAUNCHER_DISPLAY_NAMES[launcher]}: ${reason}`);
    this.name = 'AdapterError';
    const code = (cause as { code?: unknown } | null)?.code;
    this.code = typeof code === 'string' ? code : 'ADAPTER_FAILED';
  }
}

export class LauncherNotAvailableError extends Error {
  readonly code = 'NOT_IMPLEMENTED';
  constructor(launcher: LauncherId) {
    super(`The ${LAUNCHER_DISPLAY_NAMES[launcher]} adapter is not available yet`);
    this.name = 'LauncherNotAvailableError';
  }
}

/** A status pass reads the registry and the process list through child processes; past this it is worth a line in the log. */
const SLOW_STATUS_MS = 2_000;

export interface ImportResult {
  /** Accounts created or newly linked by this import. */
  accounts: Account[];
  skipped: { launcherUid: string; reason: string }[];
}

export function accountRef(account: Account): AccountRef {
  return {
    id: account.id,
    displayName: account.displayName,
    login: account.login,
    launcherUid: account.launcherUid,
    hasSecret: account.hasSecret,
  };
}

/**
 * The adapters' view of one launcher's accounts. setLauncherUid fails closed: a DuplicateAccountError
 * propagates, so nothing is ever linked or stored under an id another account already holds.
 */
export function accountDirectory(accounts: AccountsService, launcher: LauncherId): AccountDirectory {
  return {
    byLauncherUid: (uid) => {
      const a = accounts.findByLauncherUid(launcher, uid);
      return a ? accountRef(a) : null;
    },
    byId: (id) => {
      const a = accounts.get(id);
      return a && a.launcher === launcher ? accountRef(a) : null;
    },
    setLauncherUid: (id, uid) => {
      accounts.update(id, { launcherUid: uid });
    },
  };
}

/**
 * Owns the adapters and enforces spec section 8.1 rule 3: an adapter throwing never takes down the
 * app or the other adapters. Every call goes through guard(), which logs (redacted) and rethrows as
 * an AdapterError; status() turns failures into an "attention" state instead of failing the list.
 */
export class LauncherService {
  private readonly adapters = new Map<LauncherId, LauncherAdapter>();
  private inFlight = 0;
  private idleWaiters: (() => void)[] = [];
  private quitting = false;

  constructor(
    adapters: readonly LauncherAdapter[],
    private readonly accounts: AccountsService,
    private readonly log: Logger,
    private readonly sessions: LauncherSessionStore | null = null,
  ) {
    for (const a of adapters) this.adapters.set(a.id, a);
  }

  adapter(id: LauncherId): LauncherAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  implemented(): LauncherId[] {
    return LAUNCHER_IDS.filter((id) => this.adapters.has(id));
  }

  private require(id: LauncherId): LauncherAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new LauncherNotAvailableError(id);
    return adapter;
  }

  private guard<T>(id: LauncherId, operation: string, fn: () => Promise<T>): Promise<T> {
    return this.track(async () => {
      try {
        return await fn();
      } catch (err) {
        const wrapped = err instanceof AdapterError ? err : new AdapterError(id, operation, err);
        // A launcher that is not installed is the normal state on most PCs, not a failure; the scan and the status list handle it.
        if (wrapped.code === 'NOT_INSTALLED') this.log.debug('launcher not installed', { launcher: id, operation });
        else if (isRefusal(wrapped)) this.log.warn('adapter call refused', { launcher: id, operation, code: wrapped.code, message: wrapped.message });
        else this.failed('adapter call failed', { launcher: id, operation, error: err });
        throw wrapped;
      }
    });
  }

  /** Quit has begun: the database closes under any adapter call still running, so its failure is expected, not an error. */
  closing(): void {
    this.quitting = true;
  }

  isBusy(): boolean {
    return this.inFlight > 0;
  }

  /** Resolves true once no adapter call is running, false when the wait ran out first. */
  whenIdle(timeoutMs: number): Promise<boolean> {
    if (!this.isBusy()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      this.idleWaiters.push(done);
    });
  }

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const done of waiters) done();
      }
    }
  }

  private failed(message: string, meta: Record<string, unknown>): void {
    if (this.quitting) this.log.debug(`${message} after quit began`, meta);
    else this.log.error(message, meta);
  }

  async status(): Promise<LauncherStatus[]> {
    return Promise.all(LAUNCHER_IDS.map((id) => this.statusOf(id)));
  }

  private async statusOf(launcher: LauncherId): Promise<LauncherStatus> {
    const base: LauncherStatus = {
      launcher,
      displayName: LAUNCHER_DISPLAY_NAMES[launcher],
      implemented: this.adapters.has(launcher),
      install: null,
      chosenPath: null,
      running: null,
      health: null,
      attention: null,
    };
    const adapter = this.adapters.get(launcher);
    if (!adapter) return base;
    const started = Date.now();
    try {
      await this.track(async () => {
        base.chosenPath = adapter.chosenInstallDir();
        base.install = await adapter.detectInstall();
        base.running = base.install ? await adapter.isRunning() : null;
        base.health = await adapter.healthCheck({ install: base.install, running: base.running });
      });
    } catch (err) {
      this.failed('adapter status failed', { launcher, error: err });
      base.attention = { message: err instanceof Error ? err.message : String(err) };
    }
    const ms = Date.now() - started;
    if (ms > SLOW_STATUS_MS) this.log.warn('launcher status was slow', { launcher, ms });
    return base;
  }

  installFromExe(id: LauncherId, exePath: string): Promise<LauncherInstall | null> {
    return this.guard(id, 'installFromExe', async () => this.require(id).installFromExe(exePath));
  }

  installedGames(id: LauncherId): Promise<InstalledGame[]> {
    return this.guard(id, 'listInstalledGames', () => this.require(id).listInstalledGames());
  }

  /** Remembered accounts with the matching One Launch account attached, when one exists. */
  rememberedAccounts(id: LauncherId): Promise<RememberedAccount[]> {
    return this.guard(id, 'listRememberedAccounts', async () => {
      const entries = await this.require(id).listRememberedAccounts();
      return entries.map((e) => {
        const linked = (e.launcherUid ? this.accounts.findByLauncherUid(id, e.launcherUid) : null) ?? (e.login ? this.accounts.findByLogin(id, e.login) : null);
        return { ...e, linkedAccountId: linked?.id ?? null };
      });
    });
  }

  /** What identifies a remembered entry: the launcher's account id, or the login when the launcher records none. */
  static rememberedKey(entry: Pick<RememberedAccount, 'launcherUid' | 'login'>): string {
    return entry.launcherUid || entry.login;
  }

  /**
   * Creates One Launch accounts for the given remembered entries (names and IDs only; no password).
   * `keys` are rememberedKey() values. An entry that already matches an account by login gets its
   * launcher uid filled in instead.
   */
  async importAccounts(id: LauncherId, keys: readonly string[]): Promise<ImportResult> {
    const remembered = await this.rememberedAccounts(id);
    const result: ImportResult = { accounts: [], skipped: [] };
    for (const uid of new Set(keys)) {
      const entry = remembered.find((r) => LauncherService.rememberedKey(r) === uid);
      if (!entry) {
        result.skipped.push({ launcherUid: uid, reason: 'not remembered by the launcher' });
        continue;
      }
      if (!entry.login && !entry.linkedAccountId) {
        result.skipped.push({ launcherUid: uid, reason: 'the launcher does not record the login for this account' });
        continue;
      }
      if (entry.linkedAccountId) {
        const linked = this.accounts.get(entry.linkedAccountId);
        if (linked && !linked.launcherUid && entry.launcherUid) {
          result.accounts.push(this.accounts.update(linked.id, { launcherUid: entry.launcherUid }));
          this.log.info('linked remembered account to existing account', { launcher: id, accountId: linked.id });
        } else {
          result.skipped.push({ launcherUid: uid, reason: 'already in One Launch' });
        }
        continue;
      }
      const account = this.accounts.create({
        launcher: id,
        displayName: entry.personaName || entry.login,
        login: entry.login,
        launcherUid: entry.launcherUid || null,
        tags: [],
        notes: '',
      });
      this.log.info('imported remembered account', { launcher: id, accountId: account.id });
      result.accounts.push(account);
    }
    return result;
  }

  /** Dry run: the plan for switching to a stored account. Changes nothing. */
  async switchPlan(accountId: string): Promise<SwitchPlan> {
    const account = this.accounts.require(accountId);
    return this.guard(account.launcher, 'switchAccount(dryRun)', () => this.require(account.launcher).switchAccount(accountRef(account), { dryRun: true }));
  }

  preflight(account: Account, forGame?: { launcherGameId: string; name: string }): Promise<SwitchPreflight> {
    return this.guard(account.launcher, 'preflight', () => this.require(account.launcher).preflight(accountRef(account), forGame));
  }

  /**
   * The real switch. Mid-switch failures come back as `ok: false` results with the rollback state;
   * refusals before anything happens (CONFIRM_REQUIRED, SWITCH_BLOCKED, NOT_INSTALLED) throw.
   */
  switch(account: Account, opts: Omit<SwitchOptions, 'dryRun'>): Promise<SwitchResult> {
    return this.guard(account.launcher, 'switchAccount', () => this.require(account.launcher).switchAccount(accountRef(account), { ...opts, dryRun: false }));
  }

  launchGame(
    id: LauncherId,
    game: { launcherGameId: string; name: string },
    opts: { signal?: AbortSignal | undefined; startedBySwitch?: boolean } = {},
  ): Promise<{ command: string; handOff?: string }> {
    return this.guard(id, 'launchGame', () => this.require(id).launchGame(game, opts));
  }

  /** The launcher's own icon file for the game, or null for a launcher that keeps none. */
  gameIcon(id: LauncherId, game: { launcherGameId: string; name: string }): Promise<string | null> {
    return this.guard(id, 'gameIcon', async () => {
      const adapter = this.require(id);
      return adapter.gameIcon ? adapter.gameIcon(game) : null;
    });
  }

  // --- session snapshots (adapters that sign in from a remembered-session blob) -------------

  private sessionStore(): LauncherSessionStore {
    if (!this.sessions) throw new Error('Session snapshots are not available');
    return this.sessions;
  }

  /** The stored snapshot plus what the launcher's files say now. A failing state read never hides the snapshot. */
  async session(accountId: string): Promise<{ session: LauncherSession | null; state: LauncherSessionState | null; stateError: string | null }> {
    const account = this.accounts.require(accountId);
    const session = this.sessionStore().get(account.id);
    const adapter = this.adapters.get(account.launcher);
    if (!adapter?.sessionState) return { session, state: null, stateError: null };
    try {
      return { session, state: await this.guard(account.launcher, 'sessionState', () => adapter.sessionState!()), stateError: null };
    } catch (err) {
      return { session, state: null, stateError: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Stores the launcher's current remembered session for the account and links the launcher's account id. */
  async captureSession(accountId: string): Promise<{ session: LauncherSession; account: Account }> {
    const account = this.accounts.require(accountId);
    const adapter = this.require(account.launcher);
    if (!adapter.captureSession) throw new LauncherNotAvailableError(account.launcher);
    const { session } = await this.guard(account.launcher, 'captureSession', () => adapter.captureSession!(accountRef(account)));
    this.log.info('session captured', { launcher: account.launcher, accountId });
    return { session, account: this.accounts.require(accountId) };
  }

  forgetSession(accountId: string): boolean {
    const account = this.accounts.require(accountId);
    const removed = this.sessionStore().delete(account.id);
    if (removed) this.log.info('session forgotten', { launcher: account.launcher, accountId });
    return removed;
  }

  runningGame(id: LauncherId): Promise<RunningGame | null> {
    return this.guard(id, 'runningGame', () => this.require(id).runningGame());
  }

  restoreBackup(id: LauncherId, snapshotId: string): Promise<RestoreResult> {
    return this.guard(id, 'restoreBackup', () => this.require(id).restoreBackup(snapshotId));
  }
}

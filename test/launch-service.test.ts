import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HealthReport,
  InstalledGame,
  JobStep,
  LaunchJob,
  LauncherInstall,
  RestoreResult,
  RunningGame,
  SwitchPlan,
  VaultStatus,
} from '../src/shared/models';
import { migrate, openDatabase } from '../src/main/db';
import type { AccountRef, LauncherAdapter, RememberedAccountEntry, SwitchOptions, SwitchPreflight, SwitchResult } from '../src/main/launchers/types';
import { AccountsService } from '../src/main/services/accounts';
import { LaunchService } from '../src/main/services/launch';
import { LauncherService } from '../src/main/services/launchers';
import { LibraryService } from '../src/main/services/library';
import { createLogger } from '../src/main/services/logger';
import { SettingsService } from '../src/main/services/settings';
import { SwitchJournal } from '../src/main/services/switch-journal';
import type { Vault } from '../src/main/services/vault';

class FakeVault implements Vault {
  readonly backend = 'dpapi' as const;
  isAvailable(): boolean {
    return true;
  }
  status(): VaultStatus {
    return { available: true, backend: 'dpapi' };
  }
  encrypt(plaintext: string): Buffer {
    return Buffer.from(plaintext, 'utf8');
  }
  decrypt(ciphertext: Buffer): string {
    return ciphertext.toString('utf8');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GAME: InstalledGame = {
  launcher: 'steam',
  launcherGameId: '252950',
  name: 'Rocket League',
  installPath: 'D:\\Games\\rl',
  libraryPath: 'D:\\Games',
  sizeOnDiskBytes: null,
  lastPlayedAt: null,
  needsUpdate: false,
};

/** A scripted adapter: the test decides what the switch does. */
class ScriptedSteam implements LauncherAdapter {
  readonly id = 'steam' as const;
  readonly displayName = 'Steam';
  running = false;
  strategy: SwitchPlan['strategy'] = 'remembered';
  /** Mirrors the real adapter: the credentials path is executable only with a stored password. */
  executableWithSecret = false;
  /** attention: parks on a Steam Guard prompt until the caller aborts the signal. */
  switchOutcome: 'ok' | 'fail' | 'fail-unrestored' | 'throw' | 'throw-late' | 'needs-sign-in' | 'attention' = 'ok';
  /** Test hooks around the moment the real adapters report their snapshot. */
  beforeBackup: (() => void) | null = null;
  afterBackup: (() => void) | null = null;
  passwordSeen: string | null | undefined = undefined;
  /** When set, the switch waits on this promise before finishing. */
  gate: Promise<void> | null = null;
  launched: string[] = [];
  lastOpts: SwitchOptions | null = null;
  preflights = 0;
  /** How long after the switch the launcher takes a game launch, or null when at once. */
  readyInMs: number | null = null;
  /** Mirrors Riot: the switch starts the launcher with the game's own arguments and the result names the game. */
  startsWithGame = false;
  launchStartedBySwitch: boolean | null = null;

  private plan(account: AccountRef): SwitchPlan {
    return {
      launcher: 'steam',
      account: { id: account.id, displayName: account.displayName, login: account.login, launcherUid: account.launcherUid },
      strategy: this.strategy,
      current: { mostRecentLogin: null, autoLoginUser: null, running: this.running },
      steps: [],
      warnings: this.strategy === 'credentials' && !(this.executableWithSecret && account.hasSecret) ? ['No password is stored.'] : [],
      notes: [],
      executable: this.strategy === 'remembered' || (this.executableWithSecret && account.hasSecret),
      generatedAt: new Date().toISOString(),
    };
  }

  chosenInstallDir(): string | null {
    return null;
  }
  installFromExe(): LauncherInstall | null {
    return null;
  }
  async detectInstall(): Promise<LauncherInstall | null> {
    return { launcher: 'steam', installDir: 'D:\\Games\\Steam', exePath: 'D:\\Games\\Steam\\steam.exe', source: 'registry-hkcu' };
  }
  async listInstalledGames(): Promise<InstalledGame[]> {
    return [GAME];
  }
  async listRememberedAccounts(): Promise<RememberedAccountEntry[]> {
    return [];
  }
  async isRunning(): Promise<boolean> {
    return this.running;
  }
  async runningGame(): Promise<RunningGame | null> {
    return this.running ? { launcher: 'steam', launcherGameId: '440', name: 'Team Fortress 2', source: 'launcher' } : null;
  }
  async shutdown(): Promise<void> {}
  launchSignal: AbortSignal | undefined = undefined;
  async launchGame(game: { launcherGameId: string }, opts: { signal?: AbortSignal | undefined; startedBySwitch?: boolean } = {}): Promise<{ command: string }> {
    this.launchSignal = opts.signal;
    this.launchStartedBySwitch = opts.startedBySwitch ?? false;
    this.launched.push(game.launcherGameId);
    return { command: `steam://rungameid/${game.launcherGameId}` };
  }
  async restoreBackup(id: string): Promise<RestoreResult> {
    return { launcher: 'steam', id, files: [], registry: [] };
  }
  async preflight(account: AccountRef): Promise<SwitchPreflight> {
    this.preflights++;
    const game = await this.runningGame();
    return {
      plan: this.plan(account),
      launcherRunning: this.running,
      runningGame: game,
      alreadyActive: false,
      closeMessage: game ? `Steam is running ${game.name}. Switching closes Steam and the game.` : 'Steam is running. Switching closes it.',
    };
  }
  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: true }): Promise<SwitchPlan>;
  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: false }): Promise<SwitchResult>;
  switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult>;
  async switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult> {
    if (opts.dryRun) return this.plan(account);
    this.lastOpts = opts;
    this.passwordSeen = opts.getPassword ? opts.getPassword() : undefined;
    const steps: JobStep[] = [
      { id: 'close', title: 'Close Steam', status: 'running', detail: '' },
      { id: 'backup', title: 'Back up Steam files', status: 'pending', detail: '' },
    ];
    opts.onProgress?.(steps);
    if (this.gate) await this.gate;
    if (this.switchOutcome === 'throw') throw new Error('adapter exploded');
    this.beforeBackup?.();
    opts.onBackup?.('snap-1');
    steps[0]!.status = 'done';
    steps[1]!.status = 'running';
    opts.onProgress?.(steps);
    this.afterBackup?.();
    if (this.switchOutcome === 'throw-late') throw new Error('adapter exploded after the snapshot');
    if (this.switchOutcome === 'attention') {
      opts.onAttention?.({
        kind: 'sign-in',
        title: 'Steam needs a one-time sign-in on this PC',
        message: 'Enter the emailed code.',
        reason: 'Account Logon Denied',
        canCopyPassword: true,
        until: new Date(Date.now() + 60_000).toISOString(),
      });
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) resolve();
        else opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      opts.onAttention?.(null);
    }
    steps[0]!.status = 'done';
    steps[1]!.status = this.switchOutcome === 'ok' ? 'done' : 'failed';
    opts.onProgress?.(steps);
    return {
      launcher: 'steam',
      account: this.plan(account).account,
      strategy: 'remembered',
      ok: this.switchOutcome === 'ok',
      needsSignIn: this.switchOutcome === 'needs-sign-in',
      cancelled: this.switchOutcome === 'attention',
      backupId: 'snap-1',
      restored: this.switchOutcome === 'fail' ? true : this.switchOutcome === 'fail-unrestored' ? false : null,
      error:
        this.switchOutcome === 'ok'
          ? null
          : this.switchOutcome === 'needs-sign-in'
            ? 'Steam is asking you to sign in as user_3'
            : this.switchOutcome === 'attention'
              ? 'Stopped waiting for the sign-in as user_3.'
              : 'write failed',
      steps,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      readyAt: this.readyInMs === null ? null : new Date(Date.now() + this.readyInMs).toISOString(),
      startedWithGame: this.startsWithGame ? (opts.game?.launcherGameId ?? null) : null,
    };
  }
  async healthCheck(): Promise<HealthReport> {
    return { launcher: 'steam', status: 'ok', checks: [], checkedAt: new Date().toISOString() };
  }
}

function setup(opts: { dryRun?: boolean; journal?: SwitchJournal } = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  const accounts = new AccountsService(db, new FakeVault());
  const library = new LibraryService(db);
  const settings = new SettingsService(db);
  settings.set('dryRun', String(opts.dryRun ?? false));
  const steam = new ScriptedSteam();
  const log = createLogger('test:launch');
  const launchers = new LauncherService([steam], accounts, log);
  const launch = new LaunchService(db, { launchers, accounts, library, settings, log, ...(opts.journal ? { journal: opts.journal } : {}) });
  library.sync('steam', [GAME]);
  const game = library.list()[0]!;
  const account = accounts.create({ launcher: 'steam', displayName: 'Third', login: 'user_3', launcherUid: '76561198000000003' });
  return { db, accounts, library, settings, steam, launch, game, account };
}

async function waitDone(launch: LaunchService, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = launch.status(id);
    if (job.state !== 'running') return job;
    await sleep(2);
  }
  throw new Error('job never finished');
}

describe('LaunchService.preflight', () => {
  it('combines the adapter preflight with the dry-run setting and blocking reasons', async () => {
    const { launch, steam, account } = setup({ dryRun: true });
    let pf = await launch.preflight(account.id);
    expect(pf).toMatchObject({ dryRun: true, launcherRunning: false, needsConfirmation: false, blocked: null, runningGame: null });

    steam.running = true;
    pf = await launch.preflight(account.id);
    expect(pf.needsConfirmation).toBe(true);
    expect(pf.runningGame?.name).toBe('Team Fortress 2');

    steam.strategy = 'credentials';
    pf = await launch.preflight(account.id);
    expect(pf.blocked).toMatch(/No password is stored/);
  });
});

describe('LaunchService.start', () => {
  it('refuses while preview mode is on, which it is only when the user turned it on', async () => {
    const { launch, account, game, settings } = setup({ dryRun: true });
    expect(launch.dryRunEnabled()).toBe(true);
    await expect(launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).rejects.toMatchObject({ code: 'DRY_RUN' });
    settings.delete('dryRun');
    expect(launch.dryRunEnabled()).toBe(false);
    expect((await launch.preflight(account.id)).dryRun).toBe(false);
  });

  it('switches, launches, records history, and touches the account', async () => {
    const { launch, steam, account, game, accounts, db } = setup();
    const started = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    expect(started.state).toBe('running');
    expect(started.game?.name).toBe('Rocket League');

    const job = await waitDone(launch, started.id);
    expect(job.state).toBe('done');
    expect(job.error).toBeNull();
    expect(job.backupId).toBe('snap-1');
    expect(job.steps.map((s) => [s.title, s.status])).toEqual([
      ['Close Steam', 'done'],
      ['Back up Steam files', 'done'],
      ['Launch Rocket League', 'done'],
    ]);
    expect(steam.launched).toEqual(['252950']);
    expect(steam.lastOpts?.confirmClose).toBe(false);
    expect(accounts.require(account.id).lastUsedAt).not.toBeNull();
    const history = db.prepare<[], { game_id: string; account_id: string; result: string }>('SELECT game_id, account_id, result FROM launch_history').all();
    expect(history).toEqual([{ game_id: game.id, account_id: account.id, result: 'ok' }]);
  });

  it('feeds the library last-launch column and the recent list from successful launches only', async () => {
    const { launch, steam, account, game, library, accounts } = setup();
    const before = library.revision;
    await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(library.revision).toBeGreaterThan(before);
    expect(library.get(game.id)?.lastLaunch).toMatchObject({ accountId: account.id, accountName: 'Third' });
    expect(launch.recentLaunches(10)).toMatchObject([
      { gameId: game.id, gameName: 'Rocket League', accountId: account.id, accountName: 'Third', launcher: 'steam' },
    ]);

    const other = accounts.create({ launcher: 'steam', displayName: 'Fourth', login: 'user_4' });
    steam.switchOutcome = 'fail';
    await waitDone(launch, (await launch.start({ accountId: other.id, gameId: game.id, confirmClose: false })).id);
    expect(library.get(game.id)?.lastLaunch?.accountId).toBe(account.id);
    expect(launch.recentLaunches(10).map((r) => r.accountId)).toEqual([account.id]);

    steam.switchOutcome = 'ok';
    await waitDone(launch, (await launch.start({ accountId: other.id, gameId: game.id, confirmClose: false })).id);
    expect(launch.recentLaunches(10).map((r) => r.accountName)).toEqual(['Fourth', 'Third']);
    expect(launch.recentLaunches(1)).toHaveLength(1);

    accounts.delete(other.id);
    expect(launch.recentLaunches(10).map((r) => r.accountName)).toEqual(['Third']);
  });

  it('hands the switch the job’s game, and tells the launch when the switch started the launcher for it', async () => {
    const { launch, steam, account, game } = setup();
    steam.startsWithGame = true;
    let job = await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(job.state).toBe('done');
    expect(steam.lastOpts?.game).toEqual({ launcherGameId: game.launcherGameId, name: game.name });
    expect(steam.launchStartedBySwitch).toBe(true);

    steam.startsWithGame = false;
    job = await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(job.state).toBe('done');
    expect(steam.launchStartedBySwitch).toBe(false);

    job = await waitDone(launch, (await launch.start({ accountId: account.id, gameId: null, confirmClose: false })).id);
    expect(job.state).toBe('done');
    expect(steam.lastOpts?.game).toBeUndefined();
  });

  it('reuses the dialog’s preflight for the account whatever the game, since what the start reads from it does not depend on one', async () => {
    const { launch, steam, account, game } = setup();
    await launch.preflight(account.id, game.id);
    expect(steam.preflights).toBe(1);
    await waitDone(launch, (await launch.start({ accountId: account.id, gameId: null, confirmClose: false })).id);
    expect(steam.preflights).toBe(1);
    await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(steam.preflights).toBe(2);
  });

  it('waits for the readiness time the adapter named before launching, and not at all when no game follows', async () => {
    const { launch, steam, account, game } = setup();
    steam.readyInMs = 120;
    let started = Date.now();
    const job = await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(job.state).toBe('done');
    expect(steam.launched).toEqual(['252950']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);

    started = Date.now();
    expect((await waitDone(launch, (await launch.start({ accountId: account.id, gameId: null, confirmClose: false })).id)).state).toBe('done');
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('a cancel during the readiness wait skips the launch and keeps the switch', async () => {
    const { launch, steam, account, game } = setup();
    steam.readyInMs = 2_000;
    const started = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    for (let i = 0; i < 100 && launch.status(started.id).steps.at(-1)?.status !== 'running'; i++) await sleep(2);
    expect(launch.status(started.id).steps.at(-1)).toMatchObject({ id: 'launch', status: 'running' });
    launch.cancel(started.id);
    const job = await waitDone(launch, started.id);
    expect(job).toMatchObject({ state: 'cancelled', switched: true, error: 'Stopped before launching Rocket League.' });
    expect(steam.launched).toEqual([]);
  });

  it('switches without a game when gameId is null', async () => {
    const { launch, steam, account, db } = setup();
    const job = await waitDone(launch, (await launch.start({ accountId: account.id, gameId: null, confirmClose: false })).id);
    expect(job.state).toBe('done');
    expect(job.game).toBeNull();
    expect(job.steps.map((s) => s.title)).toEqual(['Close Steam', 'Back up Steam files']);
    expect(steam.launched).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM launch_history').get()).toEqual({ n: 0 });
  });

  it('requires confirmation when Steam is running, then passes it through', async () => {
    const { launch, steam, account, game } = setup();
    steam.running = true;
    const err = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONFIRM_REQUIRED', message: 'Steam: Steam is running Team Fortress 2. Switching closes Steam and the game.' });

    const job = await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: true })).id);
    expect(job.state).toBe('done');
    expect(steam.lastOpts?.confirmClose).toBe(true);
  });

  it('reuses the preflight the dialog took moments ago, once, and takes its own when none is fresh', async () => {
    const { launch, steam, account, game, accounts } = setup();
    await launch.preflight(account.id);
    await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(steam.preflights).toBe(1);

    await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(steam.preflights).toBe(2);

    const other = accounts.create({ launcher: 'steam', displayName: 'Fourth', login: 'user_4' });
    await launch.preflight(other.id);
    await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(steam.preflights).toBe(4);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await launch.preflight(account.id);
      vi.setSystemTime(Date.now() + 11_000);
      await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
      expect(steam.preflights).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh preflight that found Steam running makes the start ask for confirmation without looking again', async () => {
    const { launch, steam, account, game } = setup();
    steam.running = true;
    expect((await launch.preflight(account.id)).needsConfirmation).toBe(true);
    await expect(launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(steam.preflights).toBe(1);
    expect(launch.isBusy()).toBe(false);
  });

  it('reports a failed switch with its rollback state and skips the launch', async () => {
    const { launch, steam, account, game, db } = setup();
    steam.switchOutcome = 'fail';
    const job = await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(job.state).toBe('failed');
    expect(job.error).toBe('write failed');
    expect(job.restored).toBe(true);
    expect(job.steps.map((s) => s.status)).toEqual(['done', 'failed', 'skipped']);
    expect(steam.launched).toEqual([]);
    expect(db.prepare<[], { result: string }>('SELECT result FROM launch_history').all()).toEqual([{ result: 'failed' }]);
  });

  it('ends in needs-sign-in when Steam wants credentials and nothing can supply them', async () => {
    const { launch, steam, account, game } = setup();
    steam.switchOutcome = 'needs-sign-in';
    const job = await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(job.state).toBe('needs-sign-in');
    expect(job.error).toMatch(/asking you to sign in/);
    expect(job.restored).toBeNull();
    expect(steam.launched).toEqual([]);
  });

  it('exposes the adapter attention state while parked on a sign-in, and cancel ends it without rollback', async () => {
    const { launch, steam, account, game, db } = setup();
    steam.switchOutcome = 'attention';
    const started = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    let parked = launch.status(started.id);
    for (let i = 0; i < 100 && !parked.attention; i++) {
      await sleep(2);
      parked = launch.status(started.id);
    }
    expect(parked.state).toBe('running');
    expect(parked.attention).toMatchObject({ kind: 'sign-in', reason: 'Account Logon Denied', canCopyPassword: true });

    const cancelled = launch.cancel(started.id);
    expect(cancelled.state).toBe('running');
    const job = await waitDone(launch, started.id);
    expect(job.state).toBe('cancelled');
    expect(job.attention).toBeNull();
    expect(job.restored).toBeNull();
    expect(job.error).toMatch(/Stopped waiting/);
    expect(job.steps.at(-1)).toMatchObject({ title: 'Launch Rocket League', status: 'skipped' });
    expect(steam.launched).toEqual([]);
    expect(db.prepare<[], { result: string }>('SELECT result FROM launch_history').all()).toEqual([{ result: 'cancelled' }]);
    // Cancelling a finished job is a harmless no-op.
    expect(launch.cancel(started.id).state).toBe('cancelled');
  });

  it('hands the adapter a password getter that decrypts on demand', async () => {
    const { launch, steam, accounts, game } = setup();
    const withPassword = accounts.create({ launcher: 'steam', displayName: 'Alt', login: 'user_4', password: 'hunter2', launcherUid: '76561198000000004' });
    await waitDone(launch, (await launch.start({ accountId: withPassword.id, gameId: game.id, confirmClose: false })).id);
    expect(steam.passwordSeen).toBe('hunter2');
  });

  it('allows the credentials path when a password is stored and blocks it otherwise', async () => {
    const { launch, steam, accounts, account } = setup();
    steam.strategy = 'credentials';
    expect((await launch.preflight(account.id)).blocked).toMatch(/No password is stored/);
    const withPassword = accounts.create({ launcher: 'steam', displayName: 'Alt', login: 'user_4', password: 'hunter2' });
    steam.executableWithSecret = true;
    expect((await launch.preflight(withPassword.id)).blocked).toBeNull();
  });

  it('turns an adapter exception into a failed job instead of an unhandled rejection', async () => {
    const { launch, steam, account, game } = setup();
    steam.switchOutcome = 'throw';
    const job = await waitDone(launch, (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id);
    expect(job.state).toBe('failed');
    expect(job.error).toBe('Steam: adapter exploded');
    expect(job.steps.at(-1)).toMatchObject({ title: 'Launch Rocket League', status: 'skipped' });
  });

  it('runs one job at a time and keeps finished jobs queryable', async () => {
    const { launch, steam, account, game } = setup();
    let release!: () => void;
    steam.gate = new Promise<void>((r) => (release = r));
    const first = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    await expect(launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).rejects.toMatchObject({ code: 'BUSY' });
    expect(launch.status(first.id).steps[0]).toMatchObject({ title: 'Close Steam', status: 'running' });
    release();
    steam.gate = null;
    expect((await waitDone(launch, first.id)).state).toBe('done');
    const second = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    await waitDone(launch, second.id);
    expect(launch.status(first.id).state).toBe('done');
    expect(() => launch.status('nope')).toThrow(/No launch job/);
  });

  it('reserves the job slot before awaiting the preflight, so two starts cannot both run', async () => {
    const { launch, steam, account, game } = setup();
    let release!: () => void;
    steam.gate = new Promise<void>((r) => (release = r));
    const [first, second] = await Promise.allSettled([
      launch.start({ accountId: account.id, gameId: game.id, confirmClose: false }),
      launch.start({ accountId: account.id, gameId: game.id, confirmClose: false }),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'BUSY' } });
    expect(launch.isBusy()).toBe(true);
    release();
    steam.gate = null;
    expect((await waitDone(launch, (first as PromiseFulfilledResult<LaunchJob>).value.id)).state).toBe('done');
    expect(launch.isBusy()).toBe(false);

    steam.running = true;
    await expect(launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(launch.isBusy()).toBe(false);
    await expect(launch.whenIdle(10)).resolves.toBe(true);
  });

  it('rejects a game from a different launcher and unknown ids', async () => {
    const { launch, accounts, game } = setup();
    const epic = accounts.create({ launcher: 'epic', displayName: 'E', login: 'e@example.com' });
    await expect(launch.start({ accountId: epic.id, gameId: game.id, confirmClose: false })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(launch.start({ accountId: 'missing', gameId: game.id, confirmClose: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(launch.start({ accountId: epic.id, gameId: 'missing', confirmClose: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('LaunchService.isBusy / whenIdle', () => {
  it('is idle before and after a job, busy while one runs, and whenIdle honours its timeout', async () => {
    const { launch, steam, game, account } = setup();
    expect(launch.isBusy()).toBe(false);
    expect(launch.currentJob()).toBeNull();
    await expect(launch.whenIdle(10)).resolves.toBe(true);

    let release!: () => void;
    steam.gate = new Promise<void>((r) => (release = r));
    const job = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    expect(launch.isBusy()).toBe(true);
    expect(launch.currentJob()?.id).toBe(job.id);
    await expect(launch.whenIdle(20)).resolves.toBe(false);

    const idle = launch.whenIdle(2_000);
    release();
    await expect(idle).resolves.toBe(true);
    expect(launch.isBusy()).toBe(false);
    expect(launch.currentJob()).toBeNull();
    expect(launch.status(job.id).state).toBe('done');
  });

  it('an abort that lands once the switch has succeeded skips the game launch and says so', async () => {
    const { db, launch, steam, accounts, game, account } = setup();
    let release!: () => void;
    steam.gate = new Promise<void>((r) => (release = r));
    const job = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    launch.cancel(job.id);
    release();
    const done = await waitDone(launch, job.id);
    expect(done).toMatchObject({ state: 'cancelled', switched: true, restored: null, error: 'Stopped before launching Rocket League.' });
    expect(done.steps.at(-1)).toMatchObject({ id: 'launch', status: 'skipped' });
    expect(steam.launched).toEqual([]);
    expect(accounts.require(account.id).lastUsedAt).not.toBeNull();
    expect(db.prepare('SELECT result FROM launch_history').all()).toEqual([{ result: 'cancelled' }]);
  });

  it('hands the launch the same abort signal as the switch', async () => {
    const { launch, steam, game, account } = setup();
    const job = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    await waitDone(launch, job.id);
    expect(steam.launchSignal).toBe(steam.lastOpts?.signal);
    expect(steam.launchSignal?.aborted).toBe(false);
  });

  it('stop() aborts the running job and refuses new ones, including a start that is still in its preflight', async () => {
    const { launch, steam, game, account } = setup();
    steam.switchOutcome = 'attention';
    const job = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    await sleep(5);
    launch.stop();
    await expect(launch.whenIdle(2_000)).resolves.toBe(true);
    expect(launch.status(job.id).state).toBe('cancelled');
    await expect(launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).rejects.toMatchObject({ code: 'BUSY' });

    const other = setup();
    const starting = other.launch.start({ accountId: other.account.id, gameId: other.game.id, confirmClose: false });
    other.launch.stop();
    await expect(starting).rejects.toMatchObject({ code: 'BUSY' });
    expect(other.steam.lastOpts).toBeNull();
    await expect(other.launch.whenIdle(10)).resolves.toBe(true);
  });

  it('cancel followed by whenIdle lets a parked sign-in wait end before quitting', async () => {
    const { launch, steam, game, account } = setup();
    steam.switchOutcome = 'attention';
    const job = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    await sleep(5);
    expect(launch.isBusy()).toBe(true);
    launch.cancel(job.id);
    await expect(launch.whenIdle(2_000)).resolves.toBe(true);
    expect(launch.status(job.id).state).toBe('cancelled');
  });
});

describe('LaunchService and the switch journal', () => {
  let dir: string;
  let file: string;
  const onDisk = (): Record<string, unknown> | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onelaunch-launch-journal-'));
    file = join(dir, 'switch.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const withJournal = () => setup({ journal: new SwitchJournal(file, createLogger('test:journal')) });

  it('is on disk before the adapter is called, names the snapshot before the first write, and is gone before the game launches', async () => {
    const { launch, steam, game, account } = withJournal();
    const seen: (Record<string, unknown> | null)[] = [];
    steam.beforeBackup = () => seen.push(onDisk());
    steam.afterBackup = () => seen.push(onDisk());
    const launchGame = steam.launchGame.bind(steam);
    steam.launchGame = async (g, o) => {
      seen.push(onDisk());
      return launchGame(g, o);
    };
    const job = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    expect((await waitDone(launch, job.id)).state).toBe('done');

    expect(seen[0]).toMatchObject({ jobId: job.id, launcher: 'steam', accountId: account.id, backupId: null, stepId: 'close' });
    expect(seen[1]).toMatchObject({ jobId: job.id, backupId: 'snap-1', stepId: 'backup', rollbackFailed: false });
    expect(seen[2]).toBeNull();
    expect(onDisk()).toBeNull();
  });

  it('shows the snapshot on the job as soon as it exists', async () => {
    const { launch, steam, game, account } = withJournal();
    let mid: string | null | undefined;
    let jobId = '';
    steam.afterBackup = () => (mid = launch.status(jobId).backupId);
    let release!: () => void;
    steam.gate = new Promise<void>((r) => (release = r));
    jobId = (await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false })).id;
    release();
    await waitDone(launch, jobId);
    expect(mid).toBe('snap-1');
  });

  it('is removed when the switch fails and rolls back, is cancelled, or ends waiting for a sign-in', async () => {
    for (const outcome of ['fail', 'needs-sign-in', 'attention'] as const) {
      const { launch, steam, game, account } = withJournal();
      steam.switchOutcome = outcome;
      const job = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
      if (outcome === 'attention') {
        await sleep(5);
        expect(onDisk()).toMatchObject({ jobId: job.id, backupId: 'snap-1' });
        launch.cancel(job.id);
      }
      await waitDone(launch, job.id);
      expect(onDisk(), outcome).toBeNull();
    }
  });

  it('is removed when the adapter refuses before touching anything, and kept when it throws after the snapshot', async () => {
    const early = withJournal();
    early.steam.switchOutcome = 'throw';
    const refused = await early.launch.start({ accountId: early.account.id, gameId: early.game.id, confirmClose: false });
    expect((await waitDone(early.launch, refused.id)).state).toBe('failed');
    expect(onDisk()).toBeNull();

    const late = withJournal();
    late.steam.switchOutcome = 'throw-late';
    const job = await late.launch.start({ accountId: late.account.id, gameId: late.game.id, confirmClose: false });
    expect((await waitDone(late.launch, job.id)).state).toBe('failed');
    expect(onDisk()).toMatchObject({ jobId: job.id, backupId: 'snap-1', rollbackFailed: false });
  });

  it('stays, marked, when the rollback failed, so the next start offers the snapshot again', async () => {
    const { launch, steam, game, account } = withJournal();
    steam.switchOutcome = 'fail-unrestored';
    const job = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    expect(await waitDone(launch, job.id)).toMatchObject({ state: 'failed', restored: false });
    expect(onDisk()).toMatchObject({ jobId: job.id, backupId: 'snap-1', rollbackFailed: true });
  });

  it('a journal that cannot be written does not fail the job', async () => {
    const { launch, game, account } = setup({ journal: new SwitchJournal(join(dir, 'no-such-folder', 'switch.json'), createLogger('test:journal')) });
    const job = await launch.start({ accountId: account.id, gameId: game.id, confirmClose: false });
    expect((await waitDone(launch, job.id)).state).toBe('done');
  });
});

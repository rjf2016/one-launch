import { randomUUID } from 'node:crypto';
import {
  isLauncherId,
  type Account,
  type Game,
  type JobStep,
  type LaunchJob,
  type LaunchPreflight,
  type LaunchResult,
  type RecentLaunch,
} from '@shared/models';
import type { Db } from '../db';
import { ConfirmationRequiredError, type SwitchPreflight } from '../launchers/types';
import { sleep } from '../launchers/wait';
import type { AccountsService } from './accounts';
import { AdapterError, type LauncherService } from './launchers';
import type { LibraryService } from './library';
import type { Logger } from './logger';
import { isRefusal, refusalCode } from './refusals';
import type { SettingsService } from './settings';
import type { SwitchJournal } from './switch-journal';

export class LaunchBusyError extends Error {
  readonly code = 'BUSY';
  constructor() {
    super('Another switch or launch is still running');
    this.name = 'LaunchBusyError';
  }
}

export class DryRunEnabledError extends Error {
  readonly code = 'DRY_RUN';
  constructor() {
    super('Preview mode is on. Turn it off in Settings, or from the preview, to switch accounts for real.');
    this.name = 'DryRunEnabledError';
  }
}

export class JobNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(id: string) {
    super(`No launch job ${id}`);
    this.name = 'JobNotFoundError';
  }
}

export class LaunchMismatchError extends Error {
  readonly code = 'BAD_REQUEST';
  constructor(message: string) {
    super(message);
    this.name = 'LaunchMismatchError';
  }
}

export interface StartLaunchInput {
  accountId: string;
  /** Null switches without launching anything. */
  gameId: string | null;
  /** The user has confirmed the launcher (and any running game) may be closed. */
  confirmClose: boolean;
}

const HISTORY_LIMIT = 20;

/** A preflight the dialog took this recently answers the start that follows it; an older one is taken again. */
const PREFLIGHT_REUSE_MS = 10_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Orchestrates switch → launch (spec section 5, "launch" service). One job at a time. The renderer
 * starts a job and polls status(); every adapter step change is mirrored into the job so the UI can
 * show "Closing Steam… Switching account… Starting Steam… Launching game…".
 */
export class LaunchService {
  private current: LaunchJob | null = null;
  // Reserved before start() awaits the preflight, so two calls cannot both pass the busy check.
  private starting = false;
  private closing = false;
  private controller: AbortController | null = null;
  private lastPreflight: { accountId: string; at: number; pf: SwitchPreflight } | null = null;
  private readonly recent: LaunchJob[] = [];
  private idleWaiters: (() => void)[] = [];
  private readonly insertHistory;
  private readonly recentStmt;

  constructor(
    db: Db,
    private readonly deps: {
      launchers: LauncherService;
      accounts: AccountsService;
      library: LibraryService;
      settings: SettingsService;
      log: Logger;
      journal?: SwitchJournal;
    },
  ) {
    this.insertHistory = db.prepare<[string, string, string, string, string]>(
      'INSERT INTO launch_history (id, game_id, account_id, launched_at, result) VALUES (?, ?, ?, ?, ?)',
    );
    this.recentStmt = db.prepare<
      [number],
      { game_id: string; game_name: string; launcher: string; account_id: string; account_name: string; launched_at: string }
    >(
      `SELECT h.game_id, g.name AS game_name, g.launcher, h.account_id, a.display_name AS account_name, MAX(h.launched_at) AS launched_at
       FROM launch_history h
       JOIN games g ON g.id = h.game_id AND g.installed = 1
       JOIN accounts a ON a.id = h.account_id
       WHERE h.result = 'ok'
       GROUP BY h.game_id, h.account_id
       ORDER BY launched_at DESC
       LIMIT ?`,
    );
  }

  /** Game + account pairs launched successfully before, newest first. Pairs whose game or account is gone are left out. */
  recentLaunches(limit: number): RecentLaunch[] {
    const out: RecentLaunch[] = [];
    for (const r of this.recentStmt.all(limit)) {
      if (!isLauncherId(r.launcher)) continue;
      out.push({
        gameId: r.game_id,
        gameName: r.game_name,
        launcher: r.launcher,
        accountId: r.account_id,
        accountName: r.account_name,
        launchedAt: r.launched_at,
      });
    }
    return out;
  }

  dryRunEnabled(): boolean {
    return this.deps.settings.getBool('dryRun', false);
  }

  /** Everything the UI needs before asking the user to confirm. Read-only. */
  async preflight(accountId: string, gameId: string | null = null): Promise<LaunchPreflight> {
    const account = this.deps.accounts.require(accountId);
    const game = this.gameFor(account, gameId);
    const pf = await this.deps.launchers.preflight(account, game ?? undefined);
    this.lastPreflight = { accountId, at: Date.now(), pf };
    // A credentials-path switch (account Steam has never remembered, or an expired session) is fine
    // as long as a password is stored; the plan's executable flag already encodes that.
    const blocked = pf.plan.executable ? null : (pf.plan.warnings[0] ?? 'This switch cannot run.');
    return {
      plan: pf.plan,
      dryRun: this.dryRunEnabled(),
      launcherRunning: pf.launcherRunning,
      runningGame: pf.runningGame,
      alreadyActive: pf.alreadyActive,
      needsConfirmation: pf.launcherRunning && !pf.alreadyActive,
      closeMessage: pf.launcherRunning && !pf.alreadyActive ? pf.closeMessage : null,
      blocked,
    };
  }

  /**
   * Starts a switch (and launch) job and returns immediately. Refuses while dry run is on, while
   * another job runs, and when the switch would close the launcher without confirmation.
   */
  async start(input: StartLaunchInput): Promise<LaunchJob> {
    if (this.isBusy() || this.closing) throw new LaunchBusyError();
    if (this.dryRunEnabled()) throw new DryRunEnabledError();
    this.starting = true;
    try {
      const account = this.deps.accounts.require(input.accountId);
      const game = this.gameFor(account, input.gameId);

      if (!input.confirmClose) {
        const pf = await this.freshPreflight(account, game);
        if (pf.launcherRunning && !pf.alreadyActive) {
          throw new AdapterError(account.launcher, 'start', new ConfirmationRequiredError(pf.closeMessage, pf.runningGame));
        }
        if (this.closing) throw new LaunchBusyError();
      }

      const launchStep: JobStep | null = game ? { id: 'launch', title: `Launch ${game.name}`, status: 'pending', detail: '' } : null;
      const job: LaunchJob = {
        id: randomUUID(),
        state: 'running',
        launcher: account.launcher,
        account: { id: account.id, displayName: account.displayName, login: account.login },
        game: game ? { id: game.id, name: game.name, launcherGameId: game.launcherGameId } : null,
        steps: launchStep ? [launchStep] : [],
        attention: null,
        switched: false,
        handOff: null,
        backupId: null,
        restored: null,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      this.current = job;
      this.controller = new AbortController();
      this.deps.log.info('launch job started', { jobId: job.id, accountId: account.id, gameId: game?.id ?? null });
      void this.run(job, account, game, input.confirmClose, this.controller.signal);
      return this.snapshot(job);
    } finally {
      this.starting = false;
      if (!this.isBusy()) this.notifyIdle();
    }
  }

  /** The game of a job, or null for a plain switch. A game of another launcher than the account's is a mismatch. */
  private gameFor(account: Account, gameId: string | null): Game | null {
    const game: Game | null = gameId ? this.deps.library.require(gameId) : null;
    if (game && game.launcher !== account.launcher) {
      throw new LaunchMismatchError(`${game.name} is a ${game.launcher} game; pick a ${game.launcher} account`);
    }
    return game;
  }

  /** The dialog's own preflight when it is for this account and fresh, else a new one; what the start reads from it does not depend on the game. Each preflight answers one start. */
  private async freshPreflight(account: Account, game: Game | null): Promise<SwitchPreflight> {
    const last = this.lastPreflight;
    this.lastPreflight = null;
    if (last && last.accountId === account.id && Date.now() - last.at <= PREFLIGHT_REUSE_MS) return last.pf;
    return this.deps.launchers.preflight(account, game ?? undefined);
  }

  /** A switch or launch is in progress, or is being started. Quitting now would leave the launcher half-switched. */
  isBusy(): boolean {
    return this.starting || this.current?.state === 'running';
  }

  /** The running job, if any. */
  currentJob(): LaunchJob | null {
    return this.current && this.current.state === 'running' ? this.snapshot(this.current) : null;
  }

  /** Resolves true once no job is running, or false when `timeoutMs` passes first. */
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

  /** Aborts a running job: whatever wait it is in ends, and the adapter decides what is put back. Finished jobs are returned unchanged. */
  cancel(jobId: string): LaunchJob {
    const job = this.status(jobId);
    if (this.current?.id === jobId && job.state === 'running' && this.controller) {
      this.deps.log.info('launch job cancel requested', { jobId });
      this.controller.abort();
    }
    return job;
  }

  /** For quit: refuses new jobs from now on and aborts the running one. whenIdle() then says when it has wound down. */
  stop(): void {
    this.closing = true;
    if (this.controller) {
      this.deps.log.info('launch service stopping; aborting the running job', { jobId: this.current?.id });
      this.controller.abort();
    }
  }

  private async run(job: LaunchJob, account: Account, game: Game | null, confirmClose: boolean, signal: AbortSignal): Promise<void> {
    const launchStep: JobStep | null = game ? { id: 'launch', title: `Launch ${game.name}`, status: 'pending', detail: '' } : null;
    const startedMs = Date.now();
    const stepStarts = new Map<string, number>();
    /** Logs how long each step ran, from the moment it was reported running to the moment it was not. */
    const timeSteps = (): void => {
      for (const s of job.steps) {
        const since = stepStarts.get(s.id);
        if (s.status === 'running') {
          if (since === undefined) stepStarts.set(s.id, Date.now());
        } else if (since !== undefined) {
          stepStarts.delete(s.id);
          this.deps.log.info('launch step finished', { jobId: job.id, step: s.id, status: s.status, ms: Date.now() - since });
        }
      }
    };
    const setSteps = (switchSteps: readonly JobStep[]): void => {
      job.steps = launchStep ? [...switchSteps, launchStep] : [...switchSteps];
      timeSteps();
    };
    let result: LaunchResult = 'failed';
    const journal = this.deps.journal;
    try {
      journal?.begin({ jobId: job.id, launcher: account.launcher, accountId: account.id });
      const switched = await this.deps.launchers
        .switch(account, {
          confirmClose,
          signal,
          ...(game ? { game: { launcherGameId: game.launcherGameId, name: game.name } } : {}),
          onProgress: (steps) => {
            setSteps(steps);
            const running = steps.find((s) => s.status === 'running');
            if (running) journal?.update({ stepId: running.id });
          },
          // On disk before the adapter's first write, so a crash from here on can name the snapshot to restore.
          onBackup: (backupId) => {
            job.backupId = backupId;
            journal?.update({ backupId });
          },
          onAttention: (attention) => {
            job.attention = attention;
          },
          // Decrypted only if the adapter actually needs it (credentials path or expired-session fallback).
          getPassword: () => this.deps.accounts.decryptPassword(account.id),
        })
        .catch((err: unknown) => {
          // Adapters throw for refusals before anything is touched. A throw after the snapshot is unexpected, so the journal stays for the next start.
          if (job.backupId === null) journal?.clear(job.id);
          throw err;
        });
      // The switch has settled, so the journal goes before the game launch. A failed rollback keeps it: the next start offers the snapshot again.
      if (switched.restored === false) journal?.update({ rollbackFailed: true });
      else journal?.clear(job.id);
      setSteps(switched.steps);
      job.attention = null;
      job.backupId = switched.backupId;
      job.restored = switched.restored;
      if (!switched.ok) {
        job.error = switched.error ?? 'The switch failed';
        if (launchStep) launchStep.status = 'skipped';
        job.state = switched.cancelled ? 'cancelled' : switched.needsSignIn ? 'needs-sign-in' : 'failed';
        if (switched.cancelled) result = 'cancelled';
        return;
      }
      job.switched = true;
      if (game && launchStep && !signal.aborted) {
        const readyIn = switched.readyAt ? Date.parse(switched.readyAt) - Date.now() : 0;
        if (readyIn > 0) {
          launchStep.status = 'running';
          timeSteps();
          await sleep(readyIn, signal);
        }
      }
      if (game && launchStep && signal.aborted) {
        launchStep.status = 'skipped';
        job.error = `Stopped before launching ${game.name}.`;
        job.state = 'cancelled';
        result = 'cancelled';
        this.deps.accounts.touchLastUsed(account.id);
        return;
      }
      if (game && launchStep) {
        launchStep.status = 'running';
        timeSteps();
        const { command, handOff } = await this.deps.launchers.launchGame(account.launcher, game, {
          signal,
          startedBySwitch: switched.startedWithGame === game.launcherGameId,
        });
        launchStep.status = 'done';
        launchStep.detail = `Sent ${command}`;
        job.handOff = handOff ?? null;
      }
      this.deps.accounts.touchLastUsed(account.id);
      result = 'ok';
      job.state = 'done';
    } catch (err) {
      job.attention = null;
      job.error = errorText(err);
      if (launchStep && launchStep.status === 'running') launchStep.status = 'failed';
      else if (launchStep) launchStep.status = 'skipped';
      job.state = 'failed';
      if (isRefusal(err)) this.deps.log.warn('launch job refused', { jobId: job.id, code: refusalCode(err), error: err });
      else this.deps.log.error('launch job failed', { jobId: job.id, error: err });
    } finally {
      job.finishedAt = new Date().toISOString();
      timeSteps();
      this.controller = null;
      if (game) this.record(game.id, account.id, result);
      this.recent.unshift(job);
      if (this.recent.length > HISTORY_LIMIT) this.recent.length = HISTORY_LIMIT;
      this.deps.log.info('launch job finished', { jobId: job.id, state: job.state, restored: job.restored, ms: Date.now() - startedMs });
      this.notifyIdle();
    }
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  status(jobId: string): LaunchJob {
    const job = this.current?.id === jobId ? this.current : this.recent.find((j) => j.id === jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return this.snapshot(job);
  }

  private snapshot(job: LaunchJob): LaunchJob {
    return {
      ...job,
      steps: job.steps.map((s) => ({ ...s })),
      account: { ...job.account },
      game: job.game ? { ...job.game } : null,
      attention: job.attention ? { ...job.attention } : null,
    };
  }

  private record(gameId: string, accountId: string, result: LaunchResult): void {
    try {
      this.insertHistory.run(randomUUID(), gameId, accountId, new Date().toISOString(), result);
      this.deps.library.bump();
    } catch (err) {
      this.deps.log.warn('could not record launch history', { error: err });
    }
  }
}

/**
 * Steam adapter (findings in docs/adapters/steam.md).
 *
 * Reads: detectInstall, listInstalledGames, listRememberedAccounts, isRunning, runningGame,
 * healthCheck, preflight, switchAccount({ dryRun: true }).
 * Writes (Phase 2 step 3): switchAccount({ dryRun: false }) for remembered accounts, restoreBackup,
 * shutdown, launchGame. Every write is preceded by a backup snapshot and undone from it on failure.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type {
  HealthCheck,
  HealthReport,
  HealthStatus,
  InstalledGame,
  JobStep,
  JobStepStatus,
  LaunchAttention,
  LauncherInstall,
  RestoreResult,
  RunningGame,
  SwitchPlan,
  SwitchPlanStep,
} from '@shared/models';
import { normalizeLauncherPath, pathKey } from '../../platform/fs-path';
import type { ProcessController } from '../../platform/processes';
import type { Registry } from '../../platform/registry';
import { writeFileAtomic, type BackupService } from '../../services/backup';
import type { Logger } from '../../services/logger';
import { isRefusal, refusalCode } from '../../services/refusals';
import {
  ConfirmationRequiredError,
  LauncherFileError,
  LauncherNotInstalledError,
  LauncherRunningError,
  SwitchBlockedError,
  type AccountRef,
  type KnownLauncherState,
  type LauncherAdapter,
  type RememberedAccountEntry,
  type SwitchOptions,
  type SwitchPreflight,
  type SwitchResult,
  withoutCloseWarning,
} from '../types';
import { chosenFolder, chosenFolderCheck, isNamed } from '../chosen-folder';
import { MAX_VDF_BYTES, readLauncherText } from '../read-file';
import { gameWithRunningProcess } from '../running-game';
import { mergeTiming, sleep, SwitchAbortedError, waitUntil } from '../wait';
import { bootstrapLogMark, bootstrapLogPath, updatingSince } from './bootstrap-log';
import { loginLogMark, loginLogPath, outcomeSince, type SignInCause } from './login-log';
import { findLoginUser, parseLoginUsers, planAutoLoginRewrite, type SteamLoginUser } from './loginusers';
import { APP_MANIFEST_FILE, isFullyInstalled, needsUpdate, parseAppManifest, parseLibraryFolders } from './manifests';

export const STEAM_HKCU_KEY = 'Software\\Valve\\Steam';
export const STEAM_HKLM_KEY = 'SOFTWARE\\WOW6432Node\\Valve\\Steam';
export const STEAM_EXE = 'steam.exe';
export const DEFAULT_STEAM_DIR = 'C:\\Program Files (x86)\\Steam';

/** Apps Steam installs alongside games that are not games themselves. Verified on the user's library. */
export const STEAM_TOOL_APPIDS: ReadonlySet<string> = new Set([
  '228980', // Steamworks Common Redistributables
  '1070560', // Steam Linux Runtime
  '1391110', // Steam Linux Runtime - Soldier
  '1628350', // Steam Linux Runtime - Sniper
]);

/** Plan step ids. The real switch reports progress against these. */
export const STEP = {
  close: 'close',
  backup: 'backup',
  file: 'file',
  registryUser: 'registry-user',
  registryRemember: 'registry-remember',
  start: 'start',
  wait: 'wait',
  verify: 'verify',
  login: 'login',
  manual: 'manual',
} as const;

const DEFAULT_TIMING = {
  pollMs: 500,
  /** The waits that read a log or the registry, not the process list: each poll is cheap, so they look more often. */
  logPollMs: 250,
  shutdownMs: 30_000,
  killGraceMs: 5_000,
  startupMs: 60_000,
  /** Ceiling for a remembered session to sign itself in when Steam's log says nothing. */
  signInMs: 60_000,
  /** Ceiling for a -login sign-in when Steam's log says nothing. */
  guardMs: 120_000,
  /** Ceiling for the whole automatic wait while Steam is updating itself; the sign-in budget starts over when the update ends. */
  updateMs: 900_000,
  /** How long the user gets to finish a sign-in by hand (Steam Guard code, expired session). */
  manualSignInMs: 600_000,
  /** ActiveUser can name the account before Steam has loaded its library; how long to wait for the login log's Success line before the launch link. */
  readyGraceMs: 5_000,
};

/**
 * A remembered session older than this is flagged as "may have expired". Steam does not document
 * token lifetime; the user's itsgramps session (13 months old) was rejected with "License expired"
 * on 2026-09-11. Only loginusers.vdf timestamps are consulted; the token store is never read.
 */
export const STALE_SESSION_DAYS = 60;

const STEAMID64_BASE = 76561197960265728n;

/** SteamID3 account id, which is what HKCU\...\ActiveProcess\ActiveUser holds. */
export function steamId3(steamId64: string): number {
  return Number(BigInt(steamId64) - STEAMID64_BASE);
}

function sessionAgeDays(timestamp: number | null, now = Date.now()): number | null {
  return timestamp ? Math.floor((now / 1000 - timestamp) / 86_400) : null;
}

export interface SteamAdapterDeps {
  registry: Registry;
  processes: ProcessController;
  backups: BackupService;
  log: Logger;
  backupsToKeep: () => number;
  /** The steam.autoLogin setting: put the stored password on the -login command line instead of handing over to the user. Off when absent. */
  autoLogin?: () => boolean;
  /** shell.openExternal in the app; a recorder in tests. */
  openExternal: (url: string) => Promise<void>;
  /** The steam.path setting: the folder the user chose with Locate, tried before the registry. */
  installDir?: () => string | null;
  /** Last-resort install location. Overridable for tests. */
  defaultInstallDir?: string;
  timing?: Partial<typeof DEFAULT_TIMING>;
}

const SOURCE_LABEL: Record<LauncherInstall['source'], string> = {
  user: 'the folder chosen in Settings',
  'registry-hkcu': `HKCU\\${STEAM_HKCU_KEY}\\SteamPath`,
  'registry-hklm': `HKLM\\${STEAM_HKLM_KEY}\\InstallPath`,
  'launcher-file': 'a launcher file',
  'default-path': 'default location',
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function worst(checks: readonly HealthCheck[]): HealthStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What buildSwitchPlan learned, kept for the real switch so it does not re-derive anything. */
interface PlanContext {
  install: LauncherInstall;
  loginUsersPath: string;
  target: SteamLoginUser | null;
  alreadyActive: boolean;
  /** The remembered session is old enough that Steam may reject it. */
  stale: boolean;
  autoLoginUser: string | null;
  rememberDword: number | null;
  /** The plan's warning that the running Steam will be closed; preflight leaves it out, the dialog's confirm box says it. */
  closeWarning: string | null;
}

/**
 * Steam sets ActiveProcess\ActiveUser to the signed-in account's SteamID3 once login completes.
 * With a known target the switch waits for exactly that id; for a brand-new account it waits for
 * any non-zero id other than the one Steam had before it was restarted.
 */
type SignInWait =
  | { kind: 'signed-in' }
  | { kind: 'credentials'; reason: string; cause: SignInCause }
  /** `updating`: Steam was still updating itself when the wait gave up, so it must not be closed. */
  | { kind: 'timeout'; updating: boolean }
  | { kind: 'cancelled' };

/** Causes a second -login attempt cannot fix; the user has to act in the Steam window. */
const NEEDS_USER: ReadonlySet<SignInCause> = new Set(['guard-email', 'guard-mobile', 'rate-limit']);

function attentionFor(why: SignInWait, login: string, canCopyPassword: boolean, until: string): LaunchAttention {
  const reason = why.kind === 'credentials' ? why.reason || null : null;
  const cause: SignInCause = why.kind === 'credentials' ? why.cause : 'other';
  const base = { kind: 'sign-in' as const, reason, canCopyPassword, until };
  const remember = 'Keep “Remember me” ticked.';
  const finish = 'One Launch continues on its own as soon as Steam reports the sign-in, and later switches are automatic.';
  if (why.kind === 'timeout' && why.updating) {
    return {
      ...base,
      title: 'Steam is still updating itself',
      message: 'Steam has been updating itself for longer than One Launch waits on its own, so it was left to finish.',
      steps: [`If Steam shows its sign-in form afterwards, sign in as ${login} with “Remember me” ticked. ${finish}`],
    };
  }
  switch (cause) {
    case 'guard-email':
      return {
        ...base,
        title: 'Steam needs a one-time sign-in on this PC',
        message: `Steam accepted the sign-in for ${login}, but this PC is not yet authorized for the account, so it wants the code it just emailed you.`,
        steps: [
          `In the Steam window, enter the account name ${login} and the password.`,
          remember,
          `Enter the code Steam emailed you. ${finish} Later switches need none of this.`,
        ],
      };
    case 'guard-mobile':
      return {
        ...base,
        title: 'Steam Guard needs your approval',
        message: `Steam wants the sign-in for ${login} approved.`,
        steps: ['Approve the sign-in in the Steam Mobile app, or enter its code in the Steam window.', `${remember} ${finish}`],
      };
    case 'rate-limit':
      return {
        ...base,
        title: 'Steam is rate-limiting sign-ins',
        message: `Steam refused the sign-in for ${login} because of too many recent attempts.`,
        steps: ['Wait a few minutes.', `Sign in as ${login} in the Steam window with “Remember me” ticked. ${finish}`],
      };
    default:
      return {
        ...base,
        title: `Steam is asking you to sign in as ${login}`,
        message:
          cause === 'expired'
            ? 'Its remembered session has expired.'
            : reason
              ? `Steam did not complete the sign-in on its own (${reason}).`
              : 'Steam is waiting on its sign-in form.',
        steps: [
          `In the Steam window, enter the account name ${login} and your password.`,
          remember,
          `Sign in. If Steam Guard asks for a code, enter it. ${finish}`,
        ],
      };
  }
}

export class SteamAdapter implements LauncherAdapter {
  readonly id = 'steam' as const;
  readonly displayName = 'Steam';

  private readonly log: Logger;
  private readonly defaultDir: string;
  private readonly timing: typeof DEFAULT_TIMING;

  constructor(private readonly deps: SteamAdapterDeps) {
    this.log = deps.log;
    this.defaultDir = deps.defaultInstallDir ?? DEFAULT_STEAM_DIR;
    this.timing = mergeTiming(DEFAULT_TIMING, deps.timing);
  }

  // --- paths -----------------------------------------------------------------

  loginUsersPath(install: LauncherInstall): string {
    return join(install.installDir, 'config', 'loginusers.vdf');
  }

  libraryFoldersPath(install: LauncherInstall): string {
    return join(install.installDir, 'steamapps', 'libraryfolders.vdf');
  }

  // --- detection -------------------------------------------------------------

  async detectInstall(): Promise<LauncherInstall | null> {
    const { registry } = this.deps;
    const chosen = this.installAt(this.chosenInstallDir(), 'user');
    if (chosen) return chosen;
    const hkcu = this.installAt(await registry.getString('HKCU', STEAM_HKCU_KEY, 'SteamPath'), 'registry-hkcu');
    if (hkcu) {
      const exe = await registry.getString('HKCU', STEAM_HKCU_KEY, 'SteamExe');
      if (exe) {
        const p = normalizeLauncherPath(exe);
        if (existsSync(p)) hkcu.exePath = p;
      }
      return hkcu;
    }
    const hklm = this.installAt(await registry.getString('HKLM', STEAM_HKLM_KEY, 'InstallPath'), 'registry-hklm');
    if (hklm) return hklm;
    return this.installAt(this.defaultDir, 'default-path');
  }

  chosenInstallDir(): string | null {
    return chosenFolder(this.deps.installDir);
  }

  installFromExe(exePath: string): LauncherInstall | null {
    const exe = normalizeLauncherPath(exePath);
    return isNamed(exe, [STEAM_EXE]) ? this.installAt(dirname(exe), 'user') : null;
  }

  private installAt(raw: string | null, source: LauncherInstall['source']): LauncherInstall | null {
    if (!raw || !raw.trim()) return null;
    const installDir = normalizeLauncherPath(raw);
    const exePath = join(installDir, STEAM_EXE);
    if (!existsSync(exePath)) {
      this.log.debug('no steam.exe at candidate location', { source, installDir });
      return null;
    }
    return { launcher: 'steam', installDir, exePath, source };
  }

  private async requireInstall(): Promise<LauncherInstall> {
    const install = await this.detectInstall();
    if (!install) throw new LauncherNotInstalledError('steam');
    return install;
  }

  // --- library ---------------------------------------------------------------

  /** Main install dir first, then every extra folder from libraryfolders.vdf, deduplicated. */
  private libraryFolders(install: LauncherInstall): { folders: string[]; error: string | null } {
    const file = this.libraryFoldersPath(install);
    const folders = [install.installDir];
    let error: string | null = null;
    if (existsSync(file)) {
      try {
        const seen = new Set([pathKey(install.installDir)]);
        for (const p of parseLibraryFolders(readLauncherText(file, MAX_VDF_BYTES))) {
          if (seen.has(pathKey(p))) continue;
          seen.add(pathKey(p));
          folders.push(p);
        }
      } catch (err) {
        error = `Could not parse ${file}: ${errorText(err)}`;
        this.log.warn('libraryfolders.vdf unreadable; scanning the main Steam folder only', { file, error: errorText(err) });
      }
    }
    return { folders, error };
  }

  private installPathFor(appsDir: string, installDir: string): string {
    const common = join(appsDir, 'common');
    const candidate = resolve(common, installDir);
    return candidate.toLowerCase().startsWith(`${common.toLowerCase()}${sep}`) ? candidate : common;
  }

  async listInstalledGames(): Promise<InstalledGame[]> {
    const install = await this.requireInstall();
    const { folders } = this.libraryFolders(install);
    const games: InstalledGame[] = [];
    const seen = new Set<string>();

    for (const library of folders) {
      const appsDir = join(library, 'steamapps');
      if (!existsSync(appsDir)) {
        this.log.warn('library folder has no steamapps directory', { library });
        continue;
      }
      for (const name of readdirSync(appsDir)) {
        if (!APP_MANIFEST_FILE.test(name)) continue;
        const file = join(appsDir, name);
        let manifest;
        try {
          manifest = parseAppManifest(readLauncherText(file, MAX_VDF_BYTES));
        } catch (err) {
          this.log.warn('skipping unreadable appmanifest', { file, error: errorText(err) });
          continue;
        }
        if (!isFullyInstalled(manifest.stateFlags) || seen.has(manifest.appId) || STEAM_TOOL_APPIDS.has(manifest.appId)) continue;
        seen.add(manifest.appId);
        games.push({
          launcher: 'steam',
          launcherGameId: manifest.appId,
          name: manifest.name,
          installPath: this.installPathFor(appsDir, manifest.installDir),
          libraryPath: library,
          sizeOnDiskBytes: manifest.sizeOnDisk,
          lastPlayedAt: manifest.lastPlayed ? new Date(manifest.lastPlayed * 1000).toISOString() : null,
          needsUpdate: needsUpdate(manifest.stateFlags),
        });
      }
    }
    return games.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  // --- accounts --------------------------------------------------------------

  private readLoginUsers(install: LauncherInstall): SteamLoginUser[] {
    const file = this.loginUsersPath(install);
    if (!existsSync(file)) throw new LauncherFileError(file, 'loginusers.vdf not found');
    try {
      return parseLoginUsers(readLauncherText(file, MAX_VDF_BYTES));
    } catch (err) {
      throw new LauncherFileError(file, `Could not parse loginusers.vdf (${errorText(err)})`);
    }
  }

  async listRememberedAccounts(): Promise<RememberedAccountEntry[]> {
    const install = await this.requireInstall();
    return this.readLoginUsers(install)
      .map((u): RememberedAccountEntry => ({
        launcher: 'steam',
        launcherUid: u.steamId64,
        login: u.accountName,
        personaName: u.personaName,
        rememberPassword: u.rememberPassword,
        mostRecent: u.mostRecent,
        lastLoginAt: u.timestamp ? new Date(u.timestamp * 1000).toISOString() : null,
        sessionMayBeExpired: (sessionAgeDays(u.timestamp) ?? Number.POSITIVE_INFINITY) >= STALE_SESSION_DAYS,
      }))
      .sort((a, b) => Number(b.mostRecent) - Number(a.mostRecent) || (b.lastLoginAt ?? '').localeCompare(a.lastLoginAt ?? ''));
  }

  // --- process ---------------------------------------------------------------

  async isRunning(): Promise<boolean> {
    return this.deps.processes.isRunning(STEAM_EXE);
  }

  /**
   * Steam keeps HKCU\...\Steam\RunningAppID (0 when idle) and a per-app Name under Apps\<id>.
   * As a fallback, any process running out of a game's install folder counts too.
   */
  async runningGame(): Promise<RunningGame | null> {
    const { registry, processes } = this.deps;
    const install = await this.detectInstall();
    if (!install) return null;

    const appId = await registry.getDword('HKCU', STEAM_HKCU_KEY, 'RunningAppID');
    if (appId && appId > 0) {
      const name = (await registry.getString('HKCU', `${STEAM_HKCU_KEY}\\Apps\\${appId}`, 'Name')) ?? `Steam app ${appId}`;
      return { launcher: 'steam', launcherGameId: String(appId), name, source: 'launcher' };
    }

    let procs;
    try {
      procs = await processes.listProcesses();
    } catch (err) {
      this.log.warn('could not list processes for game detection', { error: errorText(err) });
      return null;
    }
    if (procs.length === 0) return null;
    const game = await gameWithRunningProcess(procs, await this.listInstalledGames());
    return game ? { launcher: 'steam', launcherGameId: game.launcherGameId, name: game.name, source: 'process' } : null;
  }

  private waitUntil(cond: () => Promise<boolean>, timeoutMs: number, signal?: AbortSignal, pollMs = this.timing.pollMs): Promise<boolean> {
    return waitUntil(cond, { timeoutMs, pollMs, signal });
  }

  /** `steam.exe -shutdown`, wait, then a forced kill of its tree. Throws if Steam is still running afterwards, or SwitchAbortedError when the signal aborts a wait. */
  async shutdown(opts: { timeoutMs?: number; signal?: AbortSignal | undefined } = {}): Promise<void> {
    const install = await this.requireInstall();
    if (!(await this.isRunning())) return;
    const timeoutMs = opts.timeoutMs ?? this.timing.shutdownMs;
    this.log.info('asking steam to shut down', { timeoutMs });
    await this.deps.processes.start(install.exePath, ['-shutdown'], { cwd: install.installDir });
    if (await this.waitUntil(async () => !(await this.isRunning()), timeoutMs, opts.signal)) return;
    this.log.warn('steam did not exit in time; killing it');
    await this.deps.processes.kill(STEAM_EXE);
    if (!(await this.waitUntil(async () => !(await this.isRunning()), this.timing.killGraceMs, opts.signal))) {
      throw new Error('steam.exe is still running after -shutdown and a forced close');
    }
  }

  async launchGame(game: { launcherGameId: string; name: string }): Promise<{ command: string }> {
    if (!/^\d+$/.test(game.launcherGameId)) throw new Error(`Not a Steam app id: ${game.launcherGameId}`);
    const url = `steam://rungameid/${game.launcherGameId}`;
    this.log.info('launching game', { appId: game.launcherGameId, name: game.name });
    await this.deps.openExternal(url);
    return { command: url };
  }

  // --- switching -------------------------------------------------------------

  /** What a close does, for the confirmation: Steam takes any game running under it down with it. */
  private closeMessage(game: RunningGame | null): string {
    return game
      ? `Steam is running ${game.name}. Switching closes Steam and the game; unsaved progress in the game is lost.`
      : 'Steam is running. Switching closes it.';
  }

  async preflight(account: AccountRef): Promise<SwitchPreflight> {
    const { plan, ctx } = await this.buildSwitchPlan(account);
    const runningGame = plan.current.running && !ctx.alreadyActive ? await this.runningGame() : null;
    return {
      plan: withoutCloseWarning(plan, ctx.closeWarning),
      launcherRunning: plan.current.running,
      runningGame,
      alreadyActive: ctx.alreadyActive,
      closeMessage: this.closeMessage(runningGame),
    };
  }

  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: true }): Promise<SwitchPlan>;
  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: false }): Promise<SwitchResult>;
  switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult>;
  async switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult> {
    if (opts.dryRun) return (await this.buildSwitchPlan(account)).plan;
    return this.runSwitch(account, opts);
  }

  /** Reads everything the real switch would read and describes every change it would make. */
  private async buildSwitchPlan(account: AccountRef): Promise<{ plan: SwitchPlan; ctx: PlanContext }> {
    const { registry } = this.deps;
    const install = await this.requireInstall();
    const loginUsersPath = this.loginUsersPath(install);
    const regKey = `HKCU\\${STEAM_HKCU_KEY}`;
    const running = await this.isRunning();
    const autoLoginUser = await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser');
    const rememberDword = await registry.getDword('HKCU', STEAM_HKCU_KEY, 'RememberPassword');

    const warnings: string[] = [];
    const notes: string[] = [];
    let text: string | null = null;
    let users: SteamLoginUser[] = [];
    if (existsSync(loginUsersPath)) {
      text = readLauncherText(loginUsersPath, MAX_VDF_BYTES);
      try {
        users = parseLoginUsers(text);
      } catch (err) {
        text = null;
        warnings.push(`loginusers.vdf could not be parsed (${errorText(err)}). Steam is treated as remembering no accounts.`);
      }
    } else {
      warnings.push('loginusers.vdf does not exist yet. Steam has not remembered any account on this PC.');
    }

    const target = findLoginUser(users, account);
    const mostRecentUser = users.find((u) => u.mostRecent) ?? null;
    const strategy = target?.rememberPassword ? 'remembered' : 'credentials';
    const withPassword = (this.deps.autoLogin?.() ?? false) && account.hasSecret;

    const rewrite = strategy === 'remembered' && target && text !== null ? planAutoLoginRewrite(text, target.steamId64) : null;
    const sameUser = target !== null && autoLoginUser !== null && autoLoginUser.toLowerCase() === target.accountName.toLowerCase();
    const expectedId3 = target ? steamId3(target.steamId64) : null;
    const pointsAtTarget = rewrite !== null && rewrite.noop && sameUser;
    /** The files name the target, but the client that is running signed in as someone else (or as nobody yet). */
    const signedInElsewhere = pointsAtTarget && running && expectedId3 !== null && !(await this.signedInAs(install, expectedId3));
    /** Steam is already set up for this account: nothing to change, so no reason to restart it. */
    const alreadyActive = pointsAtTarget && !signedInElsewhere;
    const ageDays = target ? sessionAgeDays(target.timestamp) : null;
    const stale = strategy === 'remembered' && (ageDays === null || ageDays >= STALE_SESSION_DAYS);
    const activeUserKey = `${regKey}\\ActiveProcess\\ActiveUser`;
    const loginLog = loginLogPath(install.installDir);

    const steps: SwitchPlanStep[] = [];
    const step = (s: Omit<SwitchPlanStep, 'changes' | 'skipped'> & Partial<Pick<SwitchPlanStep, 'changes' | 'skipped'>>): void => {
      steps.push({ changes: [], skipped: false, ...s });
    };

    step({
      id: STEP.close,
      kind: 'process',
      title: 'Close Steam',
      target: STEAM_EXE,
      skipped: !running || alreadyActive,
      detail: alreadyActive
        ? 'Skipped: Steam is already signed in as this account, so it is left running.'
        : running
          ? `Run "${install.exePath}" -shutdown and wait up to ${this.timing.shutdownMs / 1000} s for steam.exe to exit. If it is still running after that, force-close steam.exe and every process it started. Any game running under Steam closes with it.`
          : 'Skipped: steam.exe is not running.',
    });

    step({
      id: STEP.backup,
      kind: 'backup',
      title: 'Back up Steam files',
      target: this.deps.backups.previewPath('steam'),
      skipped: alreadyActive,
      detail: alreadyActive
        ? 'Skipped: nothing will be modified.'
        : `Copy ${loginUsersPath} into a new snapshot folder and record the current ${regKey}\\AutoLoginUser and RememberPassword values in its manifest.json, so a failed switch can be rolled back. The newest ${this.deps.backupsToKeep()} snapshots are kept.`,
    });

    if (rewrite !== null && target) {
      const others = users.length - 1;
      const keys =
        target.mostRecentKeys.length > 0 ? target.mostRecentKeys.join(' and ') : 'AutoLogin (added, because the block has neither AutoLogin nor MostRecent)';
      step({
        id: STEP.file,
        kind: 'file',
        title: 'Mark the account as most recent',
        target: loginUsersPath,
        skipped: rewrite.noop,
        detail: rewrite.noop
          ? `No change: ${target.accountName} is already the most recent account in loginusers.vdf.`
          : `Set ${keys} to 1 for ${target.accountName} (${target.steamId64}) and to 0 for the other ${plural(others, 'remembered account')}. The new content is written to a temp file and renamed over the original. Nothing else in the file changes.`,
        changes: rewrite.changes.map((c) => ({ where: `line ${c.line}`, before: c.before.trim(), after: c.after.trim() })),
      });

      step({
        id: STEP.registryUser,
        kind: 'registry',
        title: 'Point Steam at the account',
        target: `${regKey}\\AutoLoginUser`,
        skipped: sameUser,
        detail: sameUser
          ? `No change: AutoLoginUser is already ${target.accountName}.`
          : 'REG_SZ. Steam reads this at startup to decide which remembered account to sign in as.',
        changes: sameUser ? [] : [{ where: 'AutoLoginUser', before: autoLoginUser ?? '(absent)', after: target.accountName }],
      });

      const remembered = rememberDword === 1;
      step({
        id: STEP.registryRemember,
        kind: 'registry',
        title: 'Keep the session remembered',
        target: `${regKey}\\RememberPassword`,
        skipped: remembered || alreadyActive,
        detail: remembered
          ? 'No change: RememberPassword is already 1.'
          : alreadyActive
            ? 'Skipped: no switch is needed, so the value is left as it is.'
            : 'REG_DWORD set to 1. On this Steam build the value is normally absent and the per-account RememberPassword in loginusers.vdf does the work; writing it is harmless and matches the documented procedure.',
        changes:
          remembered || alreadyActive ? [] : [{ where: 'RememberPassword', before: rememberDword === null ? '(absent)' : String(rememberDword), after: '1' }],
      });

      step({
        id: STEP.start,
        kind: 'launch',
        title: 'Start Steam',
        target: `"${install.exePath}"`,
        skipped: alreadyActive && running,
        detail:
          alreadyActive && running
            ? 'Skipped: Steam is already running as this account.'
            : `Start Steam normally. It signs in as ${target.accountName} without prompting because the session is remembered.`,
      });
    } else {
      const why = target ? `Steam remembers ${target.accountName} but "Remember me" is off for it` : `Steam has never signed in as ${account.login} on this PC`;
      step({
        id: STEP.login,
        kind: 'launch',
        title: withPassword ? 'Start Steam with credentials' : 'Start Steam on its sign-in form',
        target: withPassword ? `"${install.exePath}" -login ${account.login} <password>` : `"${install.exePath}" -login ${account.login}`,
        detail: withPassword
          ? `${why}, so Steam is started with -login. The password is decrypted from the vault at that moment and passed only as a process argument; it is never written anywhere by One Launch, but it is visible on the command line to other processes on this PC while Steam runs. Afterwards Steam adds the account to loginusers.vdf and later switches use the remembered path.`
          : `${why}, so Steam is started with -login and only the account name, which makes it open its sign-in form instead of signing in as the previous account. You enter the password there; nothing secret goes on the command line. Afterwards Steam adds the account to loginusers.vdf and later switches use the remembered path.`,
      });
      if (withPassword) {
        warnings.push(
          `If this PC has never signed in as ${account.login}, Steam Guard will ask for an emailed code once. One Launch then waits up to ${this.timing.manualSignInMs / 60_000} min while you sign in in the Steam window, and continues on its own.`,
        );
      } else {
        warnings.push(
          `Steam will open its sign-in form for ${account.login}. One Launch waits up to ${this.timing.manualSignInMs / 60_000} min while you sign in there with "Remember me" ticked${
            account.hasSecret ? ' and offers to copy the login and password' : ' and offers to copy the login'
          }; later switches are automatic.`,
        );
      }
    }

    step({
      id: STEP.wait,
      kind: 'wait',
      title: 'Wait for Steam to come up',
      target: STEAM_EXE,
      skipped: alreadyActive && running,
      detail: `Poll the process list until steam.exe is running, up to ${this.timing.startupMs / 1000} s.`,
    });

    step({
      id: STEP.verify,
      kind: 'wait',
      title: 'Confirm Steam signed in',
      target: activeUserKey,
      skipped: alreadyActive && running,
      detail:
        alreadyActive && running
          ? 'Skipped: Steam is already signed in as this account.'
          : `${
              expectedId3 !== null
                ? `Poll until Steam reports the signed-in account id ${expectedId3} (the SteamID3 of ${target?.accountName ?? account.login}), up to ${(strategy === 'credentials' ? this.timing.guardMs : this.timing.signInMs) / 1000} s.`
                : `Poll until Steam reports a signed-in account, up to ${this.timing.guardMs / 1000} s.`
            } Meanwhile ${loginLog} is read (Steam's own sign-in state log, no credentials in it) to learn at once whether Steam is instead asking for a password or a Steam Guard code, and ${bootstrapLogPath(install.installDir)} (its updater log) to see whether Steam is updating itself first; then the wait starts over when the update ends, up to ${this.timing.updateMs / 60_000} min in all. A game launch (steam://rungameid/<appid>) happens only after the sign-in is confirmed.`,
    });

    if (strategy === 'remembered') {
      step({
        id: STEP.login,
        kind: 'launch',
        title: 'Fallback: sign in with the stored password',
        target: `"${install.exePath}" -login ${account.login} <password>`,
        skipped: true,
        detail: withPassword
          ? 'Runs only if Steam asks for credentials instead of signing in (an expired session): close Steam, start it again with -login using the password from the vault, and confirm the sign-in again.'
          : account.hasSecret
            ? 'Not used: Steam automatic sign-in is off in Settings. If Steam asks for credentials, One Launch waits for you to sign in by hand (next step) and offers to copy the login and password.'
            : 'Not available: no password is stored for this account. If Steam asks for credentials, One Launch waits for you to sign in by hand (next step).',
      });
    }

    step({
      id: STEP.manual,
      kind: 'wait',
      title: 'Wait for you to sign in',
      target: activeUserKey,
      skipped: true,
      detail: `Runs only if Steam still asks for something One Launch cannot supply: a Steam Guard code for a PC this account has not used before, an expired session with no stored password, or a session Steam simply refuses. The Steam window stays open on its sign-in form; you sign in there once with "Remember me" ticked${
        account.hasSecret ? ' (the password can be copied from One Launch)' : ''
      } and One Launch continues with the game as soon as Steam reports the sign-in, up to ${this.timing.manualSignInMs / 60_000} min. A wrong stored password ends the switch instead.`,
    });

    let closeWarning: string | null = null;
    if (alreadyActive && target) {
      notes.push(
        `Steam is already set to sign in as ${target.accountName}. The real switch would change nothing${running ? ' and would leave Steam running' : ''}.`,
      );
    } else if (signedInElsewhere && target) {
      const activeId3 = await this.activeUser();
      const other = users.find((u) => steamId3(u.steamId64) === activeId3 && u.steamId64 !== target.steamId64);
      closeWarning = `Steam's files already name ${target.accountName}, but the Steam that is running is ${
        other ? `signed in as ${other.accountName}` : `not signed in as ${target.accountName}`
      }. It will be closed, along with any game running under it, and started again as ${target.accountName}.`;
      warnings.push(closeWarning);
    } else if (running) {
      closeWarning = 'Steam is running. It will be closed, along with any game running under it.';
      warnings.push(closeWarning);
    }
    if (stale && target) {
      const age = ageDays === null ? 'an unknown time' : `${ageDays} days`;
      warnings.push(
        `${target.accountName} last signed in here ${age} ago. Steam sessions expire, so Steam may ask for credentials instead of signing in. ${
          withPassword
            ? 'One Launch will then sign in with the stored password.'
            : 'One Launch will then wait while you sign in in the Steam window, and continues on its own.'
        }`,
      );
    }
    if (target && account.launcherUid && target.steamId64 !== account.launcherUid) {
      warnings.push(
        `The SteamID64 stored on this account (${account.launcherUid}) does not match Steam's entry for ${target.accountName} (${target.steamId64}). Matched by login instead; check the ID on the account page.`,
      );
    }
    if (autoLoginUser && mostRecentUser && autoLoginUser.toLowerCase() !== mostRecentUser.accountName.toLowerCase()) {
      warnings.push(
        `Registry AutoLoginUser (${autoLoginUser}) and the most recent account in loginusers.vdf (${mostRecentUser.accountName}) disagree. The switch sets both, which resolves it.`,
      );
    }

    const plan: SwitchPlan = {
      launcher: 'steam',
      account: { id: account.id, displayName: account.displayName, login: account.login, launcherUid: target?.steamId64 ?? account.launcherUid },
      strategy,
      current: { mostRecentLogin: mostRecentUser?.accountName ?? null, autoLoginUser, running },
      steps,
      warnings,
      notes,
      executable: true,
      generatedAt: new Date().toISOString(),
    };
    return { plan, ctx: { install, loginUsersPath, target, alreadyActive, stale, autoLoginUser, rememberDword, closeWarning } };
  }

  private async activeUser(): Promise<number | null> {
    return this.deps.registry.getDword('HKCU', `${STEAM_HKCU_KEY}\\ActiveProcess`, 'ActiveUser');
  }

  /**
   * A running Steam is signed in as `id3`. ActiveUser survives an exit, so a client sitting on its
   * sign-in form can still show the last account's id: the login log's last word vetoes that.
   */
  private async signedInAs(install: LauncherInstall, id3: number): Promise<boolean> {
    if ((await this.activeUser()) !== id3) return false;
    return outcomeSince(loginLogPath(install.installDir), 0)?.kind !== 'credentials';
  }

  /**
   * The real switch.
   *
   * Remembered path: shutdown → snapshot → rewrite loginusers.vdf → registry → start → confirm the
   * signed-in account. If Steam asks for credentials instead (expired session) and a password is
   * available, restart Steam with -login and confirm again. Without a password the result is
   * needsSignIn: the writes stand and the user signs in once by hand.
   *
   * Credentials path: shutdown → snapshot → start with -login → confirm.
   *
   * Steam rewrites loginusers.vdf when it exits, so the snapshot and rewrite happen after shutdown.
   * Anything that fails after the first modification is rolled back from the snapshot.
   */
  private async runSwitch(account: AccountRef, opts: SwitchOptions): Promise<SwitchResult> {
    const startedAt = new Date().toISOString();
    const { plan, ctx } = await this.buildSwitchPlan(account);
    const { install, loginUsersPath, target } = ctx;
    const login = target?.accountName ?? account.login;
    const withPassword = (this.deps.autoLogin?.() ?? false) && account.hasSecret && Boolean(opts.getPassword);

    if (!plan.executable) throw new SwitchBlockedError(plan.warnings[0] ?? 'This switch cannot run.');
    if (plan.current.running && !ctx.alreadyActive && !opts.confirmClose) {
      const game = await this.runningGame();
      throw new ConfirmationRequiredError(this.closeMessage(game), game);
    }

    const steps: JobStep[] = plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.skipped ? 'skipped' : 'pending',
      detail: s.skipped ? s.detail : '',
    }));
    const index = new Map(plan.steps.map((s, i) => [s.id, i]));
    let current: string | null = null;
    const mark = (id: string, status: JobStepStatus, detail = ''): void => {
      const i = index.get(id);
      if (i === undefined) return;
      steps[i] = { ...steps[i]!, status, detail };
      current = status === 'running' ? id : null;
      opts.onProgress?.(steps.map((s) => ({ ...s })));
    };
    const result = (ok: boolean, extra: Pick<SwitchResult, 'backupId' | 'restored' | 'error' | 'needsSignIn' | 'cancelled'>): SwitchResult => ({
      launcher: 'steam',
      account: plan.account,
      strategy: plan.strategy,
      ok,
      steps,
      startedAt,
      finishedAt: new Date().toISOString(),
      readyAt: null,
      startedWithGame: null,
      ...extra,
    });

    const expectedId3 = target ? steamId3(target.steamId64) : null;
    let backupId: string | null = null;
    let modified = false;
    /** Once Steam has been started again an abort no longer rolls back: Steam is reading what was written. */
    let launcherStarted = false;
    let handedOver = false;
    const stopIfAborted = (): void => {
      if (opts.signal?.aborted) throw new SwitchAbortedError();
    };

    const takeSnapshot = (): void => {
      mark(STEP.backup, 'running');
      const snapshot = this.deps.backups.snapshot({
        launcher: 'steam',
        reason: `Before switching to ${account.displayName}`,
        files: [{ source: loginUsersPath, relative: 'config/loginusers.vdf' }],
        meta: { AutoLoginUser: ctx.autoLoginUser, RememberPassword: ctx.rememberDword },
      });
      backupId = snapshot.id;
      mark(STEP.backup, 'done', snapshot.path);
    };
    // The journal hears of the snapshot only at the first write, so a switch that writes nothing leaves no recovery prompt.
    const beforeWrite = (): void => {
      if (!modified && backupId) opts.onBackup?.(backupId);
      modified = true;
    };
    const waitForProcess = async (): Promise<void> => {
      mark(STEP.wait, 'running');
      if (!(await this.waitUntil(() => this.isRunning(), this.timing.startupMs, opts.signal))) {
        throw new Error(`steam.exe did not appear within ${this.timing.startupMs / 1000} s`);
      }
      mark(STEP.wait, 'done', 'steam.exe is running.');
    };
    const loginLog = loginLogPath(install.installDir);
    const bootstrapLog = bootstrapLogPath(install.installDir);
    // Taken here as well as at each start, so a Steam this switch did not start is never judged by lines from before the switch.
    let logMark = loginLogMark(loginLog);
    let bootstrapMark = bootstrapLogMark(bootstrapLog);
    const startSteam = async (args: string[]): Promise<void> => {
      stopIfAborted();
      logMark = loginLogMark(loginLog);
      bootstrapMark = bootstrapLogMark(bootstrapLog);
      launcherStarted = true;
      await this.deps.processes.start(install.exePath, args, { cwd: install.installDir });
    };
    /** Something other than this switch started Steam. Before the writes nothing is lost by stopping; after them the catch block rolls back. */
    const startedMeanwhile = (at: string): Error => {
      mark(at, 'running');
      return new Error(
        `Steam was started by something else while One Launch was switching accounts, so the switch ${modified ? 'was stopped' : 'stopped before changing anything'}. Try again.`,
      );
    };
    /**
     * Polls Steam's signed-in account id and, unless the user is signing in by hand, its login log,
     * so a Steam Guard prompt or a rejected password is reported at once instead of after a timeout.
     */
    /**
     * ActiveUser is not cleared when Steam exits, so a value equal to what it held before this start
     * proves nothing by itself: then Steam's own log has to report the sign-in since the start mark.
     */
    const waitForSignIn = async (previous: number, timeoutMs: number, manual: boolean): Promise<SignInWait> => {
      const ceiling = Date.now() + Math.max(timeoutMs, this.timing.updateMs);
      let deadline = Date.now() + timeoutMs;
      let updating = false;
      for (;;) {
        if (opts.signal?.aborted) return { kind: 'cancelled' };
        const v = await this.activeUser();
        const outcome = manual && v !== previous ? null : outcomeSince(loginLog, logMark);
        if (v !== null && v !== 0 && (expectedId3 !== null ? v === expectedId3 : v !== previous)) {
          if (v !== previous || outcome?.kind === 'success') return { kind: 'signed-in' };
        }
        if (!manual && outcome?.kind === 'credentials') return { kind: 'credentials', reason: outcome.reason, cause: outcome.cause };
        if (!manual) {
          // A client update comes before any sign-in, so the budget starts over once it ends; a dead steam.exe stops extending it.
          const wasUpdating = updating;
          updating = updatingSince(bootstrapLog, bootstrapMark);
          if (updating && (await this.isRunning())) deadline = Math.min(ceiling, Date.now() + timeoutMs);
          if (updating && !wasUpdating) mark(STEP.verify, 'running', 'Steam is updating itself first; the sign-in follows when it has finished.');
          else if (!updating && wasUpdating) mark(STEP.verify, 'running', 'Steam finished updating itself.');
        }
        if (Date.now() >= deadline) return { kind: 'timeout', updating };
        await sleep(this.timing.logPollMs, opts.signal);
      }
    };
    const confirmSignIn = async (previous: number, timeoutMs: number): Promise<SignInWait> => {
      mark(STEP.verify, 'running');
      const r = await waitForSignIn(previous, timeoutMs, false);
      if (r.kind === 'signed-in') mark(STEP.verify, 'done', `Steam signed in as ${login}.`);
      else if (r.kind === 'credentials') mark(STEP.verify, 'failed', `Steam is asking for credentials: ${r.reason || 'no reason given'}.`);
      else if (r.kind === 'timeout') mark(STEP.verify, 'failed', r.updating ? 'Steam is still updating itself.' : 'Steam did not report a sign-in in time.');
      else mark(STEP.verify, 'failed', 'Cancelled.');
      return r;
    };
    /** The password is fetched here and nowhere else, used once, and never logged. Without it, -login with only the name opens Steam's sign-in form. */
    const startSignIn = async (): Promise<number> => {
      const password = withPassword ? (opts.getPassword?.() ?? null) : null;
      mark(STEP.login, 'running');
      if (await this.isRunning()) await this.shutdown({ signal: opts.signal });
      const previous = (await this.activeUser()) ?? 0;
      this.log.info(password ? 'starting steam with credentials' : 'starting steam on its sign-in form', { accountId: account.id });
      await startSteam(password ? ['-login', account.login, password] : ['-login', account.login]);
      mark(STEP.login, 'done', password ? 'Steam started with -login.' : 'Steam started on its sign-in form.');
      await waitForProcess();
      return previous;
    };
    const passwordRejected = (): Error => new Error(`Steam rejected the stored password for ${login}. Update it on the account page and try again.`);
    /** Steam is sitting on its sign-in form: hand over to the user and wait for the sign-in to land. */
    const waitForManualSignIn = async (previous: number, why: SignInWait): Promise<SignInWait> => {
      const until = new Date(Date.now() + this.timing.manualSignInMs).toISOString();
      const attention = attentionFor(why, login, account.hasSecret && Boolean(opts.getPassword), until);
      mark(STEP.manual, 'running', attention.title);
      this.log.warn('switch waiting for manual sign-in', { accountId: account.id, reason: attention.reason, backupId });
      handedOver = true;
      opts.onAttention?.(attention);
      try {
        const r = await waitForSignIn(previous, this.timing.manualSignInMs, true);
        if (r.kind === 'signed-in') mark(STEP.manual, 'done', `Steam signed in as ${login}.`);
        else if (r.kind === 'cancelled') mark(STEP.manual, 'failed', 'Stopped waiting.');
        else mark(STEP.manual, 'failed', `No sign-in after ${this.timing.manualSignInMs / 60_000} min.`);
        return r;
      } finally {
        opts.onAttention?.(null);
      }
    };
    const cancelledResult = (): SwitchResult =>
      result(false, {
        backupId,
        restored: null,
        cancelled: true,
        needsSignIn: false,
        error: handedOver
          ? `Stopped waiting for the sign-in as ${login}. Steam was left on its sign-in form; signing in there with "Remember me" ticked finishes the switch, and later switches are automatic.`
          : `Stopped while Steam was starting as ${login}. Nothing was rolled back: Steam carries on signing in on its own.`,
      });
    const needsSignInResult = (): SwitchResult =>
      result(false, {
        backupId,
        restored: null,
        cancelled: false,
        needsSignIn: true,
        error: `One Launch waited ${this.timing.manualSignInMs / 60_000} min for the sign-in as ${login} and gave up. Steam is still on its sign-in form: sign in there with "Remember me" ticked, and later switches are automatic.`,
      });
    /** The sign-in is already confirmed when this runs, so it is bounded and an abort simply ends it. */
    const untilLibraryReady = async (): Promise<void> => {
      try {
        await this.waitUntil(async () => outcomeSince(loginLog, logMark)?.kind === 'success', this.timing.readyGraceMs, opts.signal, this.timing.logPollMs);
      } catch (err) {
        if (!(err instanceof SwitchAbortedError)) throw err;
      }
    };
    /**
     * After a plain -login for an account Steam had never seen, ActiveUser only says "someone signed
     * in". Cross-check it against the loginusers.vdf entry Steam writes for that account name.
     */
    const verifyIdentity = async (): Promise<void> => {
      if (expectedId3 !== null) return;
      const signedIn = await this.activeUser();
      let users: SteamLoginUser[];
      try {
        users = parseLoginUsers(readFileSync(loginUsersPath, 'utf8'));
      } catch {
        return;
      }
      const entry = users.find((u) => u.accountName.toLowerCase() === account.login.toLowerCase());
      if (entry && signedIn !== null && steamId3(entry.steamId64) !== signedIn) {
        const other = users.find((u) => steamId3(u.steamId64) === signedIn);
        throw new Error(`Steam signed in as ${other?.accountName ?? 'a different account'} instead of ${login}.`);
      }
    };

    this.log.info('switch started', {
      accountId: account.id,
      strategy: plan.strategy,
      alreadyActive: ctx.alreadyActive,
      running: plan.current.running,
      stale: ctx.stale,
    });

    try {
      stopIfAborted();
      if (plan.current.running && !ctx.alreadyActive) {
        mark(STEP.close, 'running');
        await this.shutdown({ signal: opts.signal });
        mark(STEP.close, 'done', 'Steam closed.');
      }
      stopIfAborted();

      if (!ctx.alreadyActive && (await this.isRunning())) throw startedMeanwhile(STEP.close);

      if (plan.strategy === 'remembered' && target) {
        if (!ctx.alreadyActive) {
          takeSnapshot();

          // Fresh read: Steam has just exited and may have rewritten the file.
          const text = readFileSync(loginUsersPath, 'utf8');
          const rewrite = planAutoLoginRewrite(text, target.steamId64);
          mark(STEP.file, 'running');
          if (rewrite.noop) {
            mark(STEP.file, 'skipped', 'Already marked as most recent.');
          } else {
            beforeWrite();
            writeFileAtomic(loginUsersPath, rewrite.text);
            mark(STEP.file, 'done', `${plural(rewrite.changes.length, 'line')} changed.`);
          }

          mark(STEP.registryUser, 'running');
          const autoLoginUser = await this.deps.registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser');
          if (autoLoginUser !== null && autoLoginUser.toLowerCase() === target.accountName.toLowerCase()) {
            mark(STEP.registryUser, 'skipped', `AutoLoginUser is already ${target.accountName}.`);
          } else {
            beforeWrite();
            await this.deps.registry.setString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser', target.accountName);
            mark(STEP.registryUser, 'done', `AutoLoginUser = ${target.accountName}`);
          }

          mark(STEP.registryRemember, 'running');
          if ((await this.deps.registry.getDword('HKCU', STEAM_HKCU_KEY, 'RememberPassword')) === 1) {
            mark(STEP.registryRemember, 'skipped', 'RememberPassword is already 1.');
          } else {
            beforeWrite();
            await this.deps.registry.setDword('HKCU', STEAM_HKCU_KEY, 'RememberPassword', 1);
            mark(STEP.registryRemember, 'done', 'RememberPassword = 1');
          }
        }

        let previous = (await this.activeUser()) ?? 0;
        let started = false;
        if (await this.isRunning()) {
          // Only a switch that changes nothing may meet a running Steam here; anything else was closed above.
          if (!ctx.alreadyActive) throw startedMeanwhile(STEP.start);
          mark(STEP.start, 'skipped', 'Steam is already running.');
          mark(STEP.wait, 'skipped', 'Steam is already running.');
        } else {
          mark(STEP.start, 'running');
          await startSteam([]);
          started = true;
          mark(STEP.start, 'done', 'Steam started.');
          await waitForProcess();
        }

        if (!started && expectedId3 !== null && (await this.signedInAs(install, expectedId3))) {
          mark(STEP.verify, 'skipped', 'Steam is already signed in as this account.');
        } else {
          let r = await confirmSignIn(previous, this.timing.signInMs);
          if (r.kind === 'cancelled') return cancelledResult();
          // A second attempt with the stored password fixes an expired or dropped session, but not
          // a Steam Guard prompt or a rate limit; those go straight to the user. It closes Steam, so
          // it never runs while Steam is updating itself, or against a Steam this switch did not start.
          const retryWithPassword = withPassword && started && !(r.kind === 'credentials' && NEEDS_USER.has(r.cause)) && !(r.kind === 'timeout' && r.updating);
          if (r.kind !== 'signed-in' && retryWithPassword) {
            previous = await startSignIn();
            r = await confirmSignIn(previous, this.timing.guardMs);
            if (r.kind === 'cancelled') return cancelledResult();
            if (r.kind === 'credentials' && r.cause === 'password') throw passwordRejected();
          }
          if (r.kind !== 'signed-in') {
            const m = await waitForManualSignIn(previous, r);
            if (m.kind === 'cancelled') return cancelledResult();
            if (m.kind !== 'signed-in') return needsSignInResult();
          }
        }
      } else {
        takeSnapshot();
        const previous = await startSignIn();
        let r: SignInWait;
        if (withPassword) {
          r = await confirmSignIn(previous, this.timing.guardMs);
          if (r.kind === 'cancelled') return cancelledResult();
          if (r.kind === 'credentials' && r.cause === 'password') throw passwordRejected();
        } else {
          mark(STEP.verify, 'skipped', 'Handed over to you.');
          r = { kind: 'credentials', reason: '', cause: 'none' };
        }
        if (r.kind !== 'signed-in') {
          r = await waitForManualSignIn(previous, r);
          if (r.kind === 'cancelled') return cancelledResult();
          if (r.kind !== 'signed-in') return needsSignInResult();
        }
        await verifyIdentity();
      }

      if (launcherStarted) await untilLibraryReady();

      this.log.info('switch finished', { accountId: account.id, backupId, modified });
      return result(true, { backupId, restored: null, error: null, needsSignIn: false, cancelled: false });
    } catch (err) {
      const cancelled = err instanceof SwitchAbortedError;
      const message = cancelled ? `Stopped before Steam was started as ${login}.` : errorText(err);
      if (current) mark(current, 'failed', cancelled ? 'Stopped.' : message);
      if (cancelled) this.log.info('switch stopped', { accountId: account.id, backupId, modified, launcherStarted });
      else if (!modified && isRefusal(err)) this.log.warn('switch refused', { accountId: account.id, code: refusalCode(err), error: err });
      else this.log.error('switch failed', { accountId: account.id, backupId, modified, error: err });
      if (cancelled && launcherStarted) return cancelledResult();
      if (!modified) {
        return result(false, { backupId, restored: null, error: cancelled ? `${message} Nothing had been changed.` : message, needsSignIn: false, cancelled });
      }
      if (!backupId)
        return result(false, { backupId, restored: false, error: `${message} (no backup was available to restore)`, needsSignIn: false, cancelled });
      try {
        // Steam rewrites loginusers.vdf on exit, so make sure it is down before putting the file back. Never interrupted: no signal.
        if (await this.isRunning()) await this.shutdown().catch((e: unknown) => this.log.warn('could not close steam before rollback', { error: e }));
        const restored = await this.applyRestore(backupId);
        this.log.warn('switch rolled back from backup', { backupId, files: restored.files.length, registry: restored.registry.length });
        return result(false, { backupId, restored: true, error: message, needsSignIn: false, cancelled });
      } catch (restoreErr) {
        this.log.error('rollback failed', { backupId, error: restoreErr });
        return result(false, {
          backupId,
          restored: false,
          error: `${message}. Restoring backup ${backupId} also failed: ${errorText(restoreErr)}`,
          needsSignIn: false,
          cancelled,
        });
      }
    }
  }

  // --- restore ---------------------------------------------------------------

  async restoreBackup(id: string): Promise<RestoreResult> {
    const install = await this.requireInstall();
    if (await this.isRunning()) {
      throw new LauncherRunningError('Close Steam before restoring: Steam rewrites loginusers.vdf when it exits, which would undo the restore.');
    }
    // The state being replaced is itself worth keeping: a restore of the wrong snapshot can then be undone.
    this.deps.backups.snapshot({
      launcher: 'steam',
      reason: `Before restoring ${id}`,
      files: [{ source: this.loginUsersPath(install), relative: 'config/loginusers.vdf' }],
      meta: {
        AutoLoginUser: await this.deps.registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser'),
        RememberPassword: await this.deps.registry.getDword('HKCU', STEAM_HKCU_KEY, 'RememberPassword'),
      },
      protect: id,
    });
    return this.applyRestore(id);
  }

  private async applyRestore(id: string): Promise<RestoreResult> {
    const { backups, registry } = this.deps;
    const { restored, meta } = backups.restore('steam', id, [this.loginUsersPath(await this.requireInstall())]);
    const lines: string[] = [];
    if ('AutoLoginUser' in meta) {
      const v = meta['AutoLoginUser'];
      if (typeof v === 'string') {
        await registry.setString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser', v);
        lines.push(`AutoLoginUser = ${v}`);
      } else {
        await registry.deleteValue('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser');
        lines.push('AutoLoginUser (removed)');
      }
    }
    if ('RememberPassword' in meta) {
      const v = meta['RememberPassword'];
      if (typeof v === 'number') {
        await registry.setDword('HKCU', STEAM_HKCU_KEY, 'RememberPassword', v);
        lines.push(`RememberPassword = ${v}`);
      } else {
        await registry.deleteValue('HKCU', STEAM_HKCU_KEY, 'RememberPassword');
        lines.push('RememberPassword (removed)');
      }
    }
    this.log.warn('backup restored', { id, files: restored.length, registry: lines.length });
    return { launcher: 'steam', id, files: restored, registry: lines };
  }

  // --- health ------------------------------------------------------------------

  async healthCheck(known?: KnownLauncherState): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    const add = (id: string, label: string, status: HealthStatus, detail: string): void => {
      checks.push({ id, label, status, detail });
    };
    const report = (): HealthReport => ({ launcher: 'steam', status: worst(checks), checks, checkedAt: new Date().toISOString() });

    const install = known ? known.install : await this.detectInstall();
    let seenRunning = known?.running ?? null;
    const isRunning = async (): Promise<boolean> => (seenRunning ??= await this.isRunning());
    const chosenGone = chosenFolderCheck(this.chosenInstallDir(), install, STEAM_EXE);
    if (!install) {
      add(
        'install',
        'Installation',
        'absent',
        `Steam is not installed on this PC. Checked ${SOURCE_LABEL['registry-hkcu']}, ${SOURCE_LABEL['registry-hklm']}, and ${this.defaultDir}.`,
      );
      if (chosenGone) checks.push(chosenGone);
      return { ...report(), status: 'absent' };
    }
    add('install', 'Installation', 'ok', `${install.installDir} (from ${SOURCE_LABEL[install.source]})`);
    if (chosenGone) checks.push(chosenGone);

    try {
      add('process', 'Process', 'ok', (await isRunning()) ? 'steam.exe is running' : 'steam.exe is not running');
    } catch (err) {
      add('process', 'Process', 'warn', `Could not query the process list: ${errorText(err)}`);
    }

    let users: SteamLoginUser[] = [];
    const loginUsersPath = this.loginUsersPath(install);
    if (!existsSync(loginUsersPath)) {
      add(
        'loginusers',
        'Remembered accounts',
        'warn',
        `${loginUsersPath} not found. Steam has not signed in on this PC yet, so only the credentials switch path is available.`,
      );
    } else {
      try {
        users = parseLoginUsers(readLauncherText(loginUsersPath, MAX_VDF_BYTES));
        const remembered = users.filter((u) => u.rememberPassword).length;
        add('loginusers', 'Remembered accounts', 'ok', `${plural(users.length, 'account')} in loginusers.vdf, ${remembered} with a remembered session`);
        const keys = [...new Set(users.flatMap((u) => u.mostRecentKeys))];
        const mostRecent = users.filter((u) => u.mostRecent).length;
        if (users.length > 0 && keys.length === 0) {
          add('most-recent-key', 'Most-recent marker', 'warn', 'Neither AutoLogin nor MostRecent appears in loginusers.vdf. A switch will add AutoLogin.');
        } else if (users.length > 0) {
          add(
            'most-recent-key',
            'Most-recent marker',
            mostRecent > 1 ? 'warn' : 'ok',
            `File uses ${keys.join(' and ')}; ${plural(mostRecent, 'account')} marked most recent${mostRecent > 1 ? ' (expected one)' : ''}`,
          );
        }
      } catch (err) {
        add('loginusers', 'Remembered accounts', 'fail', `Could not parse ${loginUsersPath}: ${errorText(err)}`);
      }
    }

    try {
      const autoLoginUser = await this.deps.registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser');
      if (autoLoginUser === null) {
        add(
          'registry',
          'Registry AutoLoginUser',
          'warn',
          `${SOURCE_LABEL['registry-hkcu'].replace('SteamPath', 'AutoLoginUser')} is absent. Steam will ask which account to use on next start.`,
        );
      } else {
        const mostRecent = users.find((u) => u.mostRecent);
        const agrees = !mostRecent || mostRecent.accountName.toLowerCase() === autoLoginUser.toLowerCase();
        add(
          'registry',
          'Registry AutoLoginUser',
          agrees ? 'ok' : 'warn',
          agrees
            ? 'Present and matches the most recent account in loginusers.vdf'
            : 'Present but names a different account than loginusers.vdf marks as most recent',
        );
      }
    } catch (err) {
      add('registry', 'Registry AutoLoginUser', 'warn', `Could not read the registry: ${errorText(err)}`);
    }

    const libraryFoldersPath = this.libraryFoldersPath(install);
    if (!existsSync(libraryFoldersPath)) {
      add('libraries', 'Library folders', 'warn', `${libraryFoldersPath} not found. Only the main Steam folder will be scanned.`);
    } else {
      const { folders, error } = this.libraryFolders(install);
      if (error) {
        add('libraries', 'Library folders', 'fail', error);
      } else {
        const missing = folders.filter((f) => !existsSync(join(f, 'steamapps')));
        add(
          'libraries',
          'Library folders',
          missing.length > 0 ? 'warn' : 'ok',
          `${plural(folders.length, 'library folder')}${missing.length > 0 ? `; missing steamapps in: ${missing.join(', ')}` : ''}`,
        );
      }
    }

    try {
      const games = await this.listInstalledGames();
      const updates = games.filter((g) => g.needsUpdate).length;
      add('games', 'Installed games', 'ok', `${plural(games.length, 'installed game')}${updates > 0 ? ` (${updates} waiting for an update)` : ''}`);
    } catch (err) {
      add('games', 'Installed games', 'fail', `Could not scan the library: ${errorText(err)}`);
    }

    const snapshots = this.deps.backups.list('steam').length;
    add('backups', 'Backups', 'ok', snapshots === 0 ? 'No snapshots yet' : `${plural(snapshots, 'snapshot')} available for restore`);

    return report();
  }
}

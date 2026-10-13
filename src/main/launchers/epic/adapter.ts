/**
 * Epic Games Launcher adapter (findings in docs/adapters/epic.md).
 *
 * Epic has no account list and no sign-in flag. It signs in from the remembered session in
 * [RememberMe] of GameUserSettings.ini, so a switch swaps that section (plus [Offline]) for the
 * target account's stored snapshot, restarts the launcher, and confirms the sign-in from the
 * launcher's own log. The only launcher file ever written is GameUserSettings.ini; there are no
 * registry writes. Every write is preceded by a backup snapshot and undone from it on failure.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  EpicLaunchUriForm,
  HealthCheck,
  HealthReport,
  HealthStatus,
  InstalledGame,
  JobStep,
  JobStepStatus,
  LaunchAttention,
  LauncherInstall,
  LauncherSession,
  LauncherSessionState,
  RestoreResult,
  RunningGame,
  SwitchChange,
  SwitchPlan,
  SwitchPlanStep,
  SwitchStrategy,
} from '@shared/models';
import { normalizeLauncherPath } from '../../platform/fs-path';
import type { ProcessController } from '../../platform/processes';
import type { RegistryReader } from '../../platform/registry';
import { writeFileAtomic, type BackupService } from '../../services/backup';
import type { Logger } from '../../services/logger';
import { isRefusal, refusalCode } from '../../services/refusals';
import type { LauncherSessionStore } from '../../services/sessions';
import {
  ConfirmationRequiredError,
  LauncherFileError,
  LauncherNotInstalledError,
  LauncherRunningError,
  SwitchBlockedError,
  type AccountDirectory,
  type AccountRef,
  type KnownLauncherState,
  type LauncherAdapter,
  type RememberedAccountEntry,
  type SwitchOptions,
  type SwitchPreflight,
  type SwitchResult,
} from '../types';
import { chosenFolder, chosenFolderCheck, isNamed } from '../chosen-folder';
import { readLauncherBytes, readLauncherText } from '../read-file';
import { gameWithRunningProcess } from '../running-game';
import { mergeTiming, sleep, SwitchAbortedError, waitUntil } from '../wait';
import { sectionNames } from './ini';
import {
  announcedRestart,
  eventsSince,
  isSessionRejection,
  lastSignIn,
  lastSignInInLog,
  launcherLogPath,
  logMark,
  startupFinished,
  type LogMark,
  type SignInOutcome,
} from './launcher-log';
import { isLibraryGame, ITEM_FILE, launchUri, parseItemManifest, parseLauncherInstalled, type EpicItemManifest } from './manifests';
import {
  fingerprintOf,
  parseBlob,
  planSessionWrite,
  readSessionFromIni,
  serializeBlob,
  sessionBlobFromIni,
  shortFingerprint,
  type EpicSessionBlob,
  type EpicSessionOnDisk,
} from './session';

export const EPIC_EXE = 'EpicGamesLauncher.exe';
export const EPIC_HKLM_KEY = 'SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher';
export const EPIC_UNINSTALL_KEY = 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{AEB35C6C-B6D4-4AA0-8452-DE699737B5F6}';
export const EPIC_URI_COMMAND_KEY = 'SOFTWARE\\Classes\\com.epicgames.launcher\\shell\\open\\command';
export const DEFAULT_EPIC_DIR = 'C:\\Program Files (x86)\\Epic Games\\Launcher';
export const EPIC_EXE_RELATIVE = join('Portal', 'Binaries', 'Win64', EPIC_EXE);
/**
 * The launcher's settings file lives under Saved\Config\<platform>\. It used Windows for years, then
 * switched to WindowsEditor on this machine on 2026-09-12 and kept using it, so every folder that
 * has a file is treated as the settings file: the newest is read, all are backed up and written.
 */
export const SETTINGS_FOLDERS = ['Windows', 'WindowsEditor'] as const;
export const SETTINGS_INI_RELATIVE = join('EpicGamesLauncher', 'Saved', 'Config', 'Windows', 'GameUserSettings.ini');
export const DISPLAY_NAME = 'Epic Games Launcher';
/** Why a snapshot is pinned (see BackupService). Shown in Settings › Backups. */
export const UNOWNED_SESSION_PIN = 'Holds a sign-in that no One Launch account owns';

/** Plan step ids. The real switch reports progress against these. */
export const STEP = {
  close: 'close',
  capture: 'capture',
  backup: 'backup',
  file: 'file',
  start: 'start',
  wait: 'wait',
  verify: 'verify',
  manual: 'manual',
  recapture: 'recapture',
} as const;

const DEFAULT_TIMING = {
  pollMs: 500,
  /** The waits that read the log or the settings file, not the process list: each poll is cheap, so they look more often. */
  logPollMs: 250,
  /** The launcher exits on a window close when "minimise to tray" is off; otherwise a forced kill follows. */
  shutdownMs: 20_000,
  killGraceMs: 10_000,
  /**
   * After exiting, the launcher may hand off to EpicGamesUpdater.exe and come straight back
   * (seen 2026-09-13). How long to watch for that before treating the launcher as closed.
   */
  restartWatchMs: 8_000,
  /** The same watch when the launcher's log shows it closed its log file without announcing a restart. */
  cleanExitWatchMs: 1_500,
  /** How long a restarted launcher gets to finish starting before it is closed again. */
  restartSettleMs: 45_000,
  startupMs: 60_000,
  /** Auto sign-in lands about a second after start, but a self-update restart can come first. */
  signInMs: 45_000,
  /** How long the user gets to sign in by hand on the launcher's page. */
  manualSignInMs: 600_000,
  /** How long to wait for the launcher to write the fresh [RememberMe] after a manual sign-in. */
  captureMs: 15_000,
  /** Breathing room between the confirmed sign-in and the launch URI. */
  readyGraceMs: 2_000,
};

const ACCOUNT_SECTION = /^([0-9a-f]{32})_/i;

export type EpicAccountDirectory = AccountDirectory;

export interface EpicAdapterDeps {
  registry: RegistryReader;
  processes: ProcessController;
  backups: BackupService;
  sessions: LauncherSessionStore;
  accounts: EpicAccountDirectory;
  log: Logger;
  backupsToKeep: () => number;
  /** shell.openExternal in the app; a recorder in tests. */
  openExternal: (url: string) => Promise<void>;
  launchUriForm: () => EpicLaunchUriForm;
  /** %LOCALAPPDATA% by default. Overridable for tests. */
  localAppData?: string;
  /** %ProgramData% by default. Overridable for tests. */
  programData?: string;
  /** The epic.path setting: the folder the user chose with Locate, tried before the registry. */
  installDir?: () => string | null;
  /** Last-resort install location. Overridable for tests. */
  defaultInstallDir?: string;
  timing?: Partial<typeof DEFAULT_TIMING>;
}

function sourceLabel(source: LauncherInstall['source']): string {
  return source === 'user' ? 'the folder chosen in Settings' : source === 'default-path' ? 'default location' : 'HKLM';
}

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

/** The tail of an account id, enough to tell ids apart in text without spelling one out. */
function idTail(uid: string | null, length = 6): string {
  return uid ? `…${uid.slice(-length)}` : '(unknown id)';
}

/** Who the current session belongs to, and how we know. */
interface CurrentSession {
  disk: EpicSessionOnDisk;
  /**
   * The One Launch account that owns it. While the launcher runs, its own log decides (the file
   * can lag behind a manual sign-in); when it is closed, the file's fingerprint decides, then the
   * last run's log.
   */
  owner: AccountRef | null;
  /** The Epic account id of the launcher's last successful sign-in in its current log. */
  loggedUid: string | null;
  lastSignIn: SignInOutcome | null;
  /** The launcher wrote the file after its last sign-in, so the file reflects that sign-in. */
  diskCurrent: boolean;
  running: boolean;
}

interface PlanContext {
  install: LauncherInstall;
  iniPath: string;
  iniText: string | null;
  current: CurrentSession;
  stored: LauncherSession | null;
  strategy: SwitchStrategy;
  /** The session on disk already belongs to the target account. */
  inPlace: boolean;
  alreadyActive: boolean;
  running: boolean;
}

type SignInWait =
  | { kind: 'signed-in'; accountId: string }
  | { kind: 'wrong-account'; accountId: string; owner: AccountRef | null }
  | { kind: 'failed'; reason: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

function attentionFor(login: string, cause: 'expired' | 'new' | 'other', reason: string | null, canCopyPassword: boolean, until: string): LaunchAttention {
  const finish =
    'One Launch stores the session and continues with the game on its own as soon as the launcher reports the sign-in. Later switches are automatic.';
  const why =
    cause === 'expired'
      ? 'Its remembered session has expired.'
      : cause === 'new'
        ? 'No session is stored for this account yet.'
        : `The launcher did not sign in on its own${reason ? ` (${reason})` : ''}.`;
  return {
    kind: 'sign-in',
    title: cause === 'new' ? `Sign in to Epic Games Launcher as ${login}` : `Epic Games Launcher is asking you to sign in as ${login}`,
    message: `${why} Sign in once in the launcher window. ${finish}`,
    reason,
    canCopyPassword,
    until,
  };
}

export class EpicAdapter implements LauncherAdapter {
  readonly id = 'epic' as const;
  readonly displayName = 'Epic Games';

  private readonly log: Logger;
  private readonly localAppData: string;
  private readonly programData: string;
  private readonly defaultDir: string;
  private readonly timing: typeof DEFAULT_TIMING;

  constructor(private readonly deps: EpicAdapterDeps) {
    this.log = deps.log;
    this.localAppData = deps.localAppData ?? process.env['LOCALAPPDATA'] ?? join(process.env['USERPROFILE'] ?? 'C:\\', 'AppData', 'Local');
    this.programData = deps.programData ?? process.env['ProgramData'] ?? 'C:\\ProgramData';
    this.defaultDir = deps.defaultInstallDir ?? DEFAULT_EPIC_DIR;
    this.timing = mergeTiming(DEFAULT_TIMING, deps.timing);
  }

  // --- paths -----------------------------------------------------------------

  private settingsPathIn(folder: string): string {
    return join(this.localAppData, 'EpicGamesLauncher', 'Saved', 'Config', folder, 'GameUserSettings.ini');
  }

  /** Every settings file that exists, newest first. */
  settingsPaths(): string[] {
    const found: { path: string; mtime: number; order: number }[] = [];
    SETTINGS_FOLDERS.forEach((folder, order) => {
      const path = this.settingsPathIn(folder);
      try {
        found.push({ path, mtime: statSync(path).mtimeMs, order });
      } catch {
        // absent
      }
    });
    // Written within the same couple of seconds (a restore, say): the later platform folder wins.
    return found.sort((a, b) => (Math.abs(a.mtime - b.mtime) < 2_000 ? b.order - a.order : b.mtime - a.mtime)).map((f) => f.path);
  }

  /** The settings file the launcher is using: the most recently written one, else the classic location. */
  settingsPath(): string {
    return this.settingsPaths()[0] ?? this.settingsPathIn(SETTINGS_FOLDERS[0]);
  }

  private settingsRelative(path: string): string {
    const folder = SETTINGS_FOLDERS.find((f) => path.toLowerCase().endsWith(join('config', f, 'gameusersettings.ini').toLowerCase())) ?? 'Windows';
    return `Config/${folder}/GameUserSettings.ini`;
  }

  logPath(): string {
    return launcherLogPath(this.localAppData);
  }

  launcherInstalledPath(): string {
    return join(this.programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
  }

  async manifestsDir(): Promise<string> {
    const raw = await this.deps.registry.getString('HKLM', EPIC_HKLM_KEY, 'AppDataPath');
    const dataDir = raw && raw.trim() ? normalizeLauncherPath(raw) : join(this.programData, 'Epic', 'EpicGamesLauncher', 'Data');
    return join(dataDir, 'Manifests');
  }

  // --- detection -------------------------------------------------------------

  async detectInstall(): Promise<LauncherInstall | null> {
    const { registry } = this.deps;
    const chosen = this.chosenInstallDir();
    const fromChosen = chosen ? this.installAt(chosen, 'user') : null;
    if (fromChosen) return fromChosen;
    const uninstall = await registry.getString('HKLM', EPIC_UNINSTALL_KEY, 'InstallLocation');
    if (uninstall && uninstall.trim()) {
      const fromUninstall = this.installAt(join(normalizeLauncherPath(uninstall), 'Launcher'), 'registry-hklm');
      if (fromUninstall) return fromUninstall;
    }
    const command = await registry.getString('HKLM', EPIC_URI_COMMAND_KEY, '');
    const exe = command ? /^"([^"]+)"/.exec(command)?.[1] : undefined;
    if (exe) {
      const fromHandler = this.installAt(resolve(normalizeLauncherPath(exe), '..', '..', '..', '..'), 'registry-hklm');
      if (fromHandler) return fromHandler;
    }
    return this.installAt(this.defaultDir, 'default-path');
  }

  chosenInstallDir(): string | null {
    return chosenFolder(this.deps.installDir);
  }

  /** The executable sits four folders down (Portal\Binaries\Win64, or Win32 on old installs), as in the URI handler's command. */
  installFromExe(exePath: string): LauncherInstall | null {
    const exe = normalizeLauncherPath(exePath);
    return isNamed(exe, [EPIC_EXE]) ? this.installAt(resolve(exe, '..', '..', '..', '..'), 'user') : null;
  }

  private installAt(installDir: string, source: LauncherInstall['source']): LauncherInstall | null {
    const exePath = join(installDir, EPIC_EXE_RELATIVE);
    if (!existsSync(exePath)) {
      this.log.debug('no EpicGamesLauncher.exe at candidate location', { source, installDir });
      return null;
    }
    return { launcher: 'epic', installDir, exePath, source };
  }

  private async requireInstall(): Promise<LauncherInstall> {
    const install = await this.detectInstall();
    if (!install) throw new LauncherNotInstalledError('epic');
    return install;
  }

  // --- library ---------------------------------------------------------------

  private async readManifests(): Promise<{ dir: string; manifests: EpicItemManifest[]; unreadable: number }> {
    const dir = await this.manifestsDir();
    const manifests: EpicItemManifest[] = [];
    let unreadable = 0;
    if (!existsSync(dir)) {
      this.log.warn('Epic manifests folder not found', { dir });
      return { dir, manifests, unreadable };
    }
    for (const name of readdirSync(dir)) {
      if (!ITEM_FILE.test(name)) continue;
      const file = join(dir, name);
      try {
        manifests.push(parseItemManifest(readLauncherText(file)));
      } catch (err) {
        unreadable++;
        this.log.warn('skipping unreadable .item manifest', { file, error: errorText(err) });
      }
    }
    return { dir, manifests, unreadable };
  }

  async listInstalledGames(): Promise<InstalledGame[]> {
    await this.requireInstall();
    const { manifests } = await this.readManifests();
    const games: InstalledGame[] = [];
    const seen = new Set<string>();
    for (const m of manifests) {
      if (!isLibraryGame(m) || seen.has(m.appName)) continue;
      seen.add(m.appName);
      games.push({
        launcher: 'epic',
        launcherGameId: m.appName,
        name: m.displayName,
        installPath: m.installLocation,
        libraryPath: dirname(m.installLocation),
        sizeOnDiskBytes: m.installSize,
        lastPlayedAt: null,
        needsUpdate: false,
      });
    }
    return games.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  // --- session state ---------------------------------------------------------

  /**
   * The file as UTF-8 text. Unreal switches a config file to UTF-16 once a non-ASCII character lands
   * in it; such a file would parse as empty and a rewrite would corrupt it, so it is refused instead.
   */
  private readIni(): string | null {
    const file = this.settingsPath();
    if (!existsSync(file)) return null;
    let bytes: Buffer;
    try {
      bytes = readLauncherBytes(file);
    } catch (err) {
      if (err instanceof LauncherFileError) throw err;
      throw new LauncherFileError(file, `Could not read GameUserSettings.ini (${errorText(err)})`);
    }
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff) || bytes.includes(0)) {
      throw new LauncherFileError(file, 'GameUserSettings.ini is not UTF-8 (UTF-16 or binary content); One Launch will not rewrite it');
    }
    return bytes.toString('utf8');
  }

  private iniWrittenAt(): number | null {
    try {
      return statSync(this.settingsPath()).mtimeMs;
    } catch {
      return null;
    }
  }

  /** What is on disk now and whose it is. Reads the INI and the launcher log; writes nothing. */
  private currentSession(iniText: string | null, running: boolean): CurrentSession {
    const disk: EpicSessionOnDisk =
      iniText === null ? { remembered: false, enable: null, data: null, offlineData: null, fingerprint: null } : readSessionFromIni(iniText);
    const last = lastSignInInLog(this.logPath());
    const loggedUid = last?.ok && last.accountId ? last.accountId : null;
    const byLog = loggedUid ? this.deps.accounts.byLauncherUid(loggedUid) : null;
    const writtenAt = this.iniWrittenAt();
    const signedInAt = last?.ok && last.at ? Date.parse(last.at) : null;
    const diskCurrent = iniText !== null && (signedInAt === null || writtenAt === null || writtenAt >= signedInAt);
    let owner: AccountRef | null = null;
    if (running) {
      owner = byLog;
    } else if (disk.remembered && disk.fingerprint) {
      const stored = this.deps.sessions.findByFingerprint('epic', disk.fingerprint);
      if (stored) owner = this.deps.accounts.byId(stored.accountId);
      if (!owner && diskCurrent) owner = byLog;
    }
    return { disk, owner, loggedUid, lastSignIn: last, diskCurrent, running };
  }

  async sessionState(): Promise<LauncherSessionState> {
    const running = await this.isRunning();
    const current = this.currentSession(this.readIni(), running);
    return {
      launcher: 'epic',
      remembered: current.disk.remembered,
      fingerprint: current.disk.remembered ? current.disk.fingerprint : null,
      launcherUid: running ? current.loggedUid : current.disk.remembered ? (current.owner?.launcherUid ?? current.loggedUid) : null,
      linkedAccountId: current.owner?.id ?? null,
      launcherRunning: running,
      lastSignIn: current.lastSignIn ? { ok: current.lastSignIn.ok, reason: current.lastSignIn.ok ? null : current.lastSignIn.reason } : null,
    };
  }

  async captureSession(account: AccountRef): Promise<{ session: LauncherSession; launcherUid: string | null }> {
    if (!account.id) throw new SwitchBlockedError('Save the account first, then capture its session.');
    await this.requireInstall();
    const running = await this.isRunning();
    const text = this.readIni();
    const current = this.currentSession(text, running);
    const blob = text ? sessionBlobFromIni(text) : null;
    if (!blob || !current.disk.remembered) {
      throw new SwitchBlockedError(
        `Epic Games Launcher is not remembering a session right now. Sign in to it as ${account.login}, exit it once so it saves the session, then capture again.`,
      );
    }
    if (running) {
      // The file can hold a session the running launcher is not using: only its own log says who is signed in.
      if (!current.lastSignIn?.ok || !current.loggedUid) {
        throw new SwitchBlockedError(
          `Epic Games Launcher is running but has not signed in during this run${current.lastSignIn && !current.lastSignIn.ok ? ` (${current.lastSignIn.reason})` : ''}. Sign in to it as ${account.login}, then capture again.`,
        );
      }
      if (!current.diskCurrent) {
        throw new SwitchBlockedError(
          `Epic Games Launcher has not saved its current sign-in to disk yet. Exit the launcher (it writes the session on exit), then capture again.`,
        );
      }
    }
    if (current.owner && current.owner.id !== account.id) {
      throw new SwitchBlockedError(
        `The session Epic Games Launcher currently remembers belongs to ${current.owner.displayName}. Sign in to the launcher as ${account.login} first.`,
      );
    }
    const uid = running ? current.loggedUid : (current.owner?.launcherUid ?? current.loggedUid);
    if (uid && account.launcherUid && uid.toLowerCase() !== account.launcherUid.toLowerCase()) {
      throw new SwitchBlockedError(
        `The launcher's last sign-in was Epic account ${idTail(uid)}, but ${account.displayName} is linked to ${idTail(account.launcherUid)}. Check the launcher account ID on the account page.`,
      );
    }
    return this.storeSession({ ...account, id: account.id }, blob, uid ?? account.launcherUid);
  }

  /**
   * Records the Epic id on the account, then encrypts and stores the blob for it. The link comes
   * first and throws when another account holds the id, so no session is ever stored under an id
   * the link was refused for. Never logs the blob.
   */
  private storeSession(
    account: AccountRef & { id: string },
    blob: EpicSessionBlob,
    uid: string | null,
  ): { session: LauncherSession; launcherUid: string | null } {
    if (uid && (!account.launcherUid || account.launcherUid.toLowerCase() !== uid.toLowerCase())) {
      this.deps.accounts.setLauncherUid(account.id, uid);
    }
    const session = this.deps.sessions.save({
      accountId: account.id,
      launcher: 'epic',
      launcherUid: uid,
      fingerprint: fingerprintOf(blob.rememberMe.data),
      blob: serializeBlob(blob),
    });
    this.log.info('epic session stored', { accountId: account.id, fingerprint: shortFingerprint(session.fingerprint), hasOffline: blob.offline !== null });
    return { session, launcherUid: uid };
  }

  // --- accounts --------------------------------------------------------------

  /** Every account that has signed in on this PC has [<id>_*] sections; only the current session is remembered. */
  async listRememberedAccounts(): Promise<RememberedAccountEntry[]> {
    await this.requireInstall();
    const text = this.readIni();
    if (text === null) return [];
    const ids: string[] = [];
    for (const name of sectionNames(text)) {
      const m = ACCOUNT_SECTION.exec(name);
      if (m && !ids.includes(m[1]!.toLowerCase())) ids.push(m[1]!.toLowerCase());
    }
    const current = this.currentSession(text, await this.isRunning());
    const activeUid = current.disk.remembered ? (current.owner?.launcherUid ?? current.loggedUid)?.toLowerCase() : undefined;
    return ids
      .map((uid): RememberedAccountEntry => {
        const linked = this.deps.accounts.byLauncherUid(uid);
        return {
          launcher: 'epic',
          launcherUid: uid,
          login: linked?.login ?? '',
          personaName: linked?.displayName ?? '',
          rememberPassword: uid === activeUid,
          mostRecent: uid === activeUid,
          lastLoginAt: null,
          sessionMayBeExpired: false,
        };
      })
      .sort((a, b) => Number(b.mostRecent) - Number(a.mostRecent));
  }

  // --- process ---------------------------------------------------------------

  async isRunning(): Promise<boolean> {
    return this.deps.processes.isRunning(EPIC_EXE);
  }

  /** Epic keeps no "running app" flag; a process running out of a game's install folder counts. */
  async runningGame(): Promise<RunningGame | null> {
    const install = await this.detectInstall();
    if (!install) return null;
    let procs;
    try {
      procs = await this.deps.processes.listProcesses();
    } catch (err) {
      this.log.warn('could not list processes for game detection', { error: errorText(err) });
      return null;
    }
    if (procs.length === 0) return null;
    const game = await gameWithRunningProcess(procs, await this.listInstalledGames());
    return game ? { launcher: 'epic', launcherGameId: game.launcherGameId, name: game.name, source: 'process' } : null;
  }

  private waitUntil(cond: () => Promise<boolean>, timeoutMs: number, signal?: AbortSignal, pollMs = this.timing.pollMs): Promise<boolean> {
    return waitUntil(cond, { timeoutMs, pollMs, signal });
  }

  /**
   * Window close, wait, then a forced kill of its tree. On exit the launcher may hand off
   * to EpicGamesUpdater.exe and start again (a staged self-update, seen 2026-09-13); that instance is
   * given time to finish starting and is then closed the same way, so it is never killed while it
   * is still writing its files. Throws if the launcher is still running afterwards, or
   * SwitchAbortedError when the signal aborts a wait.
   */
  async shutdown(opts: { timeoutMs?: number; signal?: AbortSignal | undefined } = {}): Promise<void> {
    await this.requireInstall();
    if (!(await this.isRunning())) return;
    const timeoutMs = opts.timeoutMs ?? this.timing.shutdownMs;
    const { signal } = opts;
    const logPath = this.logPath();
    for (let attempt = 1; ; attempt++) {
      const mark = logMark(logPath);
      this.log.info('asking Epic Games Launcher to close', { timeoutMs, attempt });
      await this.deps.processes.close(EPIC_EXE);
      if (!(await this.waitUntil(async () => !(await this.isRunning()), timeoutMs, signal))) {
        this.log.warn('Epic Games Launcher did not exit in time; killing it');
        await this.deps.processes.kill(EPIC_EXE);
        if (!(await this.waitUntil(async () => !(await this.isRunning()), this.timing.killGraceMs, signal))) {
          throw new Error(`${EPIC_EXE} is still running after a window close and a forced close`);
        }
      }
      const events = eventsSince(logPath, mark);
      const restarting = announcedRestart(events);
      // The launcher logs a restart after "Engine exit requested" and before its process ends, so with the process gone a clean log without one needs only a short look.
      const cleanExit = !restarting && events.some((e) => e.kind === 'exit');
      const watchMs = restarting ? this.timing.restartSettleMs : cleanExit ? this.timing.cleanExitWatchMs : this.timing.restartWatchMs;
      if (!(await this.waitUntil(() => this.isRunning(), watchMs, signal))) return;
      if (attempt >= 3) throw new Error(`${EPIC_EXE} keeps restarting itself after being closed`);
      this.log.info('Epic Games Launcher restarted itself after closing; letting it finish starting before closing it again', { announced: restarting });
      await this.waitUntil(
        async () => logMark(logPath).opened !== mark.opened && startupFinished(eventsSince(logPath, { size: 0, opened: null })),
        this.timing.restartSettleMs,
        signal,
      );
    }
  }

  async launchGame(game: { launcherGameId: string; name: string }): Promise<{ command: string }> {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(game.launcherGameId)) throw new Error(`Not an Epic app name: ${game.launcherGameId}`);
    const { manifests } = await this.readManifests();
    const manifest = manifests.find((m) => m.appName === game.launcherGameId) ?? { appName: game.launcherGameId, catalogNamespace: null, catalogItemId: null };
    const url = launchUri(manifest, this.deps.launchUriForm());
    this.log.info('launching game', { appName: game.launcherGameId, name: game.name, form: this.deps.launchUriForm() });
    await this.deps.openExternal(url);
    return { command: url };
  }

  // --- switching -------------------------------------------------------------

  /** What a close does, for the confirmation: a game started from the launcher closes with it. */
  private closeMessage(game: RunningGame | null): string {
    return game
      ? `Epic Games Launcher is running ${game.name}. Switching closes the launcher and the game; unsaved progress in the game is lost.`
      : 'Epic Games Launcher is running. Switching closes it.';
  }

  async preflight(account: AccountRef): Promise<SwitchPreflight> {
    const { plan, ctx } = await this.buildSwitchPlan(account);
    const runningGame = ctx.running && !ctx.alreadyActive ? await this.runningGame() : null;
    return { plan, launcherRunning: ctx.running, runningGame, alreadyActive: ctx.alreadyActive, closeMessage: this.closeMessage(runningGame) };
  }

  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: true }): Promise<SwitchPlan>;
  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: false }): Promise<SwitchResult>;
  switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult>;
  async switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult> {
    if (opts.dryRun) return (await this.buildSwitchPlan(account)).plan;
    return this.runSwitch(account, opts);
  }

  /** Reads everything the real switch would read and describes every change it would make. Decrypts nothing. */
  private async buildSwitchPlan(account: AccountRef): Promise<{ plan: SwitchPlan; ctx: PlanContext }> {
    const install = await this.requireInstall();
    const iniPath = this.settingsPath();
    const iniPaths = this.settingsPaths();
    const iniTargets = iniPaths.length > 0 ? iniPaths.join(' and ') : iniPath;
    const logPath = this.logPath();
    const running = await this.isRunning();
    const iniText = this.readIni();
    const current = this.currentSession(iniText, running);
    const stored = account.id ? this.deps.sessions.get(account.id) : null;
    const warnings: string[] = [];
    const notes: string[] = [];

    /**
     * Running: the launcher's own log says it is signed in as this account (the file may lag behind).
     * Closed: the file holds this account's session, so the next start signs in as it.
     */
    const inPlace = current.owner !== null && current.owner.id === account.id && (running || current.disk.remembered);
    const strategy: SwitchStrategy = inPlace || (stored !== null && stored.staleReason === null) ? 'remembered' : 'credentials';
    const alreadyActive = inPlace && running;
    const usesStored = strategy === 'remembered' && !inPlace;
    const login = account.login;
    const expectedUid = stored?.launcherUid ?? account.launcherUid ?? null;

    const steps: SwitchPlanStep[] = [];
    const step = (s: Omit<SwitchPlanStep, 'changes' | 'skipped'> & Partial<Pick<SwitchPlanStep, 'changes' | 'skipped'>>): void => {
      steps.push({ changes: [], skipped: false, ...s });
    };

    step({
      id: STEP.close,
      kind: 'process',
      title: 'Close Epic Games Launcher',
      target: EPIC_EXE,
      skipped: !running || alreadyActive,
      detail: alreadyActive
        ? 'Skipped: the launcher is already signed in as this account, so it is left running.'
        : running
          ? `Send ${EPIC_EXE} a window close (the launcher exits unless "minimise to tray" is on) and wait up to ${this.timing.shutdownMs / 1000} s. If it is still running after that, force-close ${EPIC_EXE} and every process it started. Any game running under the launcher closes with it.`
          : `Skipped: ${EPIC_EXE} is not running.`,
    });

    const outgoing = current.owner;
    const outgoingStored = outgoing?.id ? this.deps.sessions.get(outgoing.id) : null;
    const outgoingChanged = outgoing !== null && outgoingStored?.fingerprint !== current.disk.fingerprint;
    /**
     * Saving reads the launcher's file after it has closed (it writes the file on exit) and writes
     * only One Launch's own database. While the launcher is running the file is not trusted, so an
     * already-active account is not re-captured here.
     */
    const captureNeeded = outgoing !== null && !alreadyActive && (running || (current.disk.remembered && (!inPlace || outgoingChanged)));
    step({
      id: STEP.capture,
      kind: 'backup',
      title: inPlace ? "Save this account's session" : 'Save the outgoing session',
      target: iniPath,
      skipped: !captureNeeded,
      detail: alreadyActive
        ? 'Skipped: the launcher stays running, so its file is not re-read.'
        : outgoing === null
          ? current.disk.remembered
            ? `Skipped: the launcher remembers a session (fingerprint ${shortFingerprint(current.disk.fingerprint)}) that no One Launch account owns, so it is left alone and not saved. To keep it, capture it from that account's page before switching.`
            : 'Skipped: the launcher is not remembering any session.'
          : !captureNeeded
            ? `Skipped: ${outgoing.displayName}'s stored snapshot already matches what the launcher remembers.`
            : running
              ? `After the launcher has closed (it writes the file on exit), read [RememberMe] and, if it holds ${outgoing.displayName}'s session and it changed, store it, encrypted, as the account's snapshot. Nothing in the launcher's files changes.`
              : inPlace
                ? `[RememberMe] holds ${outgoing.displayName}'s session but it differs from the stored snapshot (${outgoingStored ? 'Epic rotated the token' : 'no snapshot yet'}), so store it, encrypted, as the account's snapshot. Nothing in the launcher's files changes.`
                : `[RememberMe] holds ${outgoing.displayName}'s session${outgoingChanged ? ' and it changed since it was last saved (Epic rotates tokens)' : ''}; store it, encrypted, as the account's snapshot if it changed. Nothing in the launcher's files changes.`,
    });

    step({
      id: STEP.backup,
      kind: 'backup',
      title: 'Back up GameUserSettings.ini',
      target: this.deps.backups.previewPath('epic'),
      skipped: alreadyActive || inPlace,
      detail:
        alreadyActive || inPlace
          ? 'Skipped: the file will not be modified.'
          : `Copy ${iniTargets} into a new snapshot folder so a failed switch can be rolled back. The newest ${this.deps.backupsToKeep()} snapshots are kept.`,
    });

    const before = (value: string | null): string =>
      value === null ? '(absent)' : `(${value.length} characters, fingerprint ${shortFingerprint(fingerprintOf(value))})`;
    if (inPlace) {
      step({
        id: STEP.file,
        kind: 'file',
        title: "Put the account's session in place",
        target: iniPath,
        skipped: true,
        detail: `No change: [RememberMe] already holds ${account.displayName}'s session (fingerprint ${shortFingerprint(current.disk.fingerprint)}).`,
      });
    } else if (usesStored && stored) {
      const changes: SwitchChange[] = [
        { where: '[RememberMe] Enable', before: current.disk.enable ?? '(absent)', after: 'True' },
        {
          where: '[RememberMe] Data',
          before: before(current.disk.data),
          after: `(stored snapshot, fingerprint ${shortFingerprint(stored.fingerprint)}, captured ${stored.capturedAt})`,
        },
        { where: '[Offline] Data', before: before(current.disk.offlineData), after: '(from the same snapshot, or removed when it has none)' },
      ];
      step({
        id: STEP.file,
        kind: 'file',
        title: "Put the account's session in place",
        target: iniTargets,
        detail: `Decrypt ${account.displayName}'s session snapshot from the vault and write it into [RememberMe] (Enable=True and Data) and [Offline] (Data) of ${iniPaths.length > 1 ? 'both settings files (the launcher reads one of them; writing both is harmless)' : 'GameUserSettings.ini'}. The new content is written to a temp file and renamed over the original. Every other line, including the per-account [<id>_*] sections, stays byte for byte. The blob itself is never shown or logged.`,
        changes,
      });
    } else {
      const signedOut = current.disk.data === null && current.disk.offlineData === null && current.disk.enable?.toLowerCase() === 'true';
      step({
        id: STEP.file,
        kind: 'file',
        title: 'Sign the launcher out',
        target: iniTargets,
        skipped: signedOut,
        detail: signedOut
          ? 'No change: the launcher is not remembering any session, so it will open on its sign-in page.'
          : `Remove Data from [RememberMe] and [Offline] and keep Enable=True, so the launcher opens on its sign-in page instead of signing in as ${
              outgoing ? outgoing.displayName : 'the previous account'
            } and remembers the next sign-in. Everything else in ${iniPaths.length > 1 ? 'both files' : 'the file'} is preserved.`,
        changes: signedOut
          ? []
          : [
              { where: '[RememberMe] Enable', before: current.disk.enable ?? '(absent)', after: 'True' },
              { where: '[RememberMe] Data', before: before(current.disk.data), after: '(removed)' },
              { where: '[Offline] Data', before: before(current.disk.offlineData), after: '(removed)' },
            ],
      });
    }

    step({
      id: STEP.start,
      kind: 'launch',
      title: 'Start Epic Games Launcher',
      target: `"${install.exePath}"`,
      skipped: alreadyActive && running,
      detail:
        alreadyActive && running
          ? 'Skipped: the launcher is already running as this account.'
          : strategy === 'remembered'
            ? `Start the launcher normally (no arguments, as the com.epicgames.launcher:// handler does). It signs in as ${login} on its own from [RememberMe].`
            : 'Start the launcher normally. With no remembered session it opens on its sign-in page.',
    });

    step({
      id: STEP.wait,
      kind: 'wait',
      title: 'Wait for the launcher to come up',
      target: EPIC_EXE,
      skipped: alreadyActive && running,
      detail: `Poll the process list until ${EPIC_EXE} is running, up to ${this.timing.startupMs / 1000} s.`,
    });

    step({
      id: STEP.verify,
      kind: 'wait',
      title: 'Confirm the launcher signed in',
      target: logPath,
      skipped: alreadyActive && running,
      detail:
        alreadyActive && running
          ? 'Skipped: the launcher is already signed in as this account.'
          : strategy === 'remembered'
            ? `Read what the launcher appends to its own log (no tokens in it) until FAccountService::OnLoginComplete reports TRUE with ${
                expectedUid ? `the Epic account id ${idTail(expectedUid)}` : 'an account id, which is then recorded on the account'
              }, up to ${this.timing.signInMs / 1000} s. A FALSE line means the launcher did not sign in and the next step hands over to you; when the reason is a refused token (for example TOKEN_EXPIRED) the snapshot is also marked stale.`
            : `Read what the launcher appends to its own log until FAccountService::OnLoginComplete reports TRUE${expectedUid ? ` with the Epic account id ${idTail(expectedUid)}` : ''}. The launcher will not sign in on its own, so this goes straight to the next step.`,
    });

    step({
      id: STEP.manual,
      kind: 'wait',
      title: 'Wait for you to sign in',
      target: logPath,
      skipped: strategy === 'remembered',
      detail:
        strategy === 'remembered'
          ? `Runs only if the launcher rejects the stored session (expired token) or does not sign in within ${this.timing.signInMs / 1000} s. The launcher stays open on its sign-in page; you sign in there once as ${login}${
              account.hasSecret ? ' (the password can be copied from One Launch)' : ''
            } and One Launch continues with the game as soon as the log reports the sign-in, up to ${this.timing.manualSignInMs / 60_000} min.`
          : `The launcher opens on its sign-in page. Sign in there as ${login}${
              account.hasSecret ? ' (the password can be copied from One Launch)' : ''
            }. One Launch continues with the game as soon as the log reports the sign-in, up to ${this.timing.manualSignInMs / 60_000} min. Signing in as a different Epic account than the one linked to ${account.displayName} ends the switch and rolls the file back.`,
    });

    step({
      id: STEP.recapture,
      kind: 'backup',
      title: 'Save the new session',
      target: iniPath,
      skipped: strategy === 'remembered',
      detail:
        strategy === 'remembered'
          ? 'Runs only after a manual sign-in: the fresh [RememberMe] replaces the stale snapshot.'
          : `Once the sign-in is reported, wait up to ${this.timing.captureMs / 1000} s for the launcher to write the new [RememberMe], then store it, encrypted, as ${account.displayName}'s session snapshot and record the Epic account id on the account. If the launcher writes it later, it is saved at the next switch instead. Later switches use the remembered path.`,
    });

    if (iniText === null) {
      warnings.push(
        `${iniPath} does not exist. One Launch never creates it: restore the newest Epic Games backup from Settings, or start the launcher once by hand so it writes its settings file.`,
      );
    } else if (current.disk.enable !== null && current.disk.enable.toLowerCase() !== 'true') {
      warnings.push(
        `[RememberMe] Enable is ${current.disk.enable} in ${iniPath}, so the launcher does not sign in on its own at start. The switch sets it back to True.`,
      );
    }
    if (alreadyActive) {
      notes.push(
        `Epic Games Launcher is running and signed in as ${account.displayName}. The real switch would change nothing and would leave the launcher running.`,
      );
    } else if (inPlace) {
      notes.push(`Epic Games Launcher already remembers ${account.displayName}'s session, so it is only started.`);
    } else if (running) {
      warnings.push(
        `Epic Games Launcher is running${current.owner ? ` as ${current.owner.displayName}` : current.loggedUid ? ' as an account not linked to One Launch' : ' on its sign-in page'}. It will be closed, along with any game running under it.`,
      );
    }
    if (running && inPlace === false && current.loggedUid && current.owner === null) {
      warnings.push(
        `The launcher's current sign-in (Epic account ${idTail(current.loggedUid)}) is not linked to any One Launch account, so it will not be saved.`,
      );
    }
    if (stored?.staleReason && !inPlace) {
      warnings.push(
        `The stored session for ${account.displayName} was rejected by the launcher (${stored.staleReason}). You will sign in once by hand and One Launch will store the fresh session.`,
      );
    }
    if (strategy === 'credentials' && !stored && !inPlace) {
      warnings.push(
        `No session snapshot is stored for ${account.displayName} yet. The launcher will open on its sign-in page; sign in once and One Launch captures the session for later switches.${
          account.hasSecret ? '' : ' No password is stored in One Launch, so have it ready.'
        }`,
      );
    }
    if (!inPlace && current.disk.remembered && outgoing === null) {
      warnings.push(
        `The launcher currently remembers a session that no One Launch account owns (fingerprint ${shortFingerprint(current.disk.fingerprint)}). It will be replaced. The backup taken before this switch keeps a copy and is left out of the usual clean-up, so restoring it from Settings › Backups brings that sign-in back.`,
      );
    }
    if (stored && account.launcherUid && stored.launcherUid && stored.launcherUid.toLowerCase() !== account.launcherUid.toLowerCase()) {
      warnings.push(
        `The Epic account id on this account (${idTail(account.launcherUid)}) differs from the one recorded with its session snapshot (${idTail(stored.launcherUid)}). The snapshot's id is used to confirm the sign-in.`,
      );
    }

    const plan: SwitchPlan = {
      launcher: 'epic',
      account: { id: account.id, displayName: account.displayName, login: account.login, launcherUid: expectedUid },
      strategy,
      current: { mostRecentLogin: current.owner?.login ?? null, autoLoginUser: null, running },
      steps,
      warnings,
      notes,
      executable: iniText !== null,
      generatedAt: new Date().toISOString(),
    };
    return { plan, ctx: { install, iniPath, iniText, current, stored, strategy, inPlace, alreadyActive, running } };
  }

  /**
   * The real switch. Order: close → save the outgoing session → snapshot → rewrite [RememberMe] and
   * [Offline] → start → confirm from the log. A rejected or missing session hands over to the user
   * for one manual sign-in, after which the fresh session is captured. Anything that fails after the
   * first modification is rolled back from the snapshot, with the launcher left closed.
   */
  private async runSwitch(account: AccountRef, opts: SwitchOptions): Promise<SwitchResult> {
    const startedAt = new Date().toISOString();
    const { plan, ctx } = await this.buildSwitchPlan(account);
    const { install, iniPath } = ctx;
    const login = account.login;
    const logPath = this.logPath();

    if (!plan.executable) throw new SwitchBlockedError(plan.warnings[0] ?? 'This switch cannot run.');
    if (ctx.running && !ctx.alreadyActive && !opts.confirmClose) {
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
    const result = (
      ok: boolean,
      extra: Pick<SwitchResult, 'backupId' | 'restored' | 'error' | 'needsSignIn' | 'cancelled'> & Partial<Pick<SwitchResult, 'readyAt'>>,
    ): SwitchResult => ({
      launcher: 'epic',
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

    let backupId: string | null = null;
    let modified = false;
    /** Once the launcher has been started again an abort no longer rolls back: the launcher is reading what was written. */
    let launcherStarted = false;
    let readyAt: string | null = null;
    let handedOver = false;
    const stopIfAborted = (): void => {
      if (opts.signal?.aborted) throw new SwitchAbortedError();
    };
    let expectedUid = plan.account.launcherUid?.toLowerCase() ?? null;
    /** Fingerprint of what we left in [RememberMe], so a launcher rewrite can be told apart from our own write. */
    let writtenFingerprint: string | null = ctx.current.disk.fingerprint;

    /** Runs once the launcher is closed: the file then reflects the last run, and its log names the account. */
    const saveOutgoing = (): void => {
      const i = index.get(STEP.capture);
      if (i === undefined || steps[i]!.status === 'skipped') return;
      mark(STEP.capture, 'running');
      try {
        const text = this.readIni();
        const fresh = text ? this.currentSession(text, false) : null;
        const blob = text ? sessionBlobFromIni(text) : null;
        const owner = fresh?.owner ?? null;
        if (!fresh || !blob || !fresh.disk.remembered) {
          mark(STEP.capture, 'done', 'The launcher left no remembered session behind (signed out).');
          return;
        }
        if (!owner || !owner.id) {
          mark(STEP.capture, 'done', 'The remembered session belongs to no One Launch account; left alone.');
          return;
        }
        if (!fresh.diskCurrent) {
          mark(STEP.capture, 'done', `The file predates the launcher's last sign-in, so it is not trusted as ${owner.displayName}'s session.`);
          return;
        }
        const known = this.deps.sessions.get(owner.id);
        if (known && known.fingerprint === fresh.disk.fingerprint) {
          mark(STEP.capture, 'done', `${owner.displayName}'s stored session is already current.`);
          return;
        }
        this.storeSession({ ...owner, id: owner.id }, blob, owner.launcherUid ?? fresh.loggedUid);
        mark(STEP.capture, 'done', `Saved ${owner.displayName}'s session (fingerprint ${shortFingerprint(fresh.disk.fingerprint)}).`);
      } catch (err) {
        // Best effort: a missed refresh costs one manual sign-in later, never the switch.
        this.log.warn('could not save the outgoing epic session', { error: errorText(err) });
        mark(STEP.capture, 'done', `Not saved: ${errorText(err)}`);
      }
    };
    const takeSnapshot = (): void => {
      mark(STEP.backup, 'running');
      // The launcher is closed by now, so the file is final: a remembered session nobody owns is about to be replaced, and this snapshot is its only copy.
      const unowned = !ctx.inPlace && this.holdsUnownedSession();
      const snapshot = this.deps.backups.snapshot({
        launcher: 'epic',
        reason: `Before switching to ${account.displayName}`,
        files: this.settingsPaths().map((source) => ({ source, relative: this.settingsRelative(source), sensitive: true })),
        ...(unowned ? { pinned: UNOWNED_SESSION_PIN } : {}),
      });
      backupId = snapshot.id;
      opts.onBackup?.(snapshot.id);
      mark(STEP.backup, 'done', snapshot.path);
    };
    /** The stored blob is decrypted here and nowhere else, written once, and dropped. */
    const writeSession = (): void => {
      mark(STEP.file, 'running');
      const paths = this.settingsPaths();
      // Never fabricate the launcher's settings file: a two-section file loses every per-account setting
      // and the launcher does not sign in from it (seen 2026-09-13).
      if (paths.length === 0) {
        throw new SwitchBlockedError(
          `${iniPath} is missing. Restore the newest Epic Games backup from Settings, or start the launcher once by hand, then try again.`,
        );
      }
      let blob: EpicSessionBlob | null = null;
      if (plan.strategy === 'remembered' && account.id) {
        const json = this.deps.sessions.decrypt(account.id);
        if (!json) throw new SwitchBlockedError(`No session snapshot is stored for ${account.displayName}.`);
        blob = parseBlob(json);
      }
      let written = 0;
      for (const path of paths) {
        const write = planSessionWrite(readFileSync(path, 'utf8'), blob);
        if (write.noop) continue;
        modified = true;
        writeFileAtomic(path, write.text);
        written++;
      }
      writtenFingerprint = blob ? fingerprintOf(blob.rememberMe.data) : null;
      if (written === 0) {
        mark(STEP.file, 'skipped', blob ? 'Already in place.' : 'Already signed out.');
        return;
      }
      mark(
        STEP.file,
        'done',
        `${blob ? `[RememberMe] now holds the snapshot (fingerprint ${shortFingerprint(writtenFingerprint)})` : '[RememberMe] cleared'} in ${plural(written, 'file')}.`,
      );
    };
    /** Something other than this switch started the launcher. Before the writes nothing is lost by stopping; after them the catch block rolls back. */
    const startedMeanwhile = (at: string): Error => {
      mark(at, 'running');
      return new Error(
        `Epic Games Launcher was started by something else while One Launch was switching accounts, so the switch ${modified ? 'was stopped' : 'stopped before changing anything'}. Try again.`,
      );
    };
    let logAt: LogMark = logMark(logPath);
    const startLauncher = async (): Promise<void> => {
      mark(STEP.start, 'running');
      stopIfAborted();
      logAt = logMark(logPath);
      launcherStarted = true;
      await this.deps.processes.start(install.exePath, [], { cwd: dirname(install.exePath) });
      mark(STEP.start, 'done', 'Launcher started.');
      mark(STEP.wait, 'running');
      if (!(await this.waitUntil(() => this.isRunning(), this.timing.startupMs, opts.signal))) {
        throw new Error(`${EPIC_EXE} did not appear within ${this.timing.startupMs / 1000} s`);
      }
      mark(STEP.wait, 'done', `${EPIC_EXE} is running.`);
    };
    /** Polls the launcher log. During a manual wait a failed attempt (wrong password) is not final. */
    const waitForSignIn = async (timeoutMs: number, manual: boolean): Promise<SignInWait> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (opts.signal?.aborted) return { kind: 'cancelled' };
        const last = lastSignIn(eventsSince(logPath, logAt));
        if (last?.ok) {
          const owner = last.accountId ? this.deps.accounts.byLauncherUid(last.accountId) : null;
          if (expectedUid === null) {
            // The log carries only an opaque id, so an id nobody holds is taken as this account's. One that another account holds is not.
            if (owner && owner.id !== account.id) return { kind: 'wrong-account', accountId: last.accountId, owner };
            return { kind: 'signed-in', accountId: last.accountId };
          }
          if (last.accountId === expectedUid) return { kind: 'signed-in', accountId: last.accountId };
          if (last.accountId) return { kind: 'wrong-account', accountId: last.accountId, owner };
        } else if (last && !manual) {
          return { kind: 'failed', reason: last.reason };
        }
        if (Date.now() >= deadline) return { kind: 'timeout' };
        await sleep(this.timing.logPollMs, opts.signal);
      }
    };
    const wrongAccount = (r: { accountId: string; owner: AccountRef | null }): Error => {
      const who = r.owner ? `${r.owner.displayName} (account ${idTail(r.accountId)})` : `account ${idTail(r.accountId)}`;
      return new Error(
        expectedUid === null
          ? `Epic Games Launcher signed in as ${who}, which is another One Launch account, instead of ${account.displayName}. Sign in to the launcher as ${login}.`
          : `Epic Games Launcher signed in as ${who} instead of ${account.displayName} (${idTail(expectedUid)}). Sign in to the launcher as ${login}, or fix the launcher account ID on the account page.`,
      );
    };
    /** A first confirmed sign-in is where the account's Epic id comes from. Throws when another account holds it. */
    const linkIfNew = (signedInAs: string): string => {
      if (!account.id || !signedInAs || expectedUid !== null) return '';
      this.deps.accounts.setLauncherUid(account.id, signedInAs);
      expectedUid = signedInAs;
      this.log.info('epic account id linked', { accountId: account.id });
      return ` Linked to Epic Games account ${idTail(signedInAs, 4)}.`;
    };
    const confirmSignIn = async (): Promise<SignInWait> => {
      mark(STEP.verify, 'running');
      const r = await waitForSignIn(plan.strategy === 'remembered' ? this.timing.signInMs : 1, false);
      if (r.kind === 'signed-in') mark(STEP.verify, 'done', `Signed in as ${login}.${linkIfNew(r.accountId)}`);
      else if (r.kind === 'wrong-account') mark(STEP.verify, 'failed', 'Signed in as a different account.');
      else if (r.kind === 'failed') mark(STEP.verify, 'failed', `The launcher rejected the session: ${r.reason || 'no reason given'}.`);
      else if (r.kind === 'timeout')
        mark(STEP.verify, 'failed', plan.strategy === 'remembered' ? 'The launcher did not report a sign-in in time.' : 'Waiting for you.');
      else mark(STEP.verify, 'failed', 'Cancelled.');
      return r;
    };
    const waitForManualSignIn = async (why: SignInWait): Promise<SignInWait> => {
      const until = new Date(Date.now() + this.timing.manualSignInMs).toISOString();
      const cause = plan.strategy === 'credentials' ? 'new' : why.kind === 'failed' && /expired/i.test(why.reason) ? 'expired' : 'other';
      const attention = attentionFor(login, cause, why.kind === 'failed' ? why.reason : null, account.hasSecret && Boolean(opts.getPassword), until);
      mark(STEP.manual, 'running', attention.title);
      this.log.warn('epic switch waiting for manual sign-in', { accountId: account.id, cause, backupId });
      handedOver = true;
      opts.onAttention?.(attention);
      try {
        const r = await waitForSignIn(this.timing.manualSignInMs, true);
        if (r.kind === 'signed-in') mark(STEP.manual, 'done', `Signed in as ${login}.${linkIfNew(r.accountId)}`);
        else if (r.kind === 'wrong-account') mark(STEP.manual, 'failed', 'Signed in as a different account.');
        else if (r.kind === 'cancelled') mark(STEP.manual, 'failed', 'Stopped waiting.');
        else mark(STEP.manual, 'failed', `No sign-in after ${this.timing.manualSignInMs / 60_000} min.`);
        return r;
      } finally {
        opts.onAttention?.(null);
      }
    };
    /**
     * After a confirmed sign-in: store the fresh [RememberMe] if the launcher has written one that
     * differs from what was there. Waits up to `waitMs` for it (a manual sign-in writes it moments
     * later; an auto sign-in may not rewrite it at all).
     */
    const captureFresh = async (waitMs: number): Promise<void> => {
      if (!account.id) return;
      mark(STEP.recapture, 'running');
      const deadline = Date.now() + waitMs;
      for (;;) {
        const text = this.readIni();
        const disk = text ? readSessionFromIni(text) : null;
        const blob = text ? sessionBlobFromIni(text) : null;
        if (disk?.remembered && blob && disk.fingerprint !== writtenFingerprint) {
          this.storeSession({ ...account, id: account.id }, blob, expectedUid);
          this.deps.sessions.markVerified(account.id);
          mark(STEP.recapture, 'done', `Stored ${account.displayName}'s session (fingerprint ${shortFingerprint(disk.fingerprint)}).`);
          return;
        }
        if (Date.now() >= deadline || opts.signal?.aborted) {
          if (disk?.remembered && this.deps.sessions.get(account.id)?.fingerprint === disk.fingerprint) {
            this.deps.sessions.markVerified(account.id);
            mark(STEP.recapture, 'done', 'The stored session is current.');
          } else {
            mark(STEP.recapture, 'done', 'The launcher has not written the new session yet; it is saved at the next switch.');
          }
          return;
        }
        await sleep(this.timing.logPollMs, opts.signal);
      }
    };
    const cancelledResult = (): SwitchResult =>
      result(false, {
        backupId,
        restored: null,
        cancelled: true,
        needsSignIn: false,
        error: handedOver
          ? `Stopped waiting for the sign-in as ${login}. Epic Games Launcher was left on its sign-in page; signing in there finishes the switch, and the session is saved at the next one.`
          : `Stopped while Epic Games Launcher was starting as ${login}. Nothing was rolled back: the launcher carries on signing in on its own.`,
      });
    const needsSignInResult = (): SwitchResult =>
      result(false, {
        backupId,
        restored: null,
        cancelled: false,
        needsSignIn: true,
        error: `One Launch waited ${this.timing.manualSignInMs / 60_000} min for the sign-in as ${login} and gave up. Epic Games Launcher is still on its sign-in page: sign in there, and the session is saved at the next switch.`,
      });

    this.log.info('epic switch started', {
      accountId: account.id,
      strategy: plan.strategy,
      inPlace: ctx.inPlace,
      alreadyActive: ctx.alreadyActive,
      running: ctx.running,
    });

    try {
      stopIfAborted();
      if (ctx.running && !ctx.alreadyActive) {
        mark(STEP.close, 'running');
        await this.shutdown({ signal: opts.signal });
        mark(STEP.close, 'done', 'Launcher closed.');
      }
      stopIfAborted();
      // A running launcher rewrites the file on exit and ignores what is written under it, so nothing is read or written against one.
      if (!ctx.alreadyActive && (await this.isRunning())) throw startedMeanwhile(STEP.close);

      saveOutgoing();
      if (!ctx.alreadyActive && !ctx.inPlace) {
        if (this.settingsPaths().length === 0) {
          throw new SwitchBlockedError(
            `${iniPath} is missing. Restore the newest Epic Games backup from Settings, or start the launcher once by hand, then try again.`,
          );
        }
        takeSnapshot();
        writeSession();
      }

      if (await this.isRunning()) {
        if (!ctx.alreadyActive) throw startedMeanwhile(STEP.start);
        mark(STEP.start, 'skipped', 'The launcher is already running.');
        mark(STEP.wait, 'skipped', 'The launcher is already running.');
      } else {
        await startLauncher();
      }

      if (ctx.alreadyActive && ctx.running) {
        mark(STEP.verify, 'skipped', 'The launcher is already signed in as this account.');
      } else {
        let r = await confirmSignIn();
        if (r.kind === 'cancelled') return cancelledResult();
        if (r.kind === 'wrong-account') throw wrongAccount(r);
        if (r.kind === 'signed-in' && account.id && plan.strategy === 'remembered') {
          if (ctx.inPlace) await captureFresh(0);
          else this.deps.sessions.markVerified(account.id);
        }
        if (r.kind !== 'signed-in') {
          // Only a refused session is stale. A service or network failure says nothing about the snapshot, and marking it would cost a manual sign-in.
          if (r.kind === 'failed' && account.id && plan.strategy === 'remembered' && isSessionRejection(r.reason))
            this.deps.sessions.markStale(account.id, r.reason);
          r = await waitForManualSignIn(r);
          if (r.kind === 'cancelled') return cancelledResult();
          if (r.kind === 'wrong-account') throw wrongAccount(r);
          if (r.kind !== 'signed-in') return needsSignInResult();
          await captureFresh(this.timing.captureMs);
        }
        readyAt = new Date(Date.now() + this.timing.readyGraceMs).toISOString();
      }

      this.log.info('epic switch finished', { accountId: account.id, backupId, modified });
      return result(true, { backupId, restored: null, error: null, needsSignIn: false, cancelled: false, readyAt });
    } catch (err) {
      const cancelled = err instanceof SwitchAbortedError;
      const message = cancelled ? `Stopped before Epic Games Launcher was started as ${login}.` : errorText(err);
      if (current) mark(current, 'failed', cancelled ? 'Stopped.' : message);
      if (cancelled) this.log.info('epic switch stopped', { accountId: account.id, backupId, modified, launcherStarted });
      else if (!modified && isRefusal(err)) this.log.warn('epic switch refused', { accountId: account.id, code: refusalCode(err), error: err });
      else this.log.error('epic switch failed', { accountId: account.id, backupId, modified, error: err });
      if (cancelled && launcherStarted) return cancelledResult();
      if (!modified) {
        return result(false, { backupId, restored: null, error: cancelled ? `${message} Nothing had been changed.` : message, needsSignIn: false, cancelled });
      }
      if (!backupId)
        return result(false, { backupId, restored: false, error: `${message} (no backup was available to restore)`, needsSignIn: false, cancelled });
      try {
        // The launcher rewrites the INI on state changes and exit, so make sure it is down first. Never interrupted: no signal.
        if (await this.isRunning()) await this.shutdown().catch((e: unknown) => this.log.warn('could not close the launcher before rollback', { error: e }));
        const restored = await this.applyRestore(backupId);
        this.log.warn('epic switch rolled back from backup', { backupId, files: restored.files.length });
        return result(false, { backupId, restored: true, error: message, needsSignIn: false, cancelled });
      } catch (restoreErr) {
        this.log.error('epic rollback failed', { backupId, error: restoreErr });
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
    await this.requireInstall();
    if (await this.isRunning()) {
      throw new LauncherRunningError(
        'Close Epic Games Launcher before restoring: it rewrites GameUserSettings.ini while it runs, which would undo the restore.',
      );
    }
    // The state being replaced is itself worth keeping: a restore of the wrong snapshot can then be undone.
    this.deps.backups.snapshot({
      launcher: 'epic',
      reason: `Before restoring ${id}`,
      files: this.settingsPaths().map((source) => ({ source, relative: this.settingsRelative(source), sensitive: true })),
      protect: id,
      ...(this.holdsUnownedSession() ? { pinned: UNOWNED_SESSION_PIN } : {}),
    });
    return this.applyRestore(id);
  }

  /** Whether the settings file, as it is now, remembers a session that no One Launch account owns. Only meaningful while the launcher is closed. */
  private holdsUnownedSession(): boolean {
    const text = this.readIni();
    const session = text ? this.currentSession(text, false) : null;
    return session !== null && session.disk.remembered && !session.owner?.id;
  }

  private async applyRestore(id: string): Promise<RestoreResult> {
    const { restored } = this.deps.backups.restore(
      'epic',
      id,
      SETTINGS_FOLDERS.map((folder) => this.settingsPathIn(folder)),
    );
    this.log.warn('epic backup restored', { id, files: restored.length });
    return { launcher: 'epic', id, files: restored, registry: [] };
  }

  // --- health ------------------------------------------------------------------

  async healthCheck(known?: KnownLauncherState): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    const add = (id: string, label: string, status: HealthStatus, detail: string): void => {
      checks.push({ id, label, status, detail });
    };
    const report = (): HealthReport => ({ launcher: 'epic', status: worst(checks), checks, checkedAt: new Date().toISOString() });

    const install = known ? known.install : await this.detectInstall();
    let seenRunning = known?.running ?? null;
    const isRunning = async (): Promise<boolean> => (seenRunning ??= await this.isRunning());
    const chosenGone = chosenFolderCheck(this.chosenInstallDir(), install, EPIC_EXE);
    if (!install) {
      add(
        'install',
        'Installation',
        'absent',
        `Epic Games Launcher is not installed on this PC. Checked the Uninstall key, the com.epicgames.launcher URI handler, and ${this.defaultDir}.`,
      );
      if (chosenGone) checks.push(chosenGone);
      return { ...report(), status: 'absent' };
    }
    add('install', 'Installation', 'ok', `${install.installDir} (from ${sourceLabel(install.source)})`);
    if (chosenGone) checks.push(chosenGone);

    try {
      add('process', 'Process', 'ok', (await isRunning()) ? `${EPIC_EXE} is running` : `${EPIC_EXE} is not running`);
    } catch (err) {
      add('process', 'Process', 'warn', `Could not query the process list: ${errorText(err)}`);
    }

    let games: InstalledGame[] = [];
    try {
      const { dir, manifests, unreadable } = await this.readManifests();
      if (!existsSync(dir)) {
        add('manifests', 'Manifests', 'warn', `${dir} not found. No Epic games are installed, or the launcher has never installed one.`);
      } else {
        games = await this.listInstalledGames();
        add(
          'manifests',
          'Manifests',
          unreadable > 0 ? 'warn' : 'ok',
          `${plural(manifests.length, '.item manifest')} in ${dir}${unreadable > 0 ? `, ${unreadable} unreadable` : ''}; ${plural(games.length, 'installed game')}`,
        );
      }
    } catch (err) {
      add('manifests', 'Manifests', 'fail', `Could not scan the manifests: ${errorText(err)}`);
    }

    const installedDat = this.launcherInstalledPath();
    if (!existsSync(installedDat)) {
      add('launcher-installed', 'LauncherInstalled.dat', 'warn', `${installedDat} not found; the cross-check is skipped.`);
    } else {
      try {
        const entries = parseLauncherInstalled(readLauncherText(installedDat));
        const missing = games.filter((g) => !entries.some((e) => e.appName === g.launcherGameId)).length;
        add(
          'launcher-installed',
          'LauncherInstalled.dat',
          missing > 0 ? 'warn' : 'ok',
          `${plural(entries.length, 'entry')}${missing > 0 ? `; ${missing} installed game(s) not listed there` : ', agrees with the manifests'}`,
        );
      } catch (err) {
        add('launcher-installed', 'LauncherInstalled.dat', 'warn', `Could not parse ${installedDat}: ${errorText(err)}`);
      }
    }

    const iniPath = this.settingsPath();
    const iniPaths = this.settingsPaths();
    let current: CurrentSession | null = null;
    if (iniPaths.length === 0) {
      add('settings', 'GameUserSettings.ini', 'warn', `${iniPath} not found. The launcher has not run for this Windows user yet.`);
    } else {
      try {
        const text = this.readIni() ?? '';
        current = this.currentSession(text, await isRunning());
        const ids = new Set(
          sectionNames(text)
            .map((n) => ACCOUNT_SECTION.exec(n)?.[1]?.toLowerCase())
            .filter((v): v is string => Boolean(v)),
        );
        const who = current.disk.remembered
          ? current.owner
            ? `remembered session belongs to ${current.owner.displayName}`
            : 'remembered session not linked to any One Launch account'
          : 'no remembered session (signed out)';
        const enable = current.disk.enable?.toLowerCase() === 'true' || current.disk.enable === null;
        add(
          'settings',
          'GameUserSettings.ini',
          enable ? 'ok' : 'warn',
          `${iniPaths.length > 1 ? `${iniPaths.length} settings files, reading the newest (${iniPath.includes('WindowsEditor') ? 'WindowsEditor' : 'Windows'}); ` : ''}${plural(ids.size, 'account')} have signed in on this PC; ${who}${
            enable ? '' : `; [RememberMe] Enable=${current.disk.enable}, so the launcher does not sign in on its own until a switch sets it back`
          }`,
        );
      } catch (err) {
        add('settings', 'GameUserSettings.ini', 'fail', err instanceof LauncherFileError ? err.message : `Could not read ${iniPath}: ${errorText(err)}`);
      }
    }

    const logPath = this.logPath();
    if (!existsSync(logPath)) {
      add('log', 'Launcher log', 'warn', `${logPath} not found. Sign-ins cannot be confirmed until the launcher has run once.`);
    } else {
      const last = current?.lastSignIn ?? lastSignInInLog(logPath);
      add(
        'log',
        'Launcher log',
        last === null || last.ok ? 'ok' : 'warn',
        last === null
          ? 'Readable; no sign-in attempt in the current log'
          : last.ok
            ? 'Readable; the last run signed in'
            : `Readable; the last sign-in failed (${last.reason})`,
      );
    }

    const sessions = this.deps.sessions.list('epic');
    const stale = sessions.filter((s) => s.staleReason !== null).length;
    add(
      'sessions',
      'Session snapshots',
      stale > 0 ? 'warn' : 'ok',
      `${plural(sessions.length, 'snapshot')} stored${stale > 0 ? `, ${stale} marked stale` : ''}`,
    );

    const snapshots = this.deps.backups.list('epic').length;
    add('backups', 'Backups', 'ok', snapshots === 0 ? 'No snapshots yet' : `${plural(snapshots, 'snapshot')} available for restore`);

    return report();
  }
}

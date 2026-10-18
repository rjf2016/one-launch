/**
 * Riot Games adapter (rules and findings in docs/adapters/riot.md). It reads where the Riot Client is,
 * which products are installed, whether the client or a game is running (by image name, from a listing
 * that opens no process), the saved sign-in in the client's session file (whose it is, by the account
 * id the file itself names), and the client's own log (its verdict on the last sign-in); it stores a
 * sign-in for its account; and it switches accounts the way Epic's adapter does: close the client
 * (the core, then the window, by image name, never the tree), store the sign-in the file holds for
 * its owner, snapshot the file, put the target account's saved copy of the whole file in place (or
 * the client's own signed-out state), start the client the way its shortcut does, and confirm the
 * sign-in from the log and the account id the file then names. A game that is running refuses the
 * switch outright (hard rule 2); a failure after the first write puts the file back, after storing
 * what it held. The one launcher file written is RiotGamesPrivateSettings.yaml, only in runSwitch and
 * applyRestore. A game is launched the way its shortcut does it, --launch-product and --launch-patchline
 * handed to the client, which on build 140 opens the game's page and waits for Play (Riot turned
 * auto-launch off): the launch hands over to the user once the page is up.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
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
  GameNotPlayableError,
  GameRunningError,
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
import { readLauncherText } from '../read-file';
import { mergeTiming, sleep, SwitchAbortedError, waitUntil } from '../wait';
import { processNameOf } from '../../platform/processes';
import {
  CLIENT_LOG_FILE,
  clientLogDir,
  currentRunBuild,
  currentRunEvents,
  eventsSince,
  exitedCleanly,
  gameStarted,
  lastSignIn,
  launchAccepted,
  launchDeclined,
  launchPageShown,
  logMark,
  productsNeedingUpdate,
  startupFinished,
  type LogEvent,
  type LogMark,
  type SignInOutcome,
} from './client-log';
import type { RiotLocalLaunch } from './local-launch';
import {
  gameImagesOf,
  launchArgs,
  parseInstalls,
  parseLastSessionTimestamps,
  parseProductId,
  parseProductSettings,
  productDisplayName,
  productWithRunningImage,
  type RiotInstalls,
  type RiotProductId,
  type RiotProductSettings,
} from './products';
import {
  parseBlob,
  planSignOut,
  readSession,
  riotIdText,
  serializeBlob,
  shortFingerprint,
  type RiotSession,
  type RiotSessionBlob,
  type RiotSessionRead,
} from './session';

export const RIOT_CLIENT_EXE = 'RiotClientServices.exe';
/** Riot writes its uninstall keys under the current user; the client's own key name ends in a dot. */
export const RIOT_UNINSTALL_ROOT = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
export const RIOT_CLIENT_UNINSTALL_KEY = `${RIOT_UNINSTALL_ROOT}\\Riot Game Riot_Client.`;
export const RIOT_URI_COMMAND_KEY = 'SOFTWARE\\Classes\\riotclient\\shell\\open\\command';
export const RIOT_INSTALLS_FILE = 'RiotClientInstalls.json';
export const DEFAULT_RIOT_DIR = 'C:\\Riot Games\\Riot Client';
export const DISPLAY_NAME = 'Riot Games';
/** The client's session file: the one launcher file this adapter writes, in runSwitch and applyRestore only (docs/adapters/riot.md, hard rule 6). */
export const SESSION_FILE = 'RiotGamesPrivateSettings.yaml';
/** Where the session file sits inside a snapshot. */
export const SESSION_FILE_RELATIVE = `Data/${SESSION_FILE}`;
/** The client's window processes (several; the windowless helpers exit with their parent). Older builds used UX\RiotClientUx.exe. */
export const RIOT_CLIENT_WINDOW_EXE = 'Riot Client.exe';
/** Why a snapshot is pinned (see BackupService). Shown in Settings › Backups. */
export const UNOWNED_SESSION_PIN = 'Holds a sign-in that no One Launch account owns';
const CLIENT_NAME = 'the Riot Client';

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
  /** The waits that read the log or the session file, not the process list: each poll is cheap, so they look more often. */
  logPollMs: 250,
  /** How often a launch watch asks the process list for the game, each ask a PowerShell start; the log is read every poll. */
  processPollMs: 1_000,
  /** The core's one window, the tray icon's, swallows the close on the current build: a short polite try, then the forced close. */
  shutdownMs: 3_000,
  killGraceMs: 10_000,
  /** The window processes once the core is gone: the ones with a window get the close, the helpers exit with their parent. */
  windowCloseMs: 10_000,
  /** How long to watch for the core coming back after it exits (a self-update restart). */
  restartWatchMs: 5_000,
  /** The same watch when the log shows the lock file removed, the core's last line of a clean exit, or after a forced close. */
  cleanExitWatchMs: 1_500,
  /** How long a restarted client gets to reach a sign-in verdict before it is closed again. */
  restartSettleMs: 45_000,
  startupMs: 60_000,
  /** A saved sign-in is restored about 2 s after start and the signed-in state logged about 6 s after; a self-update restart can come first. */
  signInMs: 45_000,
  /** How long the user gets to sign in by hand on the client's login page. */
  manualSignInMs: 600_000,
  /** How long to wait for the client to write the fresh session file after a sign-in (it logs the write before the signed-in state). */
  captureMs: 15_000,
  /** Breathing room between the confirmed sign-in and the game launch. */
  readyGraceMs: 2_000,
  /** How long launchGame watches the client's log after handing it the game: the launch pipeline with its patch check takes about 15 s to reach the page (seen), a closed client about 4 s more for its sign-in, and a self-update can come first. */
  launchConfirmMs: 90_000,
  /** How long the game gets to start after One Launch's own Play: about 7 s from Play to WaitForSessionExit on the real client. */
  playConfirmMs: 30_000,
};
export type RiotTiming = typeof DEFAULT_TIMING;

export interface RiotAdapterDeps {
  registry: RegistryReader;
  processes: ProcessController;
  backups: BackupService;
  sessions: LauncherSessionStore;
  accounts: AccountDirectory;
  log: Logger;
  backupsToKeep: () => number;
  /** %LOCALAPPDATA% by default. Overridable for tests. */
  localAppData?: string;
  /** %ProgramData% by default. Overridable for tests. */
  programData?: string;
  /** The riot.path setting: the folder the user chose with Locate, tried before the registry. */
  installDir?: () => string | null;
  /** Last-resort install location. Overridable for tests. */
  defaultInstallDir?: string;
  timing?: Partial<RiotTiming>;
  /** The riot.pressPlay setting: once the client has opened the game's page, press Play for the user. */
  pressPlay?: () => boolean;
  /** The launch request the client's Play button sends, to the client's local server: the real channel, or the simulator's Play. */
  localLaunch?: RiotLocalLaunch;
}

interface ProductRecord {
  id: RiotProductId;
  settings: RiotProductSettings | null;
  /** Riot's own marker that the install completed; a settings file alone also exists for products never installed. */
  ok: boolean;
  installPath: string | null;
}

function sourceLabel(source: LauncherInstall['source']): string {
  switch (source) {
    case 'user':
      return 'the folder chosen in Settings';
    case 'default-path':
      return 'default location';
    case 'launcher-file':
      return RIOT_INSTALLS_FILE;
    case 'registry-hkcu':
      return 'HKCU';
    case 'registry-hklm':
      return 'HKLM';
  }
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
function idTail(uid: string | null): string {
  return uid ? `…${uid.slice(-4)}` : '(unknown id)';
}

/** The log's verdict as the session panel shows it. A start with no saved sign-in is not an attempt. */
/**
 * The newest run's verdict for the account page. A closed client whose last run signed in by hand but
 * whose file holds no sign-in kept nothing: “Stay signed in” was not ticked (docs/adapters/riot.md › Session file).
 */
function sessionLastSignIn(last: SignInOutcome | null, state: { running: boolean; remembered: boolean }): LauncherSessionState['lastSignIn'] {
  if (!last) return null;
  if (last.ok) {
    if (last.how === 'manual' && !state.running && !state.remembered) {
      return { ok: false, reason: 'the last sign-in was not kept because “Stay signed in” was not ticked. Sign in to the Riot Client again with it ticked.' };
    }
    return { ok: true, reason: null };
  }
  return last.reason === 'no-session' ? null : { ok: false, reason: last.detail };
}

function describeSignIn(last: SignInOutcome | null): string {
  if (!last) return 'reached no sign-in verdict';
  if (!last.ok) return `ended on the login page (${last.detail})`;
  switch (last.how) {
    case 'restored':
      return 'signed in from the saved sign-in';
    case 'manual':
      return 'signed in by hand';
    case 'unknown':
      return 'signed in';
  }
}

/** The session a stored blob holds. Throws when the stored file is not one the reader knows: nothing is written from it then. */
function sessionOfBlob(blob: RiotSessionBlob): RiotSession {
  const read = readSession(blob.file);
  if (read.kind !== 'session') throw new Error(`the stored Riot sign-in holds no session (${read.kind === 'unexpected' ? read.reason : 'signed out'})`);
  return read.session;
}

/** The session file as it is now and whose session it holds. */
interface CurrentSession {
  /** The file's text, held for capture only; never logged. Null when there is no file. */
  text: string | null;
  session: RiotSession | null;
  /** The One Launch account the session belongs to: by a stored snapshot's fingerprint first, then by the account id the file itself names. */
  owner: AccountRef | null;
}

interface PlanContext {
  install: LauncherInstall;
  current: CurrentSession;
  stored: LauncherSession | null;
  strategy: SwitchStrategy;
  /** The file already holds the target account's sign-in, so the client signs in as it at the next start. */
  inPlace: boolean;
  /** The client is running, signed in as the target account (the file names it and the log confirms a sign-in). */
  alreadyActive: boolean;
  running: boolean;
  /** A Riot game is running, which refuses the switch (hard rule 2). */
  game: RunningGame | null;
}

type SignInWait =
  | { kind: 'signed-in'; accountId: string | null }
  | { kind: 'wrong-account'; accountId: string; owner: AccountRef | null }
  | { kind: 'failed'; outcome: Extract<SignInOutcome, { ok: false }> }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

function attentionFor(login: string, cause: 'expired' | 'new' | 'other', reason: string | null, canCopyPassword: boolean, until: string): LaunchAttention {
  const why =
    cause === 'expired'
      ? 'The client refused its saved sign-in.'
      : cause === 'new'
        ? 'No sign-in is saved for this account yet.'
        : `The client did not sign in on its own${reason ? ` (${reason})` : ''}.`;
  return {
    kind: 'sign-in',
    title: cause === 'new' ? `Sign in to the Riot Client as ${login}` : `The Riot Client is asking you to sign in as ${login}`,
    message: why,
    steps: [
      `In the Riot Client window, enter the login ${login} and your password.`,
      'Tick “Stay signed in” before you sign in, or the client forgets the account when it closes.',
      'Press Sign in. One Launch continues on its own, and later switches are automatic.',
    ],
    reason,
    canCopyPassword,
    until,
  };
}

export class RiotAdapter implements LauncherAdapter {
  readonly id = 'riot' as const;
  readonly displayName = DISPLAY_NAME;

  private readonly log: Logger;
  private readonly localAppData: string;
  private readonly programData: string;
  private readonly defaultDir: string;
  private readonly timing: RiotTiming;

  constructor(private readonly deps: RiotAdapterDeps) {
    this.log = deps.log;
    const profile = process.env['USERPROFILE'] ?? 'C:\\';
    this.localAppData = deps.localAppData ?? process.env['LOCALAPPDATA'] ?? join(profile, 'AppData', 'Local');
    this.programData = deps.programData ?? process.env['ProgramData'] ?? 'C:\\ProgramData';
    this.defaultDir = deps.defaultInstallDir ?? DEFAULT_RIOT_DIR;
    this.timing = mergeTiming(DEFAULT_TIMING, deps.timing);
  }

  // --- paths -----------------------------------------------------------------

  /** The client's per-user data folder. */
  dataDir(): string {
    return join(this.localAppData, 'Riot Games', 'Riot Client');
  }

  logDir(): string {
    return clientLogDir(this.localAppData);
  }

  /** `Config\lockfile`: the client's local server port and per-run password, read for the launch request alone (rule 4). */
  private lockfilePath(): string {
    return join(this.dataDir(), 'Config', 'lockfile');
  }

  sessionFilePath(): string {
    return join(this.dataDir(), 'Data', SESSION_FILE);
  }

  settingsPath(): string {
    return join(this.dataDir(), 'Config', 'RiotClientSettings.yaml');
  }

  metadataDir(): string {
    return join(this.programData, 'Riot Games', 'Metadata');
  }

  installsPath(): string {
    return join(this.programData, 'Riot Games', RIOT_INSTALLS_FILE);
  }

  // --- detection -------------------------------------------------------------

  async detectInstall(): Promise<LauncherInstall | null> {
    const { registry } = this.deps;
    const chosen = this.chosenInstallDir();
    const fromChosen = chosen ? this.installAt(chosen, 'user') : null;
    if (fromChosen) return fromChosen;
    const uninstall = await registry.getString('HKCU', RIOT_CLIENT_UNINSTALL_KEY, 'InstallLocation');
    if (uninstall && uninstall.trim()) {
      const found = this.installAt(normalizeLauncherPath(uninstall), 'registry-hkcu');
      if (found) return found;
    }
    const installs = this.installs();
    for (const exe of [installs?.rcDefault, installs?.rcLive]) {
      if (!exe) continue;
      const found = this.installAt(dirname(normalizeLauncherPath(exe)), 'launcher-file');
      if (found) return found;
    }
    for (const hive of ['HKLM', 'HKCU'] as const) {
      const command = await registry.getString(hive, RIOT_URI_COMMAND_KEY, '');
      const exe = command ? /^"([^"]+)"/.exec(command)?.[1] : undefined;
      if (!exe) continue;
      const found = this.installAt(dirname(normalizeLauncherPath(exe)), hive === 'HKLM' ? 'registry-hklm' : 'registry-hkcu');
      if (found) return found;
    }
    return this.installAt(this.defaultDir, 'default-path');
  }

  chosenInstallDir(): string | null {
    return chosenFolder(this.deps.installDir);
  }

  installFromExe(exePath: string): LauncherInstall | null {
    const exe = normalizeLauncherPath(exePath);
    return isNamed(exe, [RIOT_CLIENT_EXE]) ? this.installAt(dirname(exe), 'user') : null;
  }

  private installAt(installDir: string, source: LauncherInstall['source']): LauncherInstall | null {
    const exePath = join(installDir, RIOT_CLIENT_EXE);
    if (!existsSync(exePath)) {
      this.log.debug('no RiotClientServices.exe at candidate location', { source, installDir });
      return null;
    }
    return { launcher: 'riot', installDir, exePath, source };
  }

  private async requireInstall(): Promise<LauncherInstall> {
    const install = await this.detectInstall();
    if (!install) throw new LauncherNotInstalledError('riot');
    return install;
  }

  /** RiotClientInstalls.json, or null when it is missing or unreadable. */
  private installs(): RiotInstalls | null {
    const path = this.installsPath();
    if (!existsSync(path)) return null;
    try {
      return parseInstalls(readLauncherText(path));
    } catch (err) {
      this.log.warn('could not read RiotClientInstalls.json', { error: errorText(err) });
      return null;
    }
  }

  // --- library -----------------------------------------------------------------

  /** One record per `<product>.<patchline>` folder under Metadata, installed or not. */
  private products(): ProductRecord[] {
    const dir = this.metadataDir();
    if (!existsSync(dir)) return [];
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err) {
      this.log.warn('could not list the Riot metadata folder', { error: errorText(err) });
      return [];
    }
    const records: ProductRecord[] = [];
    for (const name of names) {
      const id = parseProductId(name);
      if (!id) continue;
      const folder = join(dir, name);
      const settingsPath = join(folder, `${name}.product_settings.yaml`);
      let settings: RiotProductSettings | null = null;
      if (existsSync(settingsPath)) {
        try {
          settings = parseProductSettings(readLauncherText(settingsPath));
        } catch (err) {
          this.log.warn('could not read a Riot product settings file', { product: name, error: errorText(err) });
        }
      }
      records.push({
        id,
        settings,
        ok: existsSync(join(folder, `${name}.ok`)),
        installPath: settings?.installPath ? normalizeLauncherPath(settings.installPath) : null,
      });
    }
    return records.sort((a, b) => a.id.id.localeCompare(b.id.id));
  }

  private isInstalled(record: ProductRecord): boolean {
    return record.ok && record.installPath !== null && existsSync(record.installPath);
  }

  async listInstalledGames(): Promise<InstalledGame[]> {
    await this.requireInstall();
    return this.gamesFrom(this.products(), this.productsOutOfDate());
  }

  /**
   * Products the client's newest run log reported as out of date (its Play button reads Update, and a
   * launch request only opens the product's page). The client logs every product's patch state at each
   * start and again when it changes, so the newest run's last word stands until the next run.
   * `update-status.json` is not read: it was stale after a real update (docs/adapters/riot.md).
   */
  private productsOutOfDate(): Set<string> {
    return productsNeedingUpdate(currentRunEvents(this.logDir()));
  }

  private async gamesFrom(records: readonly ProductRecord[], outOfDate: ReadonlySet<string>): Promise<InstalledGame[]> {
    const lastSessions = this.lastSessionTimestamps();
    const games: InstalledGame[] = [];
    for (const r of records) {
      if (!this.isInstalled(r)) continue;
      const installPath = r.installPath!;
      games.push({
        launcher: 'riot',
        launcherGameId: r.id.id,
        name: (await this.uninstallDisplayName(r.id.id)) ?? this.tableName(r.id),
        installPath,
        libraryPath: r.settings?.installRoot ? normalizeLauncherPath(r.settings.installRoot) : dirname(installPath),
        sizeOnDiskBytes: null,
        lastPlayedAt: lastSessions.get(r.id.id) ?? null,
        needsUpdate: outOfDate.has(r.id.id),
      });
    }
    return games.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  private tableName(id: RiotProductId): string {
    const name = productDisplayName(id.product);
    return id.patchline === 'live' ? name : `${name} (${id.patchline.toUpperCase()})`;
  }

  /**
   * The product's own icon, which the installer leaves beside its metadata (`<product>.<patchline>.ico`)
   * and names in the product's Uninstall key as DisplayIcon. Riot's games are not on Steam, so this is
   * what the Library shows until a cover is found elsewhere. A path only; the artwork service reads it.
   */
  async gameIcon(game: Pick<InstalledGame, 'launcherGameId' | 'name'>): Promise<string | null> {
    const id = parseProductId(game.launcherGameId);
    if (!id) return null;
    const candidates = [join(this.metadataDir(), id.id, `${id.id}.ico`)];
    try {
      const displayIcon = await this.deps.registry.getString('HKCU', `${RIOT_UNINSTALL_ROOT}\\Riot Game ${id.id}`, 'DisplayIcon');
      // A DisplayIcon value may carry an icon index after a comma; only an .ico file is taken.
      const path = displayIcon?.trim().replace(/,-?\d+$/, '');
      if (path && /\.ico$/i.test(path)) candidates.push(normalizeLauncherPath(path));
    } catch (err) {
      this.log.debug('could not read a Riot product DisplayIcon', { product: id.id, error: errorText(err) });
    }
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  /** What Windows' app list calls the product, from its Uninstall key, or null. */
  private async uninstallDisplayName(id: string): Promise<string | null> {
    try {
      const name = await this.deps.registry.getString('HKCU', `${RIOT_UNINSTALL_ROOT}\\Riot Game ${id}`, 'DisplayName');
      return name?.trim() || null;
    } catch (err) {
      this.log.debug('could not read a Riot product Uninstall key', { product: id, error: errorText(err) });
      return null;
    }
  }

  private lastSessionTimestamps(): Map<string, string> {
    const path = this.settingsPath();
    if (!existsSync(path)) return new Map();
    try {
      return parseLastSessionTimestamps(readLauncherText(path));
    } catch (err) {
      this.log.warn('could not read RiotClientSettings.yaml', { error: errorText(err) });
      return new Map();
    }
  }

  // --- session -----------------------------------------------------------------

  /** The session file's text and what its block says, or null when there is no file. Throws LAUNCHER_FILE when the file cannot be read. */
  private readSessionFile(): { text: string; read: RiotSessionRead } | null {
    const path = this.sessionFilePath();
    if (!existsSync(path)) return null;
    let text: string;
    try {
      text = readLauncherText(path);
    } catch (err) {
      if (err instanceof LauncherFileError) throw err;
      throw new LauncherFileError(path, `Could not read ${SESSION_FILE} (${errorText(err)})`);
    }
    return { text, read: readSession(text) };
  }

  /** What the session file holds now and whose session it is. Reads the file only; writes nothing. A file in an unknown shape is an error, not a sign-out. */
  private currentSession(): CurrentSession {
    const file = this.readSessionFile();
    if (file?.read.kind === 'unexpected') {
      throw new LauncherFileError(this.sessionFilePath(), `${SESSION_FILE} is not in the shape One Launch knows (${file.read.reason})`);
    }
    const session = file?.read.kind === 'session' ? file.read.session : null;
    let owner: AccountRef | null = null;
    if (session) {
      const stored = this.deps.sessions.findByFingerprint('riot', session.fingerprint);
      owner = (stored ? this.deps.accounts.byId(stored.accountId) : null) ?? this.deps.accounts.byLauncherUid(session.accountId);
    }
    return { text: file?.text ?? null, session, owner };
  }

  async sessionState(): Promise<LauncherSessionState> {
    await this.requireInstall();
    const running = await this.isRunning();
    const current = this.currentSession();
    return {
      launcher: 'riot',
      remembered: current.session !== null,
      fingerprint: current.session?.fingerprint ?? null,
      launcherUid: current.session?.accountId ?? null,
      linkedAccountId: current.owner?.id ?? null,
      launcherRunning: running,
      lastSignIn: sessionLastSignIn(lastSignIn(currentRunEvents(this.logDir())), { running, remembered: current.session !== null }),
    };
  }

  /**
   * Stores the file as `account`'s snapshot. Only with the client closed: it rewrites the file at
   * every start and sign-in, and keeps nothing at exit unless "Stay signed in" was ticked, so the
   * file of a running client says nothing about what the next start will find (docs/adapters/riot.md).
   */
  async captureSession(account: AccountRef): Promise<{ session: LauncherSession; launcherUid: string | null }> {
    if (!account.id) throw new SwitchBlockedError('Save the account first, then capture its session.');
    await this.requireInstall();
    if (await this.isRunning()) {
      throw new SwitchBlockedError('The Riot Client is running. Right-click its tray icon, choose Exit, then save again.');
    }
    const current = this.currentSession();
    if (!current.session || current.text === null) {
      throw new SwitchBlockedError(
        `The Riot Client has no saved sign-in. Sign in to it as ${account.login} with “Stay signed in” ticked, exit the client, then save again.`,
      );
    }
    if (current.owner && current.owner.id !== account.id) {
      throw new SwitchBlockedError(
        `The sign-in the Riot Client has saved belongs to ${current.owner.displayName}. Sign in to the Riot Client as ${account.login} first.`,
      );
    }
    const uid = current.session.accountId;
    if (account.launcherUid && account.launcherUid.toLowerCase() !== uid) {
      throw new SwitchBlockedError(
        `The Riot Client's saved sign-in is Riot account ${idTail(uid)}, but ${account.displayName} is linked to ${idTail(account.launcherUid)}. Check the Riot account id on the account page.`,
      );
    }
    return this.storeSession({ ...account, id: account.id }, current.session, current.text);
  }

  /**
   * Records the Riot account id on the account, then encrypts and stores the file for it. The link
   * comes first and throws when another account holds the id, so no session is ever stored under
   * an id the link was refused for. Never logs the file.
   */
  private storeSession(account: AccountRef & { id: string }, session: RiotSession, text: string): { session: LauncherSession; launcherUid: string | null } {
    const uid = session.accountId;
    if (!account.launcherUid || account.launcherUid.toLowerCase() !== uid) this.deps.accounts.setLauncherUid(account.id, uid);
    const stored = this.deps.sessions.save({
      accountId: account.id,
      launcher: 'riot',
      launcherUid: uid,
      fingerprint: session.fingerprint,
      blob: serializeBlob({ v: 1, file: text }),
    });
    this.log.info('riot session stored', {
      accountId: account.id,
      fingerprint: shortFingerprint(stored.fingerprint),
      writeCount: session.writeCount,
      dpopBound: session.dpopBound,
    });
    return { session: stored, launcherUid: uid };
  }

  /**
   * Stores the sign-in the file holds for the One Launch account it belongs to, when it changed since
   * it was last stored (hard rule 8: before every overwrite of the file, the rollback included, what
   * it holds goes to its owner, because the client rotates the token at every start). Best effort:
   * a miss costs one manual sign-in later, never the switch. Returns one sentence for the step detail.
   */
  private storeOnDiskSession(): string {
    try {
      const current = this.currentSession();
      const { session, owner, text } = current;
      if (!session || text === null) return 'The client left no saved sign-in behind (signed out).';
      if (!owner?.id) return 'The saved sign-in belongs to no One Launch account; left alone.';
      const known = this.deps.sessions.get(owner.id);
      if (known && known.fingerprint === session.fingerprint) return `${owner.displayName}'s saved sign-in is already current.`;
      this.storeSession({ ...owner, id: owner.id }, session, text);
      return `Saved ${owner.displayName}'s sign-in (fingerprint ${shortFingerprint(session.fingerprint)}).`;
    } catch (err) {
      this.log.warn('could not save the riot sign-in the file holds', { error: errorText(err) });
      return `Not saved: ${errorText(err)}`;
    }
  }

  /** Whether the session file, as it is now, holds a sign-in that no One Launch account owns. Only meaningful while the client is closed. */
  private holdsUnownedSession(): boolean {
    try {
      const current = this.currentSession();
      return current.session !== null && !current.owner?.id;
    } catch {
      return false;
    }
  }

  // --- accounts ----------------------------------------------------------------

  /** The one account the session file names, when it holds a session. The file records no login, and the client keeps no list of past sign-ins. */
  async listRememberedAccounts(): Promise<RememberedAccountEntry[]> {
    await this.requireInstall();
    const { session, owner } = this.currentSession();
    if (!session) return [];
    return [
      {
        launcher: 'riot',
        launcherUid: session.accountId,
        login: owner?.login ?? '',
        personaName: owner?.displayName ?? (session.riotId ? riotIdText(session.riotId) : ''),
        rememberPassword: true,
        mostRecent: true,
        lastLoginAt: null,
        sessionMayBeExpired: false,
      },
    ];
  }

  // --- process ---------------------------------------------------------------

  async isRunning(): Promise<boolean> {
    return this.deps.processes.isRunning(RIOT_CLIENT_EXE);
  }

  /** The running game for the status: a listing that fails reads as no game. */
  async runningGame(): Promise<RunningGame | null> {
    try {
      return await this.findRunningGame();
    } catch (err) {
      this.log.warn('could not list processes for game detection', { error: errorText(err) });
      return null;
    }
  }

  /**
   * A game process is recognised by its image name alone (docs/adapters/riot.md, hard rule 1). A listing
   * that fails throws: a launch, a switch, or a restore refuses then, rather than go on past a game it could not see.
   */
  private async findRunningGame(names?: ReadonlySet<string>): Promise<RunningGame | null> {
    const product = productWithRunningImage(names ?? (await this.deps.processes.runningNames()));
    if (!product) return null;
    const game = (await this.installedGamesOrNone()).find((g) => g.launcherGameId.startsWith(`${product}.`)) ?? null;
    return {
      launcher: 'riot',
      launcherGameId: game?.launcherGameId ?? `${product}.live`,
      name: game?.name ?? productDisplayName(product),
      source: 'process',
    };
  }

  /** The installed games without the log read behind `needsUpdate`: the running-game check only needs their names. */
  private async installedGamesOrNone(): Promise<InstalledGame[]> {
    try {
      return (await this.detectInstall()) ? await this.gamesFrom(this.products(), new Set()) : [];
    } catch (err) {
      this.log.debug('could not list Riot games for the running-game check', { error: errorText(err) });
      return [];
    }
  }

  /** Whether one of the product's game processes is running, by image name alone (hard rule 1), from one listing. */
  private gameProcessRunning(product: string): Promise<boolean> {
    return this.deps.processes.anyRunning(gameImagesOf(product));
  }

  /** The process check for a launch watch: at most one listing every `processPollMs`, false in between, so the log is what each poll reads. */
  private gameProcessWatch(product: string): () => Promise<boolean> {
    let checkedAt = 0;
    return async () => {
      if (Date.now() - checkedAt < this.timing.processPollMs) return false;
      checkedAt = Date.now();
      return this.gameProcessRunning(product);
    };
  }

  /** Hard rule 2: no switch, and no restore, while a Riot game runs. There is no "close it for me". */
  private gameRunningError(game: RunningGame, action: string): GameRunningError {
    return new GameRunningError(`${game.name} is running. Close it, then ${action}: One Launch never closes a Riot game.`, game);
  }

  // --- shutdown ----------------------------------------------------------------

  private waitUntil(cond: () => Promise<boolean>, timeoutMs: number, signal?: AbortSignal, pollMs = this.timing.pollMs): Promise<boolean> {
    return waitUntil(cond, { timeoutMs, pollMs, signal });
  }

  /**
   * Closes the client's own processes and nothing else (docs/adapters/riot.md, hard rule 1). A window
   * close for the core, RiotClientServices.exe, whose one window (the tray icon's) swallows it on the
   * current build, so after a short wait the core is ended; it leaves the window processes behind, which
   * get a window close of their own, Riot Client.exe, whose windowless helpers get nothing and exit with
   * their parent. A forced close follows only a polite one that was ignored, and never takes the tree: a
   * running game is the core's child. A core that comes back on its own (a self-update) is given time to
   * finish starting and is closed again. Throws SwitchAbortedError when the signal aborts a wait.
   */
  async shutdown(opts: { timeoutMs?: number; signal?: AbortSignal | undefined } = {}): Promise<void> {
    await this.requireInstall();
    const { signal } = opts;
    if (!(await this.isRunning())) {
      await this.closeWindows(signal);
      return;
    }
    const timeoutMs = opts.timeoutMs ?? this.timing.shutdownMs;
    const dir = this.logDir();
    for (let attempt = 1; ; attempt++) {
      const mark = logMark(dir);
      this.log.info('asking the Riot Client to close', { timeoutMs, attempt });
      await this.deps.processes.close(RIOT_CLIENT_EXE);
      let ended = false;
      if (!(await this.waitUntil(async () => !(await this.isRunning()), timeoutMs, signal))) {
        this.log.warn('the Riot Client did not exit in time; ending it');
        await this.deps.processes.kill(RIOT_CLIENT_EXE, { tree: false });
        ended = true;
        if (!(await this.waitUntil(async () => !(await this.isRunning()), this.timing.killGraceMs, signal))) {
          throw new Error(`${RIOT_CLIENT_EXE} is still running after a window close and a forced close`);
        }
      }
      await this.closeWindows(signal);
      if (!(await this.watchForRestart(dir, mark, signal, ended))) return;
      if (attempt >= 3) throw new Error(`${RIOT_CLIENT_EXE} keeps restarting itself after being closed`);
      this.log.info('the Riot Client restarted itself after closing; letting it finish starting before closing it again');
      await this.waitUntil(async () => logMark(dir).file !== mark.file && startupFinished(currentRunEvents(dir)), this.timing.restartSettleMs, signal);
    }
  }

  /**
   * Whether the core comes back after an exit (a self-update restart). The watch shortens to `cleanExitWatchMs` the
   * moment the log gains the lock-file removal, the core's last line of a clean exit, whenever that line lands, and
   * from the start after a forced close: an ended core has no updater left to bring it back.
   */
  private async watchForRestart(dir: string, mark: LogMark, signal?: AbortSignal, ended = false): Promise<boolean> {
    const started = Date.now();
    let short = ended;
    for (;;) {
      if (signal?.aborted) throw new SwitchAbortedError();
      if (await this.isRunning()) return true;
      short ||= exitedCleanly(eventsSince(dir, mark));
      if (Date.now() - started >= (short ? this.timing.cleanExitWatchMs : this.timing.restartWatchMs)) return false;
      await sleep(this.timing.pollMs, signal);
    }
  }

  /** The window processes, once the core is gone (or was never there). The tray icon lingers until hovered; the processes are what count. */
  private async closeWindows(signal?: AbortSignal): Promise<void> {
    const running = (): Promise<boolean> => this.deps.processes.isRunning(RIOT_CLIENT_WINDOW_EXE);
    if (!(await running())) return;
    this.log.info('asking the Riot Client window to close');
    await this.deps.processes.close(RIOT_CLIENT_WINDOW_EXE);
    if (await this.waitUntil(async () => !(await running()), this.timing.windowCloseMs, signal)) return;
    this.log.warn('the Riot Client window did not exit in time; ending it');
    await this.deps.processes.kill(RIOT_CLIENT_WINDOW_EXE, { tree: false });
    if (!(await this.waitUntil(async () => !(await running()), this.timing.killGraceMs, signal))) {
      throw new Error(`${RIOT_CLIENT_WINDOW_EXE} is still running after a window close and a forced close`);
    }
  }

  /**
   * Starts the game the way its own shortcut does (hard rule 10): RiotClientServices.exe with
   * --launch-product and --launch-patchline, handed to the running client (the second process messages
   * the singleton and exits) or starting the client when it is closed. When the switch just started the client
   * with these arguments (`startedBySwitch`) and the run's log shows the product context, nothing is sent and
   * the run is watched from its start: the sign-in and the page came up together. Riot has turned auto-launch off on
   * build 140 (its feature flag, logged as "Auto-launch is disabled"), so the client only opens the game's
   * page, brings its window forward, and waits for Play, exactly as the game's own shortcut does now. Once
   * the page is up (the launch pipeline reached WaitForLaunch, or the client said why it is not launching)
   * One Launch presses Play for the user when the setting is on (the launch request the client's own Play
   * button sends, rule 4's one exception) and the game's process name or the launch lines confirm the start;
   * otherwise, or when the request did not take, the result hands over to the user with what to do. A
   * client that starts the game on its own is confirmed the same way. Refused outright while a Riot game
   * runs (nothing touches one, hard rule 1) and when the client's newest log says the product is out of
   * date (its Play button reads Update). The login page logged meanwhile fails the launch with that reason,
   * and silence fails it when the watch runs out.
   */
  async launchGame(
    game: Pick<InstalledGame, 'launcherGameId' | 'name'>,
    opts: { signal?: AbortSignal | undefined; startedBySwitch?: boolean } = {},
  ): Promise<{ command: string; handOff?: string }> {
    const id = parseProductId(game.launcherGameId);
    if (!id) throw new Error(`Not a Riot product id: ${game.launcherGameId}`);
    const install = await this.requireInstall();
    const names = await this.deps.processes.runningNames();
    const running = await this.findRunningGame(names);
    if (running) {
      if (running.launcherGameId.split('.')[0] === id.product) throw new GameRunningError(`${running.name} is already running.`, running);
      throw this.gameRunningError(running, 'press Play again');
    }
    const logDir = this.logDir();
    // Thrown messages reach the dialog as "Riot Games: <message>", so they start with the game.
    const needsUpdate = (): GameNotPlayableError =>
      new GameNotPlayableError(`${game.name} needs an update before it can start. Update it in the Riot Client window, then press Play again.`);
    if (productsNeedingUpdate(currentRunEvents(logDir)).has(id.id)) throw needsUpdate();

    const args = launchArgs(id);
    const command = `"${install.exePath}" ${args.join(' ')}`;
    const clientRunning = names.has(processNameOf(RIOT_CLIENT_EXE));
    const underway = opts.startedBySwitch === true && clientRunning && launchAccepted(currentRunEvents(logDir), id.product, id.patchline);
    const how = underway ? 'the switch started the client with these arguments; ' : '';
    const mark = logMark(logDir);
    const read = underway ? (): LogEvent[] => currentRunEvents(logDir) : (): LogEvent[] => eventsSince(logDir, mark);
    const pressPlay = this.pressPlayOn();
    const gameUp = this.gameProcessWatch(id.product);
    this.log.info('launching game', { product: id.id, name: game.name, clientRunning, pressPlay, underway });
    if (!underway) await this.deps.processes.start(install.exePath, args, { cwd: dirname(install.exePath) });

    let outOfDate = false;
    let pageShown = false;
    let loginPage: Extract<SignInOutcome, { ok: false }> | null = null;
    let started = false;
    let stopped = false;
    try {
      started = await this.waitUntil(
        async () => {
          const events = read();
          if (productsNeedingUpdate(events).has(id.id)) {
            outOfDate = true;
            return true;
          }
          if (gameStarted(events, id.product, id.patchline) || (await gameUp())) return true;
          if (launchPageShown(events, id.product, id.patchline)) {
            pageShown = true;
            return true;
          }
          const verdict = lastSignIn(events);
          if (verdict && !verdict.ok) {
            loginPage = verdict;
            return true;
          }
          return false;
        },
        this.timing.launchConfirmMs,
        opts.signal,
        this.timing.logPollMs,
      );
    } catch (err) {
      if (!(err instanceof SwitchAbortedError)) throw err;
      stopped = true;
    }
    const events = read();
    const accepted = launchAccepted(events, id.product, id.patchline);
    const declined = launchDeclined(events, id.product, id.patchline);
    const play = pageShown && pressPlay ? await this.pressPlay(id, read, opts.signal) : null;
    const ok = (started && !outOfDate && !pageShown && !loginPage) || play?.outcome === 'started';
    this.log.info('launch command sent', {
      product: id.id,
      clientRunning,
      started: ok,
      pageShown,
      declined,
      outOfDate: outOfDate || play?.outcome === 'out-of-date',
      loginPage: loginPage !== null,
      accepted,
      stopped: stopped || play?.outcome === 'stopped',
      play: play?.outcome ?? null,
    });
    if (outOfDate || play?.outcome === 'out-of-date') throw needsUpdate();
    if (loginPage) {
      throw new Error(
        `The Riot Client opened on its login page instead of signing in (${(loginPage as Extract<SignInOutcome, { ok: false }>).detail}), so ${game.name} was not started. Sign in there with “Stay signed in” ticked and press Play; One Launch saves the sign-in at the next switch.`,
      );
    }
    if (play?.outcome === 'started') return { command: `${command} (${how}One Launch pressed Play and the Riot Client started the game)` };
    if (stopped || play?.outcome === 'stopped') return { command: `${command} (${how}stopped watching for the game start)` };
    if (pageShown) {
      return {
        command: `${command} (${how}the Riot Client opened the game's page${declined ? `: ${declined}` : ''}${play?.reason ? `; ${play.reason}` : ''})`,
        handOff: `Press Play in the Riot Client window to start ${game.name}; it is open on the game's page.`,
      };
    }
    if (ok) return { command: `${command} (${how}the Riot Client started the game)` };
    throw new Error(
      accepted
        ? `${game.name} did not start within ${this.timing.launchConfirmMs / 1000} s. Look at the Riot Client window: the game may need an update or a repair, or the client may be waiting for you.`
        : `The Riot Client did not act on the launch within ${this.timing.launchConfirmMs / 1000} s. Look at the Riot Client window: it may be updating itself or asking you to sign in.`,
    );
  }

  /** Whether One Launch presses Play for the user: the setting, and a channel to the client's local server (the real one, or the simulator's). */
  private pressPlayOn(): boolean {
    return this.deps.localLaunch !== undefined && (this.deps.pressPlay?.() ?? false);
  }

  /**
   * Presses Play for the user: the launch request the client's own Play button sends to its local server
   * (docs/adapters/riot.md, rule 4's one exception), then the same confirmation as for a launch the client
   * made on its own. Never the reason a launch fails: a request the client refused or did not act on leaves
   * the hand-over as it was, with what happened.
   */
  private async pressPlay(
    id: RiotProductId,
    read: () => LogEvent[],
    signal?: AbortSignal,
  ): Promise<{ outcome: 'started' | 'declined' | 'silent' | 'out-of-date' | 'stopped'; reason: string | null }> {
    this.log.info('pressing Play for the user', { product: id.id });
    try {
      await this.deps.localLaunch!.launch({ product: id.product, patchline: id.patchline, lockfilePath: this.lockfilePath(), signal });
    } catch (err) {
      if (signal?.aborted) return { outcome: 'stopped', reason: null };
      this.log.warn('the Riot Client did not take the launch request', { product: id.id, error: errorText(err) });
      return { outcome: 'declined', reason: `the launch request was not taken: ${errorText(err)}` };
    }
    let outOfDate = false;
    const gameUp = this.gameProcessWatch(id.product);
    try {
      const started = await this.waitUntil(
        async () => {
          const events = read();
          if (productsNeedingUpdate(events).has(id.id)) {
            outOfDate = true;
            return true;
          }
          return gameStarted(events, id.product, id.patchline) || (await gameUp());
        },
        this.timing.playConfirmMs,
        signal,
        this.timing.logPollMs,
      );
      if (outOfDate) return { outcome: 'out-of-date', reason: null };
      if (started) return { outcome: 'started', reason: null };
    } catch (err) {
      if (!(err instanceof SwitchAbortedError)) throw err;
      return { outcome: 'stopped', reason: null };
    }
    return {
      outcome: 'silent',
      reason: `the Riot Client took the launch request but did not start the game within ${this.timing.playConfirmMs / 1000} s`,
    };
  }

  // --- switching -------------------------------------------------------------

  /** What a close does, for the confirmation. A running game never gets this far: the switch is refused instead (hard rule 2). */
  private closeMessage(): string {
    return 'The Riot Client is running. Switching closes it.';
  }

  async preflight(account: AccountRef, forGame?: Pick<InstalledGame, 'launcherGameId' | 'name'>): Promise<SwitchPreflight> {
    const { plan, ctx } = await this.buildSwitchPlan(account, forGame);
    if (ctx.game) throw this.gameRunningError(ctx.game, 'switch');
    return { plan, launcherRunning: ctx.running, runningGame: null, alreadyActive: ctx.alreadyActive, closeMessage: this.closeMessage() };
  }

  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: true }): Promise<SwitchPlan>;
  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: false }): Promise<SwitchResult>;
  switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult>;
  async switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult> {
    if (opts.dryRun) return (await this.buildSwitchPlan(account, opts.game)).plan;
    return this.runSwitch(account, opts);
  }

  /**
   * Reads everything the real switch would read and describes every change it would make. Decrypts nothing.
   * `forGame` is the game a launch follows the switch with: the client is then started with its launch arguments.
   */
  private async buildSwitchPlan(
    account: AccountRef,
    forGame?: Pick<InstalledGame, 'launcherGameId' | 'name'>,
  ): Promise<{ plan: SwitchPlan; ctx: PlanContext }> {
    const install = await this.requireInstall();
    const sessionPath = this.sessionFilePath();
    const logDir = this.logDir();
    const names = await this.deps.processes.runningNames();
    const running = names.has(processNameOf(RIOT_CLIENT_EXE));
    const game = await this.findRunningGame(names);
    const current = this.currentSession();
    const stored = account.id ? this.deps.sessions.get(account.id) : null;
    const warnings: string[] = [];
    const notes: string[] = [];

    /**
     * The file names the account the client signs in as, whether the client runs or not: it is written
     * at every sign-in and sign-out. A running client also needs its log to confirm it is signed in.
     */
    const inPlace = current.owner !== null && current.owner.id === account.id && current.session !== null;
    const alreadyActive = inPlace && running && lastSignIn(currentRunEvents(logDir))?.ok === true;
    const strategy: SwitchStrategy = inPlace || (stored !== null && stored.staleReason === null) ? 'remembered' : 'credentials';
    const usesStored = strategy === 'remembered' && !inPlace;
    const login = account.login;
    const expectedUid = stored?.launcherUid ?? account.launcherUid?.toLowerCase() ?? null;

    const steps: SwitchPlanStep[] = [];
    const step = (s: Omit<SwitchPlanStep, 'changes' | 'skipped'> & Partial<Pick<SwitchPlanStep, 'changes' | 'skipped'>>): void => {
      steps.push({ changes: [], skipped: false, ...s });
    };

    step({
      id: STEP.close,
      kind: 'process',
      title: 'Close the Riot Client',
      target: RIOT_CLIENT_EXE,
      skipped: !running || alreadyActive,
      detail: alreadyActive
        ? 'Skipped: the client is already signed in as this account, so it is left running.'
        : running
          ? `Send ${RIOT_CLIENT_EXE} a window close and wait up to ${this.timing.shutdownMs / 1000} s; a process that ignores the close is ended on its own, never with its children: a running game would refuse the switch before this step. Then the same for the window processes it leaves behind (${RIOT_CLIENT_WINDOW_EXE}).`
          : `Skipped: ${RIOT_CLIENT_EXE} is not running.`,
    });

    const outgoing = current.owner;
    const outgoingStored = outgoing?.id ? this.deps.sessions.get(outgoing.id) : null;
    const outgoingChanged = outgoing !== null && outgoingStored?.fingerprint !== current.session?.fingerprint;
    /** Saving reads the file after the client has closed (it rotates the token at every start and writes the file at exit) and writes only One Launch's own database. */
    const captureNeeded = outgoing !== null && !alreadyActive && (running || (current.session !== null && (!inPlace || outgoingChanged)));
    step({
      id: STEP.capture,
      kind: 'backup',
      title: inPlace ? "Save this account's sign-in" : 'Save the outgoing sign-in',
      target: sessionPath,
      skipped: !captureNeeded,
      detail: alreadyActive
        ? 'Skipped: the client stays running, so its file is not re-read.'
        : outgoing === null
          ? current.session
            ? `Skipped: the client holds a sign-in (Riot account ${idTail(current.session.accountId)}) that no One Launch account owns, so it is left alone and not saved. To keep it, save it from that account's page before switching.`
            : 'Skipped: the client holds no saved sign-in.'
          : !captureNeeded
            ? `Skipped: ${outgoing.displayName}'s saved sign-in already matches what the client holds.`
            : running
              ? `After the client has closed, read ${SESSION_FILE} and, if it holds ${outgoing.displayName}'s sign-in and it changed, store the file, encrypted, as the account's saved sign-in. Nothing in the client's files changes.`
              : inPlace
                ? `${SESSION_FILE} holds ${outgoing.displayName}'s sign-in but it differs from the saved copy (${outgoingStored ? 'the client rotated the token' : 'no copy yet'}), so store the file, encrypted, as the account's saved sign-in. Nothing in the client's files changes.`
                : `${SESSION_FILE} holds ${outgoing.displayName}'s sign-in${outgoingChanged ? ' and it changed since it was last saved (the client rotates the token at every start)' : ''}; store the file, encrypted, as the account's saved sign-in if it changed. Nothing in the client's files changes.`,
    });

    step({
      id: STEP.backup,
      kind: 'backup',
      title: `Back up ${SESSION_FILE}`,
      target: this.deps.backups.previewPath('riot'),
      skipped: alreadyActive || inPlace,
      detail:
        alreadyActive || inPlace
          ? 'Skipped: the file will not be modified.'
          : `Copy ${sessionPath}, encrypted, into a new snapshot folder so a failed switch can be rolled back. The newest ${this.deps.backupsToKeep()} snapshots are kept.`,
    });

    const before = (): string =>
      current.text === null
        ? '(absent)'
        : current.session
          ? `(saved sign-in for Riot account ${idTail(current.session.accountId)}, fingerprint ${shortFingerprint(current.session.fingerprint)})`
          : 'null (signed out)';
    if (inPlace) {
      step({
        id: STEP.file,
        kind: 'file',
        title: "Put the account's sign-in in place",
        target: sessionPath,
        skipped: true,
        detail: `No change: ${SESSION_FILE} already holds ${account.displayName}'s sign-in (fingerprint ${shortFingerprint(current.session?.fingerprint ?? null)}).`,
      });
    } else if (usesStored && stored) {
      const changes: SwitchChange[] = [
        {
          where: 'psl.authorization.riot-client',
          before: before(),
          after: `(saved copy for ${account.displayName}, fingerprint ${shortFingerprint(stored.fingerprint)}, saved ${stored.capturedAt})`,
        },
      ];
      step({
        id: STEP.file,
        kind: 'file',
        title: "Put the account's sign-in in place",
        target: sessionPath,
        detail: `Decrypt ${account.displayName}'s saved copy of ${SESSION_FILE} from the vault and write it over the file, whole, as the client itself left it (its sign-in, token write count and device cookie together): the swap confirmed by hand on the real client. The new content is written to a temp file and renamed over the original. The copy is never shown or logged.`,
        changes,
      });
    } else {
      const signedOut = current.text === null || current.session === null;
      step({
        id: STEP.file,
        kind: 'file',
        title: 'Sign the client out',
        target: sessionPath,
        skipped: signedOut,
        detail: signedOut
          ? current.text === null
            ? `No change: there is no ${SESSION_FILE}, so the client opens on its login page.`
            : 'No change: the client holds no saved sign-in, so it opens on its login page.'
          : `Set psl.authorization.riot-client to null, the state the client itself writes at a sign-out, and leave every other line (the device cookie included) as it is, so the client opens on its login page instead of signing in as ${
              outgoing ? outgoing.displayName : `Riot account ${idTail(current.session?.accountId ?? null)}`
            }.`,
        changes: signedOut ? [] : [{ where: 'psl.authorization.riot-client', before: before(), after: 'null (signed out)' }],
      });
    }

    const launchFor = forGame ? parseProductId(forGame.launcherGameId) : null;
    step({
      id: STEP.start,
      kind: 'launch',
      title: 'Start the Riot Client',
      target: [`"${install.exePath}"`, ...(launchFor ? launchArgs(launchFor) : [])].join(' '),
      skipped: alreadyActive,
      detail: alreadyActive
        ? 'Skipped: the client is already running as this account.'
        : launchFor && forGame
          ? strategy === 'remembered'
            ? `Start the client with ${forGame.name}'s launch arguments, as the game's own shortcut does. It signs in as ${login} on its own from the saved sign-in and opens the game's page.`
            : `Start the client with ${forGame.name}'s launch arguments, as the game's own shortcut does. With no saved sign-in it opens on its login page, and the game's page follows the sign-in.`
          : strategy === 'remembered'
            ? `Start the client with no arguments, as its own shortcut does. It signs in as ${login} on its own from the saved sign-in.`
            : 'Start the client with no arguments. With no saved sign-in it opens on its login page.',
    });

    step({
      id: STEP.wait,
      kind: 'wait',
      title: 'Wait for the client to come up',
      target: RIOT_CLIENT_EXE,
      skipped: alreadyActive,
      detail: `Poll the process list until ${RIOT_CLIENT_EXE} is running, up to ${this.timing.startupMs / 1000} s.`,
    });

    step({
      id: STEP.verify,
      kind: 'wait',
      title: 'Confirm the client signed in',
      target: logDir,
      skipped: alreadyActive,
      detail: alreadyActive
        ? 'Skipped: the client is already signed in as this account.'
        : strategy === 'remembered'
          ? `Read what the client appends to its new run log (no tokens in it) until it reports a sign-in verdict, up to ${this.timing.signInMs / 1000} s: the signed-in state (PendingProductContext), after which ${SESSION_FILE} names the Riot account id, which must be ${
              expectedUid ? idTail(expectedUid) : 'an id no other account holds, which is then recorded on the account'
            }; or the login page (PendingLoginStrategy), which hands over to you in the next step. Only an invalid_grant refusal marks the saved copy stale.`
          : `Read what the client appends to its new run log until it reports a sign-in verdict. With no saved sign-in it opens on its login page, so this goes straight to the next step.`,
    });

    step({
      id: STEP.manual,
      kind: 'wait',
      title: 'Wait for you to sign in',
      target: logDir,
      skipped: strategy === 'remembered',
      detail:
        strategy === 'remembered'
          ? `Runs only if the client refuses the saved sign-in or does not sign in within ${this.timing.signInMs / 1000} s. The client stays on its login page; you sign in there once as ${login} with “Stay signed in” ticked${
              account.hasSecret ? ' (the password can be copied from One Launch)' : ''
            } and One Launch continues as soon as the log reports the sign-in, up to ${this.timing.manualSignInMs / 60_000} min.`
          : `The client opens on its login page. Sign in there as ${login} with “Stay signed in” ticked${
              account.hasSecret ? ' (the password can be copied from One Launch)' : ''
            }. One Launch continues as soon as the log reports the sign-in, up to ${this.timing.manualSignInMs / 60_000} min. Signing in as a different Riot account than the one linked to ${account.displayName} ends the switch and puts the file back.`,
    });

    step({
      id: STEP.recapture,
      kind: 'backup',
      title: 'Save the new sign-in',
      target: sessionPath,
      skipped: strategy === 'remembered',
      detail:
        strategy === 'remembered'
          ? 'Runs only after a manual sign-in: the fresh sign-in replaces the stale saved copy.'
          : `Once the sign-in is reported, wait up to ${this.timing.captureMs / 1000} s for the client to write ${SESSION_FILE}, then store the file, encrypted, as ${account.displayName}'s saved sign-in and record the Riot account id on the account. If the client writes it later, it is saved at the next switch instead. Later switches use the saved sign-in.`,
    });

    if (game) warnings.push(`${game.name} is running. Close it first: One Launch never closes a Riot game, and no switch runs while one does.`);
    if (current.text === null) {
      warnings.push(
        `${sessionPath} does not exist. One Launch never creates it: start the Riot Client once by hand (it writes the file at its first start), then try again.`,
      );
    }
    if (alreadyActive) {
      notes.push(
        `The Riot Client is running and signed in as ${account.displayName}. The real switch would change nothing and would leave the client running.`,
      );
    } else if (running) {
      warnings.push(
        `The Riot Client is running${current.owner ? ` as ${current.owner.displayName}` : current.session ? ' with a sign-in no One Launch account owns' : ' on its login page'}. It will be closed.`,
      );
    } else if (inPlace) {
      notes.push(`The Riot Client already holds ${account.displayName}'s sign-in, so it is only started.`);
    }
    if (stored?.staleReason && !inPlace) {
      warnings.push(
        `${account.displayName}'s saved sign-in no longer works: ${stored.staleReason}. You will sign in once by hand, with “Stay signed in” ticked, and One Launch stores the fresh sign-in.`,
      );
    }
    if (strategy === 'credentials' && !stored && !inPlace) {
      warnings.push(
        `No sign-in is saved for ${account.displayName} yet. The client will open on its login page; sign in once with “Stay signed in” ticked and One Launch saves it for later switches.${
          account.hasSecret ? '' : ' No password is stored in One Launch, so have it ready.'
        }`,
      );
    }
    if (!inPlace && current.session && outgoing === null) {
      warnings.push(
        `The Riot Client holds a sign-in that no One Launch account owns (Riot account ${idTail(current.session.accountId)}). It will be replaced. The backup taken before this switch keeps a copy and is left out of the usual clean-up, so restoring it from Settings › Backups brings that sign-in back.`,
      );
    }
    if (stored && account.launcherUid && stored.launcherUid && stored.launcherUid.toLowerCase() !== account.launcherUid.toLowerCase()) {
      warnings.push(
        `The Riot account id on this account (${idTail(account.launcherUid)}) differs from the one recorded with its saved sign-in (${idTail(stored.launcherUid)}). The saved sign-in's id is used to confirm the sign-in.`,
      );
    }

    const plan: SwitchPlan = {
      launcher: 'riot',
      account: { id: account.id, displayName: account.displayName, login: account.login, launcherUid: expectedUid },
      strategy,
      current: { mostRecentLogin: current.owner?.login ?? null, autoLoginUser: null, running },
      steps,
      warnings,
      notes,
      executable: current.text !== null,
      generatedAt: new Date().toISOString(),
    };
    return { plan, ctx: { install, current, stored, strategy, inPlace, alreadyActive, running, game } };
  }

  /**
   * The real switch. Order: refuse while a game runs → close → save the outgoing sign-in → snapshot →
   * write the file → start → confirm from the log and the file. A refused or missing sign-in hands
   * over to the user for one manual sign-in, after which the fresh file is stored. Anything that
   * fails after the first write is rolled back from the snapshot (after storing what the file holds
   * for its owner), with the client left closed.
   */
  private async runSwitch(account: AccountRef, opts: SwitchOptions): Promise<SwitchResult> {
    const startedAt = new Date().toISOString();
    const { plan, ctx } = await this.buildSwitchPlan(account, opts.game);
    const { install } = ctx;
    const login = account.login;
    const sessionPath = this.sessionFilePath();
    const logDir = this.logDir();

    if (ctx.game) throw this.gameRunningError(ctx.game, 'switch');
    if (!plan.executable) throw new SwitchBlockedError(plan.warnings[0] ?? 'This switch cannot run.');
    if (ctx.running && !ctx.alreadyActive && !opts.confirmClose) throw new ConfirmationRequiredError(this.closeMessage(), null);

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
      extra: Pick<SwitchResult, 'backupId' | 'restored' | 'error' | 'needsSignIn' | 'cancelled'> & Partial<Pick<SwitchResult, 'readyAt' | 'startedWithGame'>>,
    ): SwitchResult => ({
      launcher: 'riot',
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
    /** Once the client has been started again an abort no longer rolls back: the client is reading what was written. */
    let launcherStarted = false;
    let readyAt: string | null = null;
    /** The game whose launch arguments the client is started with, when a launch follows (rule 10: the game's own shortcut). */
    const launchFor = opts.game ? parseProductId(opts.game.launcherGameId) : null;
    let startedWithGame: string | null = null;
    let handedOver = false;
    const stopIfAborted = (): void => {
      if (opts.signal?.aborted) throw new SwitchAbortedError();
    };
    let expectedUid = plan.account.launcherUid?.toLowerCase() ?? null;
    /** Fingerprint of the sign-in we left in the file, so the client's own rewrite can be told apart from our write. */
    let writtenFingerprint: string | null = ctx.current.session?.fingerprint ?? null;

    /** Runs once the client is closed: the file then holds what the last run left. */
    const saveOutgoing = (): void => {
      const i = index.get(STEP.capture);
      if (i === undefined || steps[i]!.status === 'skipped') return;
      mark(STEP.capture, 'running');
      mark(STEP.capture, 'done', this.storeOnDiskSession());
    };
    const takeSnapshot = (): void => {
      mark(STEP.backup, 'running');
      // The client is closed by now, so the file is final: a sign-in nobody owns is about to be replaced, and this snapshot is its only copy.
      const unowned = !ctx.inPlace && this.holdsUnownedSession();
      const snapshot = this.deps.backups.snapshot({
        launcher: 'riot',
        reason: `Before switching to ${account.displayName}`,
        files: [{ source: sessionPath, relative: SESSION_FILE_RELATIVE, sensitive: true }],
        ...(unowned ? { pinned: UNOWNED_SESSION_PIN } : {}),
      });
      backupId = snapshot.id;
      opts.onBackup?.(snapshot.id);
      mark(STEP.backup, 'done', snapshot.path);
    };
    /** The stored copy is decrypted here and nowhere else, written once, and dropped. */
    const writeSession = (): void => {
      mark(STEP.file, 'running');
      const text = this.readSessionFile()?.text ?? null;
      // Never fabricate the client's file: it carries the device cookie Riot uses to recognise this PC (hard rule 7).
      if (text === null) {
        throw new SwitchBlockedError(`${sessionPath} is missing. Start the Riot Client once by hand so it writes its settings file, then try again.`);
      }
      if (plan.strategy === 'remembered') {
        if (!account.id) throw new SwitchBlockedError(`No sign-in is saved for ${account.displayName}.`);
        const json = this.deps.sessions.decrypt(account.id);
        if (!json) throw new SwitchBlockedError(`No sign-in is saved for ${account.displayName}.`);
        const blob = parseBlob(json);
        const session = sessionOfBlob(blob);
        if (blob.file === text) {
          writtenFingerprint = session.fingerprint;
          mark(STEP.file, 'skipped', 'Already in place.');
          return;
        }
        modified = true;
        writeFileAtomic(sessionPath, blob.file);
        writtenFingerprint = session.fingerprint;
        mark(STEP.file, 'done', `${SESSION_FILE} now holds the saved copy (fingerprint ${shortFingerprint(writtenFingerprint)}).`);
        return;
      }
      const write = planSignOut(text);
      writtenFingerprint = null;
      if (write.noop) {
        mark(STEP.file, 'skipped', 'Already signed out.');
        return;
      }
      modified = true;
      writeFileAtomic(sessionPath, write.text);
      mark(STEP.file, 'done', `${SESSION_FILE} now holds the client's signed-out state; everything else in it is as it was.`);
    };
    /** Something other than this switch started the client. Before the writes nothing is lost by stopping; after them the catch block rolls back. */
    const startedMeanwhile = (at: string): Error => {
      mark(at, 'running');
      return new Error(
        `The Riot Client was started by something else while One Launch was switching accounts, so the switch ${modified ? 'was stopped' : 'stopped before changing anything'}. Try again.`,
      );
    };
    let logAt: LogMark = logMark(logDir);
    const startLauncher = async (): Promise<void> => {
      mark(STEP.start, 'running');
      stopIfAborted();
      logAt = logMark(logDir);
      launcherStarted = true;
      await this.deps.processes.start(install.exePath, launchFor ? launchArgs(launchFor) : [], { cwd: dirname(install.exePath) });
      if (launchFor && opts.game) {
        startedWithGame = opts.game.launcherGameId;
        mark(STEP.start, 'done', `Client started with ${opts.game.name}'s launch arguments.`);
      } else {
        mark(STEP.start, 'done', 'Client started.');
      }
      mark(STEP.wait, 'running');
      if (!(await this.waitUntil(() => this.isRunning(), this.timing.startupMs, opts.signal))) {
        throw new Error(`${RIOT_CLIENT_EXE} did not appear within ${this.timing.startupMs / 1000} s`);
      }
      mark(STEP.wait, 'done', `${RIOT_CLIENT_EXE} is running.`);
    };
    /** The account id the file names right now, or null while it holds no session (or is mid-write). */
    const fileNames = (): RiotSession | null => {
      try {
        const file = this.readSessionFile();
        return file?.read.kind === 'session' ? file.read.session : null;
      } catch {
        return null;
      }
    };
    /**
     * Polls the client's new run log for its verdict, then the file for the account id (the log never
     * names the account; the client writes the file before it logs the signed-in state). During a manual
     * wait a verdict that is not a sign-in (the login page, a sign-out) is not final.
     */
    const waitForSignIn = async (timeoutMs: number, manual: boolean): Promise<SignInWait> => {
      const deadline = Date.now() + timeoutMs;
      let fileDeadline: number | null = null;
      for (;;) {
        if (opts.signal?.aborted) return { kind: 'cancelled' };
        const last = lastSignIn(eventsSince(logDir, logAt));
        if (last?.ok) {
          const session = fileNames();
          if (session) {
            const uid = session.accountId;
            const owner = this.deps.accounts.byLauncherUid(uid);
            if (expectedUid === null) {
              // The file names only an opaque id, so an id nobody holds is taken as this account's. One that another account holds is not.
              if (owner && owner.id !== account.id) return { kind: 'wrong-account', accountId: uid, owner };
              return { kind: 'signed-in', accountId: uid };
            }
            if (uid === expectedUid) return { kind: 'signed-in', accountId: uid };
            return { kind: 'wrong-account', accountId: uid, owner };
          }
          fileDeadline ??= Date.now() + this.timing.captureMs;
          if (Date.now() >= fileDeadline) return { kind: 'signed-in', accountId: null };
        } else if (last && !manual) {
          return { kind: 'failed', outcome: last };
        }
        if (Date.now() >= deadline) return { kind: 'timeout' };
        await sleep(this.timing.logPollMs, opts.signal);
      }
    };
    const wrongAccount = (r: { accountId: string; owner: AccountRef | null }): Error => {
      const who = r.owner ? `${r.owner.displayName} (Riot account ${idTail(r.accountId)})` : `Riot account ${idTail(r.accountId)}`;
      return new Error(
        expectedUid === null
          ? `The Riot Client signed in as ${who}, which is another One Launch account, instead of ${account.displayName}. Sign in to the client as ${login}.`
          : `The Riot Client signed in as ${who} instead of ${account.displayName} (${idTail(expectedUid)}). Sign in to the client as ${login}, or fix the Riot account id on the account page.`,
      );
    };
    /** A first confirmed sign-in is where the account's Riot id comes from. Throws when another account holds it. */
    const linkIfNew = (signedInAs: string | null): string => {
      if (!account.id || !signedInAs || expectedUid !== null) return '';
      this.deps.accounts.setLauncherUid(account.id, signedInAs);
      expectedUid = signedInAs;
      this.log.info('riot account id linked', { accountId: account.id });
      return ` Linked to Riot account ${idTail(signedInAs)}.`;
    };
    const signedInDetail = (r: Extract<SignInWait, { kind: 'signed-in' }>): string =>
      r.accountId
        ? `Signed in as ${login}.${linkIfNew(r.accountId)}`
        : `Signed in as ${login} (the client has not written ${SESSION_FILE} yet, so the account id is unconfirmed).`;
    const confirmSignIn = async (): Promise<SignInWait> => {
      mark(STEP.verify, 'running');
      const r = await waitForSignIn(plan.strategy === 'remembered' ? this.timing.signInMs : 1, false);
      if (r.kind === 'signed-in') mark(STEP.verify, 'done', signedInDetail(r));
      else if (r.kind === 'wrong-account') mark(STEP.verify, 'failed', 'Signed in as a different account.');
      else if (r.kind === 'failed') mark(STEP.verify, 'failed', `The client ended on its login page: ${r.outcome.detail}.`);
      else if (r.kind === 'timeout')
        mark(STEP.verify, 'failed', plan.strategy === 'remembered' ? 'The client did not report a sign-in in time.' : 'Waiting for you.');
      else mark(STEP.verify, 'failed', 'Cancelled.');
      return r;
    };
    const waitForManualSignIn = async (why: SignInWait): Promise<SignInWait> => {
      const until = new Date(Date.now() + this.timing.manualSignInMs).toISOString();
      const cause = plan.strategy === 'credentials' ? 'new' : why.kind === 'failed' && why.outcome.reason === 'rejected' ? 'expired' : 'other';
      const reason = why.kind === 'failed' && why.outcome.reason !== 'no-session' ? why.outcome.detail : null;
      const attention = attentionFor(login, cause, reason, account.hasSecret && Boolean(opts.getPassword), until);
      mark(STEP.manual, 'running', attention.title);
      this.log.warn('riot switch waiting for manual sign-in', { accountId: account.id, cause, backupId });
      handedOver = true;
      opts.onAttention?.(attention);
      try {
        const r = await waitForSignIn(this.timing.manualSignInMs, true);
        if (r.kind === 'signed-in') mark(STEP.manual, 'done', signedInDetail(r));
        else if (r.kind === 'wrong-account') mark(STEP.manual, 'failed', 'Signed in as a different account.');
        else if (r.kind === 'cancelled') mark(STEP.manual, 'failed', 'Stopped waiting.');
        else mark(STEP.manual, 'failed', `No sign-in after ${this.timing.manualSignInMs / 60_000} min.`);
        return r;
      } finally {
        opts.onAttention?.(null);
      }
    };
    /**
     * After a confirmed manual sign-in: store the file once the client has written a sign-in that
     * differs from what was there, for up to `waitMs`. The file names the account, so a copy that
     * names another one (the user changed accounts in the client meanwhile) is not stored.
     */
    const captureFresh = async (waitMs: number): Promise<void> => {
      if (!account.id) return;
      mark(STEP.recapture, 'running');
      const deadline = Date.now() + waitMs;
      for (;;) {
        const file = this.readSessionFile();
        const session = file?.read.kind === 'session' ? file.read.session : null;
        if (file && session && session.fingerprint !== writtenFingerprint) {
          if (expectedUid !== null && session.accountId !== expectedUid) {
            mark(STEP.recapture, 'done', `Not saved: ${SESSION_FILE} names Riot account ${idTail(session.accountId)}, not this account's.`);
            return;
          }
          this.storeSession({ ...account, id: account.id }, session, file.text);
          this.deps.sessions.markVerified(account.id);
          mark(STEP.recapture, 'done', `Stored ${account.displayName}'s sign-in (fingerprint ${shortFingerprint(session.fingerprint)}).`);
          return;
        }
        if (Date.now() >= deadline || opts.signal?.aborted) {
          if (session && this.deps.sessions.get(account.id)?.fingerprint === session.fingerprint) {
            this.deps.sessions.markVerified(account.id);
            mark(STEP.recapture, 'done', 'The saved sign-in is current.');
          } else {
            mark(STEP.recapture, 'done', 'The client has not written the new sign-in yet; it is saved at the next switch.');
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
          ? `Stopped waiting for the sign-in as ${login}. The Riot Client was left on its login page; signing in there with “Stay signed in” ticked finishes the switch, and the sign-in is saved at the next one.`
          : `Stopped while the Riot Client was starting as ${login}. Nothing was rolled back: the client carries on signing in on its own.`,
      });
    const needsSignInResult = (): SwitchResult =>
      result(false, {
        backupId,
        restored: null,
        cancelled: false,
        needsSignIn: true,
        error: `One Launch waited ${this.timing.manualSignInMs / 60_000} min for the sign-in as ${login} and gave up. The Riot Client is still on its login page: sign in there with “Stay signed in” ticked, and the sign-in is saved at the next switch.`,
      });

    this.log.info('riot switch started', {
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
        mark(STEP.close, 'done', 'Client closed.');
      }
      stopIfAborted();
      // A running client rewrites the file at exit and at every token change, so nothing is read or written against one.
      if (!ctx.alreadyActive && (await this.isRunning())) throw startedMeanwhile(STEP.close);

      saveOutgoing();
      if (!ctx.alreadyActive && !ctx.inPlace) {
        takeSnapshot();
        writeSession();
      }

      if (await this.isRunning()) {
        if (!ctx.alreadyActive) throw startedMeanwhile(STEP.start);
        mark(STEP.start, 'skipped', 'The client is already running.');
        mark(STEP.wait, 'skipped', 'The client is already running.');
      } else {
        await startLauncher();
      }

      if (ctx.alreadyActive) {
        mark(STEP.verify, 'skipped', 'The client is already signed in as this account.');
      } else {
        let r = await confirmSignIn();
        if (r.kind === 'cancelled') return cancelledResult();
        if (r.kind === 'wrong-account') throw wrongAccount(r);
        if (r.kind === 'signed-in' && account.id && plan.strategy === 'remembered' && this.deps.sessions.get(account.id)) {
          this.deps.sessions.markVerified(account.id);
        }
        if (r.kind !== 'signed-in') {
          // Only a refused sign-in (invalid_grant) is stale. A service or network failure says nothing about the saved copy, and marking it would cost a manual sign-in.
          if (r.kind === 'failed' && r.outcome.reason === 'rejected' && account.id && plan.strategy === 'remembered') {
            this.deps.sessions.markStale(account.id, r.outcome.detail);
          }
          r = await waitForManualSignIn(r);
          if (r.kind === 'cancelled') return cancelledResult();
          if (r.kind === 'wrong-account') throw wrongAccount(r);
          if (r.kind !== 'signed-in') return needsSignInResult();
          await captureFresh(this.timing.captureMs);
        }
        if (!startedWithGame) readyAt = new Date(Date.now() + this.timing.readyGraceMs).toISOString();
      }

      this.log.info('riot switch finished', { accountId: account.id, backupId, modified, startedWithGame });
      return result(true, { backupId, restored: null, error: null, needsSignIn: false, cancelled: false, readyAt, startedWithGame });
    } catch (err) {
      const cancelled = err instanceof SwitchAbortedError;
      const message = cancelled ? `Stopped before the Riot Client was started as ${login}.` : errorText(err);
      if (current) mark(current, 'failed', cancelled ? 'Stopped.' : message);
      if (cancelled) this.log.info('riot switch stopped', { accountId: account.id, backupId, modified, launcherStarted });
      else if (!modified && isRefusal(err)) this.log.warn('riot switch refused', { accountId: account.id, code: refusalCode(err), error: err });
      else this.log.error('riot switch failed', { accountId: account.id, backupId, modified, error: err });
      if (cancelled && launcherStarted) return cancelledResult();
      if (!modified) {
        return result(false, { backupId, restored: null, error: cancelled ? `${message} Nothing had been changed.` : message, needsSignIn: false, cancelled });
      }
      if (!backupId)
        return result(false, { backupId, restored: false, error: `${message} (no backup was available to restore)`, needsSignIn: false, cancelled });
      try {
        // The client rewrites the file at exit, so make sure it is down first. Never interrupted: no signal.
        if (await this.isRunning()) await this.shutdown().catch((e: unknown) => this.log.warn('could not close the client before rollback', { error: e }));
        // Hard rule 8: what the file holds now (a sign-in the client rotated, or one made by hand) goes to its owner before the file is overwritten.
        this.log.info('riot sign-in before rollback', { detail: this.storeOnDiskSession() });
        const restored = await this.applyRestore(backupId);
        this.log.warn('riot switch rolled back from backup', { backupId, files: restored.files.length });
        return result(false, { backupId, restored: true, error: message, needsSignIn: false, cancelled });
      } catch (restoreErr) {
        this.log.error('riot rollback failed', { backupId, error: restoreErr });
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
        `Exit ${CLIENT_NAME} from its tray icon before restoring: it rewrites ${SESSION_FILE} while it runs, which would undo the restore.`,
      );
    }
    const game = await this.findRunningGame();
    if (game) throw this.gameRunningError(game, 'restore');
    // The state being replaced is itself worth keeping: a restore of the wrong snapshot can then be undone.
    this.deps.backups.snapshot({
      launcher: 'riot',
      reason: `Before restoring ${id}`,
      files: [{ source: this.sessionFilePath(), relative: SESSION_FILE_RELATIVE, sensitive: true }],
      protect: id,
      ...(this.holdsUnownedSession() ? { pinned: UNOWNED_SESSION_PIN } : {}),
    });
    this.log.info('riot sign-in before restore', { detail: this.storeOnDiskSession() });
    return this.applyRestore(id);
  }

  private async applyRestore(id: string): Promise<RestoreResult> {
    const { restored } = this.deps.backups.restore('riot', id, [this.sessionFilePath()]);
    this.log.warn('riot backup restored', { id, files: restored.length });
    return { launcher: 'riot', id, files: restored, registry: [] };
  }

  // --- health ----------------------------------------------------------------

  async healthCheck(known?: KnownLauncherState): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    const add = (id: string, label: string, status: HealthStatus, detail: string): void => {
      checks.push({ id, label, status, detail });
    };
    const report = (): HealthReport => ({ launcher: 'riot', status: worst(checks), checks, checkedAt: new Date().toISOString() });

    const install = known ? known.install : await this.detectInstall();
    const chosenGone = chosenFolderCheck(this.chosenInstallDir(), install, RIOT_CLIENT_EXE);
    if (!install) {
      add(
        'install',
        'Installation',
        'absent',
        `Riot Games is not installed on this PC. Checked the Uninstall key, ${this.installsPath()}, the riotclient:// URI handler, and ${this.defaultDir}.`,
      );
      if (chosenGone) checks.push(chosenGone);
      return { ...report(), status: 'absent' };
    }
    add('install', 'Installation', 'ok', `${install.installDir} (from ${sourceLabel(install.source)})`);
    if (chosenGone) checks.push(chosenGone);

    try {
      const running = known?.running ?? (await this.isRunning());
      add('process', 'Process', 'ok', running ? `${RIOT_CLIENT_EXE} is running` : `${RIOT_CLIENT_EXE} is not running`);
    } catch (err) {
      add('process', 'Process', 'warn', `Could not query the process list: ${errorText(err)}`);
    }

    const installs = this.installs();
    add(
      'installs',
      RIOT_INSTALLS_FILE,
      installs ? 'ok' : 'warn',
      installs
        ? `rc_default = ${installs.rcDefault ?? '(absent)'}; ${plural(installs.associatedClients.size, 'game folder')} associated with a client`
        : `${this.installsPath()} not found or unreadable; the client has not registered an install on this PC.`,
    );

    const records = this.products();
    const installed = records.filter((r) => this.isInstalled(r));
    if (!existsSync(this.metadataDir())) {
      add('products', 'Installed products', 'warn', `${this.metadataDir()} not found. No Riot game has been installed on this PC.`);
    } else {
      const outOfDate = this.productsOutOfDate();
      const state = (r: ProductRecord): string =>
        this.isInstalled(r) ? (outOfDate.has(r.id.id) ? 'installed, needs an update' : 'installed') : r.ok ? 'install folder missing' : 'not installed';
      add(
        'products',
        'Installed products',
        installed.length === 0 ? 'warn' : 'ok',
        `${plural(records.length, 'product folder')} in Metadata${records.length > 0 ? `: ${records.map((r) => `${r.id.id} (${state(r)})`).join(', ')}` : ''}`,
      );
    }

    const dataDir = this.dataDir();
    if (!existsSync(dataDir)) {
      add('data', 'Client data', 'warn', `${dataDir} not found. The client has not run for this Windows user yet.`);
    } else {
      const session = this.sessionFileCheck();
      add('data', 'Client data', session.status, `${dataDir}; ${session.detail}`);
    }

    const logDir = this.logDir();
    if (!existsSync(logDir)) {
      add('log', 'Client log', 'warn', `${logDir} not found. Sign-ins cannot be confirmed until the client has run once.`);
    } else {
      let runs = 0;
      try {
        runs = readdirSync(logDir).filter((n) => CLIENT_LOG_FILE.test(n)).length;
      } catch (err) {
        this.log.debug('could not list the Riot client log folder', { error: errorText(err) });
      }
      const last = lastSignIn(currentRunEvents(logDir));
      const build = currentRunBuild(logDir);
      add(
        'log',
        'Client log',
        last && !last.ok && last.reason === 'rejected' ? 'warn' : 'ok',
        `${plural(runs, 'run log')} in ${logDir}; the newest run${build ? ` (build ${build})` : ''} ${describeSignIn(last)}`,
      );
    }

    const sessions = this.deps.sessions.list('riot');
    const stale = sessions.filter((s) => s.staleReason !== null).length;
    add(
      'sessions',
      'Session snapshots',
      stale > 0 ? 'warn' : 'ok',
      `${plural(sessions.length, 'snapshot')} stored${stale > 0 ? `, ${stale} marked stale` : ''}`,
    );

    const snapshots = this.deps.backups.list('riot').length;
    add('backups', 'Backups', 'ok', snapshots === 0 ? 'No snapshots yet' : `${plural(snapshots, 'snapshot')} available for restore`);

    return report();
  }

  /** One line on the session file for the health report: never a value, only whose sign-in it holds. */
  private sessionFileCheck(): { status: HealthStatus; detail: string } {
    let file: { text: string; read: RiotSessionRead } | null;
    try {
      file = this.readSessionFile();
    } catch (err) {
      return { status: 'warn', detail: `${SESSION_FILE} could not be read: ${errorText(err)}` };
    }
    if (!file) return { status: 'ok', detail: `${SESSION_FILE} absent (the client has not saved a sign-in yet)` };
    const { read } = file;
    switch (read.kind) {
      case 'signed-out':
        return { status: 'ok', detail: `${SESSION_FILE} present, signed out (no saved sign-in)` };
      case 'unexpected':
        return { status: 'warn', detail: `${SESSION_FILE} is not in the shape One Launch knows (${read.reason})` };
      case 'session': {
        const detail = `${SESSION_FILE} holds a saved sign-in for Riot account ${idTail(read.session.accountId)}`;
        return read.session.dpopBound
          ? { status: 'warn', detail: `${detail}, bound to a device key (is_dpop_bound), which a saved copy may not carry` }
          : { status: 'ok', detail };
      }
    }
  }
}

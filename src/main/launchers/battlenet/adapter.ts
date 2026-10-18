/**
 * Battle.net adapter (findings in docs/adapters/battlenet.md).
 *
 * The client signs in from one cached token, a DPAPI blob under
 * HKCU\Software\Blizzard Entertainment\Battle.net\UnifiedAuth that it rewrites at every sign-in and
 * deletes on logout. A switch swaps that value for the target account's stored snapshot (or removes
 * it, so the client opens its login page), puts the target login first in Battle.net.config's
 * SavedAccountNames, restarts the client, and confirms the sign-in from the client's own log. The
 * only launcher-owned things ever written are that registry value and Battle.net.config; both are
 * snapshotted first and put back on failure. AutoLogin ("Keep me logged in") is never written.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  BattlenetLaunchForm,
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
import type { Registry } from '../../platform/registry';
import { writeFileAtomic, type BackupService } from '../../services/backup';
import type { Logger } from '../../services/logger';
import { isRefusal, refusalCode } from '../../services/refusals';
import type { LauncherSessionStore } from '../../services/sessions';
import type { Vault } from '../../services/vault';
import {
  ConfirmationRequiredError,
  GameNotPlayableError,
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
import {
  clientLogDir,
  currentRunEvents,
  endedSignedOut,
  eventsSince,
  lastSignIn,
  logMark,
  type LogEvent,
  type LogMark,
  type SignInOutcome,
} from './client-log';
import { gameRunning, gameStarted, productNeedsUpdate, productStates } from './product-state';
import {
  BattlenetConfigError,
  parseConfig,
  planSavedAccountNames,
  readClientSettings,
  readGames,
  readUserPrefs,
  roundTrips,
  type ClientSettings,
  type ConfigDoc,
  type GameEntry,
  type UserPrefs,
} from './config';
import {
  BLIZZARD_UNINSTALLER_TEXT,
  launchCommand,
  parseAggregate,
  parseProductDb,
  parseUninstallEntries,
  productCodes,
  UNINSTALL_KEY,
  type ProductCodes,
  type ProductDbEntry,
  type UninstallEntry,
} from './products';
import {
  describeToken,
  fingerprintOf,
  parseBlob,
  serializeBlob,
  shortFingerprint,
  tokenValues,
  UNIFIED_AUTH_KEY,
  type BattlenetSessionBlob,
  type TokenValue,
} from './session';

export const BATTLENET_EXE = 'Battle.net.exe';
export const BATTLENET_LAUNCHER_EXE = 'Battle.net Launcher.exe';
export const BATTLENET_UNINSTALL_KEY = `${UNINSTALL_KEY}\\Battle.net`;
export const BATTLENET_URI_COMMAND_KEY = 'SOFTWARE\\Classes\\battlenet\\shell\\open\\command';
export const DEFAULT_BATTLENET_DIR = 'C:\\Program Files (x86)\\Battle.net';
export const DISPLAY_NAME = 'Battle.net';
/** Why a snapshot is pinned (see BackupService). Shown in Settings › Backups. */
export const UNOWNED_SESSION_PIN = 'Holds a sign-in that no One Launch account owns';
export const UNIFIED_AUTH_PATH = `HKCU\\${UNIFIED_AUTH_KEY}`;

/** Plan step ids. The real switch reports progress against these. */
export const STEP = {
  close: 'close',
  capture: 'capture',
  backup: 'backup',
  registry: 'registry',
  file: 'file',
  start: 'start',
  wait: 'wait',
  verify: 'verify',
  manual: 'manual',
  recapture: 'recapture',
} as const;

const DEFAULT_TIMING = {
  pollMs: 500,
  /** The waits that read the log or a registry value, not the process list: each poll is cheap, so they look more often. */
  logPollMs: 250,
  /** The client's own shutdown took under 2 s on the survey machine; HideOnClose makes it never exit. */
  shutdownMs: 30_000,
  killGraceMs: 10_000,
  /** How long to watch for the client coming back after it exits (an update restart). */
  restartWatchMs: 5_000,
  /** The same watch when the log shows the client shutting itself down after the window close. */
  cleanExitWatchMs: 1_500,
  restartSettleMs: 45_000,
  startupMs: 90_000,
  /** A cached-token sign-in completes about 2.5 s after the log opens; an update can come first. */
  signInMs: 60_000,
  /** How long the user gets to sign in by hand on the client's login page. */
  manualSignInMs: 600_000,
  /** The token is written at the sign-in itself; this is only slack for the registry to settle. */
  captureMs: 10_000,
  /** The client binds the game families about a second after the sign-in; launching before that is dropped. */
  readyGraceMs: 5_000,
  /** How long launchGame watches the client log for "Launch request <code>" after sending the command. */
  launchConfirmMs: 15_000,
};

const ACCOUNT_ID = /^[0-9a-f]{1,16}$/i;
/** Named by the account id in hex without padding (1 to 8 digits). */
const USER_CONFIG_FILE = /^([0-9a-f]{1,8})\.config$/i;

export interface BattlenetAdapterDeps {
  registry: Registry;
  processes: ProcessController;
  backups: BackupService;
  sessions: LauncherSessionStore;
  accounts: AccountDirectory;
  /** Encrypts the outgoing token inside backup snapshots, so no bearer material sits in plaintext under backups/. */
  vault: Pick<Vault, 'encrypt' | 'decrypt'>;
  log: Logger;
  backupsToKeep: () => number;
  /** shell.openExternal in the app; a recorder in tests. */
  openExternal: (url: string) => Promise<void>;
  launchForm: () => BattlenetLaunchForm;
  /** %APPDATA% by default. Overridable for tests. */
  appData?: string;
  /** %LOCALAPPDATA% by default. Overridable for tests. */
  localAppData?: string;
  /** %ProgramData% by default. Overridable for tests. */
  programData?: string;
  /** The battlenet.path setting: the folder the user chose with Locate, tried before the registry. */
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
function idTail(uid: string | null): string {
  return uid ? `…${uid.slice(-4)}` : '(unknown id)';
}

const sameLogin = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

interface ConfigState {
  path: string;
  /** Null when the file does not exist. */
  text: string | null;
  doc: ConfigDoc | null;
  client: ClientSettings | null;
  games: Map<string, GameEntry>;
  /** Null when the file is missing or unreadable; false when it parses but cannot be reproduced byte for byte. */
  roundTrips: boolean | null;
  error: string | null;
}

/** Who the current session belongs to, and how we know. */
interface CurrentSession {
  /** Every REG_BINARY value under UnifiedAuth. The client keeps one. */
  tokens: TokenValue[];
  /** The value that counts: the one matching a stored snapshot, else the only one, else the first. */
  token: TokenValue | null;
  fingerprint: string | null;
  remembered: boolean;
  /**
   * The One Launch account that owns the token. While the client runs, its own log decides; when it
   * is closed, a stored snapshot's fingerprint decides, then the last run's log (the client writes
   * the token at the sign-in itself, so after a run it belongs to the run's last sign-in).
   */
  owner: AccountRef | null;
  /** The account id of the client's last successful sign-in in its current log. */
  loggedUid: string | null;
  lastSignIn: SignInOutcome | null;
  /** The last run ended with a logout, so the token (if any) is not that run's. */
  signedOut: boolean;
  running: boolean;
  events: LogEvent[];
}

interface PlanContext {
  install: LauncherInstall;
  startExe: string;
  config: ConfigState;
  current: CurrentSession;
  stored: LauncherSession | null;
  strategy: SwitchStrategy;
  /** The token on disk already belongs to the target account. */
  inPlace: boolean;
  alreadyActive: boolean;
  running: boolean;
  prefs: UserPrefs | null;
  /** The plan found the target login already first in SavedAccountNames, which is why its file step is skipped. */
  loginFirst: boolean;
}

type SignInWait =
  | { kind: 'signed-in'; accountId: string }
  | { kind: 'wrong-account'; accountId: string; owner: AccountRef | null }
  | { kind: 'failed'; reason: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

function attentionFor(login: string, cause: 'expired' | 'new' | 'other', reason: string | null, canCopyPassword: boolean, until: string): LaunchAttention {
  const why =
    cause === 'expired'
      ? 'The client rejected its stored session.'
      : cause === 'new'
        ? 'No session is stored for this account yet.'
        : `The client did not sign in on its own${reason ? ` (${reason})` : ''}.`;
  return {
    kind: 'sign-in',
    title: cause === 'new' ? `Sign in to Battle.net as ${login}` : `Battle.net is asking you to sign in as ${login}`,
    message: `${why} Its login page opens on the account it last signed in as.`,
    steps: [
      'In the Battle.net window, click “Switch account”.',
      `Pick or type ${login} and enter the password.`,
      'Leave “Keep me logged in” on and sign in. One Launch continues on its own, and later switches are automatic.',
    ],
    reason,
    canCopyPassword,
    until,
  };
}

export class BattlenetAdapter implements LauncherAdapter {
  readonly id = 'battlenet' as const;
  readonly displayName = DISPLAY_NAME;

  private readonly log: Logger;
  private readonly appData: string;
  private readonly localAppData: string;
  private readonly programData: string;
  private readonly defaultDir: string;
  private readonly timing: typeof DEFAULT_TIMING;

  constructor(private readonly deps: BattlenetAdapterDeps) {
    this.log = deps.log;
    const profile = process.env['USERPROFILE'] ?? 'C:\\';
    this.appData = deps.appData ?? process.env['APPDATA'] ?? join(profile, 'AppData', 'Roaming');
    this.localAppData = deps.localAppData ?? process.env['LOCALAPPDATA'] ?? join(profile, 'AppData', 'Local');
    this.programData = deps.programData ?? process.env['ProgramData'] ?? 'C:\\ProgramData';
    this.defaultDir = deps.defaultInstallDir ?? DEFAULT_BATTLENET_DIR;
    this.timing = mergeTiming(DEFAULT_TIMING, deps.timing);
  }

  // --- paths -----------------------------------------------------------------

  configDir(): string {
    return join(this.appData, 'Battle.net');
  }

  configPath(): string {
    return join(this.configDir(), 'Battle.net.config');
  }

  logDir(): string {
    return clientLogDir(this.localAppData);
  }

  productDbPath(): string {
    return join(this.programData, 'Battle.net', 'Agent', 'product.db');
  }

  aggregatePath(): string {
    return join(this.programData, 'Battle.net', 'Agent', 'aggregate.json');
  }

  /** The stored blob for an account, or null. Decrypts; callers use it at once and drop it. */
  private storedBlob(accountId: string | null): BattlenetSessionBlob | null {
    if (!accountId) return null;
    try {
      const json = this.deps.sessions.decrypt(accountId);
      return json ? parseBlob(json) : null;
    } catch {
      return null;
    }
  }

  // --- detection -------------------------------------------------------------

  async detectInstall(): Promise<LauncherInstall | null> {
    const { registry } = this.deps;
    const chosen = this.chosenInstallDir();
    const fromChosen = chosen ? this.installAt(chosen, 'user') : null;
    if (fromChosen) return fromChosen;
    const uninstall = await registry.getString('HKLM', BATTLENET_UNINSTALL_KEY, 'InstallLocation');
    if (uninstall && uninstall.trim()) {
      const found = this.installAt(normalizeLauncherPath(uninstall), 'registry-hklm');
      if (found) return found;
    }
    const command = await registry.getString('HKLM', BATTLENET_URI_COMMAND_KEY, '');
    const exe = command ? /^"([^"]+)"/.exec(command)?.[1] : undefined;
    if (exe) {
      const found = this.installAt(dirname(normalizeLauncherPath(exe)), 'registry-hklm');
      if (found) return found;
    }
    return this.installAt(this.defaultDir, 'default-path');
  }

  chosenInstallDir(): string | null {
    return chosenFolder(this.deps.installDir);
  }

  /** Either executable will do: the shortcuts point at Battle.net Launcher.exe, which sits next to the client. */
  installFromExe(exePath: string): LauncherInstall | null {
    const exe = normalizeLauncherPath(exePath);
    return isNamed(exe, [BATTLENET_EXE, BATTLENET_LAUNCHER_EXE]) ? this.installAt(dirname(exe), 'user') : null;
  }

  private installAt(installDir: string, source: LauncherInstall['source']): LauncherInstall | null {
    const exePath = join(installDir, BATTLENET_EXE);
    if (!existsSync(exePath)) {
      this.log.debug('no Battle.net.exe at candidate location', { source, installDir });
      return null;
    }
    return { launcher: 'battlenet', installDir, exePath, source };
  }

  private async requireInstall(): Promise<LauncherInstall> {
    const install = await this.detectInstall();
    if (!install) throw new LauncherNotInstalledError('battlenet');
    return install;
  }

  /** What the shortcuts run: Battle.net Launcher.exe (updates, then starts the client) when present. */
  startExe(install: LauncherInstall): string {
    const launcher = join(install.installDir, BATTLENET_LAUNCHER_EXE);
    return existsSync(launcher) ? launcher : install.exePath;
  }

  // --- config ------------------------------------------------------------------

  private readConfig(): ConfigState {
    const path = this.configPath();
    const empty: ConfigState = { path, text: null, doc: null, client: null, games: new Map(), roundTrips: null, error: null };
    if (!existsSync(path)) return empty;
    let text: string;
    try {
      text = readLauncherText(path);
    } catch (err) {
      if (err instanceof LauncherFileError) throw err;
      throw new LauncherFileError(path, `Could not read Battle.net.config (${errorText(err)})`);
    }
    try {
      const { doc } = parseConfig(text);
      return { path, text, doc, client: readClientSettings(doc), games: readGames(doc), roundTrips: roundTrips(text), error: null };
    } catch (err) {
      return { ...empty, text, error: errorText(err) };
    }
  }

  /** The per-account preferences file that predicts what a window close does: the current account's, else the newest. */
  private readUserPrefs(uid: string | null): { path: string; prefs: UserPrefs } | null {
    const dir = this.configDir();
    if (!existsSync(dir)) return null;
    const candidates: { path: string; mtime: number; own: boolean }[] = [];
    for (const name of readdirSync(dir)) {
      const m = USER_CONFIG_FILE.exec(name);
      if (!m) continue;
      const path = join(dir, name);
      try {
        candidates.push({ path, mtime: statSync(path).mtimeMs, own: uid !== null && m[1]!.toLowerCase() === uid.toLowerCase() });
      } catch {
        // vanished
      }
    }
    const pick = candidates.find((c) => c.own) ?? candidates.sort((a, b) => b.mtime - a.mtime)[0];
    if (!pick) return null;
    try {
      return { path: pick.path, prefs: readUserPrefs(readLauncherText(pick.path)) };
    } catch (err) {
      this.log.warn('could not read the per-account Battle.net config', { error: errorText(err) });
      return null;
    }
  }

  // --- library ---------------------------------------------------------------

  /** Two steps, both small: reg.exe finds the keys whose uninstaller is Blizzard's, then each product's key is read for its name and folder. */
  private async uninstallEntries(): Promise<UninstallEntry[]> {
    const { registry } = this.deps;
    const products = parseUninstallEntries(await registry.searchTree('HKLM', UNINSTALL_KEY, BLIZZARD_UNINSTALLER_TEXT));
    const full = await Promise.all(
      products.map(async (p) => {
        try {
          return { relative: p.key, values: await registry.listSubkeyValues('HKLM', UNINSTALL_KEY, p.key) };
        } catch (err) {
          this.log.debug('skipping a Battle.net product whose Uninstall key could not be read', { codename: p.codename, error: errorText(err) });
          return null;
        }
      }),
    );
    return parseUninstallEntries(full.filter((d) => d !== null));
  }

  private productDb(): ProductDbEntry[] {
    const path = this.productDbPath();
    if (!existsSync(path)) return [];
    try {
      return parseProductDb(readLauncherBytes(path));
    } catch (err) {
      this.log.warn('could not read product.db', { error: errorText(err) });
      return [];
    }
  }

  private codesFor(codename: string, db: readonly ProductDbEntry[]): ProductCodes | null {
    return productCodes(codename, db.find((e) => e.codename === codename)?.tactCode ?? null);
  }

  async listInstalledGames(): Promise<InstalledGame[]> {
    await this.requireInstall();
    return this.gamesFrom(await this.uninstallEntries());
  }

  private gamesFrom(entries: readonly UninstallEntry[]): InstalledGame[] {
    const config = this.readConfig();
    // The client's own verdict, from the newest run's log; with no log every product reads up to date.
    const states = productStates(currentRunEvents(this.logDir()));
    const games: InstalledGame[] = [];
    for (const e of entries) {
      if (!e.installPath || !existsSync(e.installPath)) {
        this.log.debug('skipping Battle.net product without an install folder', { codename: e.codename });
        continue;
      }
      games.push({
        launcher: 'battlenet',
        launcherGameId: e.codename,
        name: e.name,
        installPath: e.installPath,
        libraryPath: dirname(e.installPath),
        sizeOnDiskBytes: null,
        lastPlayedAt: config.games.get(e.codename)?.lastPlayedAt ?? null,
        needsUpdate: productNeedsUpdate(states.get(e.codename)),
      });
    }
    return games.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  // --- session state ---------------------------------------------------------

  private async readTokens(): Promise<TokenValue[]> {
    return tokenValues(await this.deps.registry.listValues('HKCU', UNIFIED_AUTH_KEY));
  }

  /** What the registry and the client log say now and whose session it is. Writes nothing. */
  private async currentSession(running: boolean): Promise<CurrentSession> {
    const tokens = await this.readTokens();
    const events = currentRunEvents(this.logDir());
    const last = lastSignIn(events);
    const signedOut = endedSignedOut(events);
    const loggedUid = last?.ok && last.accountId ? last.accountId : null;
    const byLog = loggedUid ? this.deps.accounts.byLauncherUid(loggedUid) : null;

    let token: TokenValue | null = null;
    let storedOwner: AccountRef | null = null;
    for (const t of tokens) {
      const stored = this.deps.sessions.findByFingerprint('battlenet', fingerprintOf(t.hex));
      if (stored) {
        token = t;
        storedOwner = this.deps.accounts.byId(stored.accountId);
        break;
      }
    }
    if (!token) token = tokens[0] ?? null;

    let owner: AccountRef | null = null;
    if (running) {
      owner = last?.ok ? byLog : null;
    } else if (token) {
      owner = storedOwner ?? (last?.ok && !signedOut ? byLog : null);
    }
    return {
      tokens,
      token,
      fingerprint: token ? fingerprintOf(token.hex) : null,
      remembered: token !== null,
      owner,
      loggedUid,
      lastSignIn: last,
      signedOut,
      running,
      events,
    };
  }

  async sessionState(): Promise<LauncherSessionState> {
    await this.requireInstall();
    const running = await this.isRunning();
    const current = await this.currentSession(running);
    return {
      launcher: 'battlenet',
      remembered: current.remembered,
      fingerprint: current.fingerprint,
      launcherUid: running ? current.loggedUid : current.remembered ? (current.owner?.launcherUid ?? (current.signedOut ? null : current.loggedUid)) : null,
      linkedAccountId: current.owner?.id ?? null,
      launcherRunning: running,
      lastSignIn: current.lastSignIn ? { ok: current.lastSignIn.ok, reason: current.lastSignIn.ok ? null : current.lastSignIn.reason } : null,
    };
  }

  async captureSession(account: AccountRef): Promise<{ session: LauncherSession; launcherUid: string | null }> {
    if (!account.id) throw new SwitchBlockedError('Save the account first, then capture its session.');
    await this.requireInstall();
    const running = await this.isRunning();
    const current = await this.currentSession(running);
    if (!current.token) {
      throw new SwitchBlockedError(
        `Battle.net has no remembered session right now (nothing under ${UNIFIED_AUTH_PATH}). Sign in to the client as ${account.login} with "Keep me logged in" on, then save again.`,
      );
    }
    if (running && (!current.lastSignIn?.ok || !current.loggedUid)) {
      throw new SwitchBlockedError(
        `Battle.net is running but has not signed in during this run${current.lastSignIn && !current.lastSignIn.ok ? ` (${current.lastSignIn.reason})` : ''}. Sign in to it as ${account.login}, then save again.`,
      );
    }
    if (!running && current.signedOut) {
      throw new SwitchBlockedError(
        'The last Battle.net run ended with a logout, so the remembered session cannot be attributed to an account. Sign in to the client, exit it, then save again.',
      );
    }
    if (current.owner && current.owner.id !== account.id) {
      throw new SwitchBlockedError(
        `The session Battle.net currently remembers belongs to ${current.owner.displayName}. Sign in to the client as ${account.login} first.`,
      );
    }
    const uid = running ? current.loggedUid : (current.owner?.launcherUid ?? current.loggedUid);
    if (uid && account.launcherUid && uid.toLowerCase() !== account.launcherUid.toLowerCase()) {
      throw new SwitchBlockedError(
        `The client's last sign-in was Battle.net account ${idTail(uid)}, but ${account.displayName} is linked to ${idTail(account.launcherUid)}. Check the account ID on the account page.`,
      );
    }
    return this.storeSession({ ...account, id: account.id }, { v: 1, unifiedAuth: current.token }, uid ?? account.launcherUid);
  }

  /**
   * Records the account id on the account, then encrypts and stores the token for it. The link comes
   * first and throws when another account holds the id, so no session is ever stored under an id
   * the link was refused for. Never logs the token.
   */
  private storeSession(
    account: AccountRef & { id: string },
    blob: BattlenetSessionBlob,
    uid: string | null,
  ): { session: LauncherSession; launcherUid: string | null } {
    const normalizedUid = uid && ACCOUNT_ID.test(uid) ? uid.toLowerCase() : null;
    if (normalizedUid && (!account.launcherUid || account.launcherUid.toLowerCase() !== normalizedUid)) {
      this.deps.accounts.setLauncherUid(account.id, normalizedUid);
    }
    const session = this.deps.sessions.save({
      accountId: account.id,
      launcher: 'battlenet',
      launcherUid: normalizedUid,
      fingerprint: fingerprintOf(blob.unifiedAuth.hex),
      blob: serializeBlob(blob),
    });
    this.log.info('battlenet session stored', { accountId: account.id, fingerprint: shortFingerprint(session.fingerprint) });
    return { session, launcherUid: normalizedUid };
  }

  // --- accounts --------------------------------------------------------------

  /** The logins in SavedAccountNames. The client records no ids there, so launcherUid is empty. */
  async listRememberedAccounts(): Promise<RememberedAccountEntry[]> {
    await this.requireInstall();
    const config = this.readConfig();
    const names = config.client?.savedAccountNames ?? [];
    if (names.length === 0) return [];
    const current = await this.currentSession(await this.isRunning());
    const ownerLogin = current.owner?.login ?? null;
    return names.map((login): RememberedAccountEntry => {
      const active = ownerLogin !== null && sameLogin(ownerLogin, login);
      // The client keeps one token and records no per-login flag, so "remembered" cannot be told from the list.
      return {
        launcher: 'battlenet',
        launcherUid: '',
        login,
        personaName: '',
        rememberPassword: true,
        mostRecent: active,
        lastLoginAt: null,
        sessionMayBeExpired: false,
      };
    });
  }

  // --- process ---------------------------------------------------------------

  async isRunning(): Promise<boolean> {
    return this.deps.processes.isRunning(BATTLENET_EXE);
  }

  /** A process running out of a game's install folder counts. */
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
    return game ? { launcher: 'battlenet', launcherGameId: game.launcherGameId, name: game.name, source: 'process' } : null;
  }

  private waitUntil(cond: () => Promise<boolean>, timeoutMs: number, signal?: AbortSignal, pollMs = this.timing.pollMs): Promise<boolean> {
    return waitUntil(cond, { timeoutMs, pollMs, signal });
  }

  /**
   * Window close, wait for every Battle.net.exe to be gone (the client writes
   * its config files at the very end of its shutdown), then a forced kill. If the client comes back
   * on its own (an update restart), it is given time to finish starting and is closed again.
   * Throws SwitchAbortedError when the signal aborts a wait.
   */
  async shutdown(opts: { timeoutMs?: number; signal?: AbortSignal | undefined } = {}): Promise<void> {
    await this.requireInstall();
    if (!(await this.isRunning())) return;
    const timeoutMs = opts.timeoutMs ?? this.timing.shutdownMs;
    const { signal } = opts;
    const dir = this.logDir();
    for (let attempt = 1; ; attempt++) {
      const mark = logMark(dir);
      this.log.info('asking Battle.net to close', { timeoutMs, attempt });
      await this.deps.processes.close(BATTLENET_EXE);
      if (!(await this.waitUntil(async () => !(await this.isRunning()), timeoutMs, signal))) {
        this.log.warn('Battle.net did not exit in time; killing it');
        // Not the tree: a game the client started is its child, and the plan promises the game keeps running.
        await this.deps.processes.kill(BATTLENET_EXE, { tree: false });
        if (!(await this.waitUntil(async () => !(await this.isRunning()), this.timing.killGraceMs, signal))) {
          throw new Error(`${BATTLENET_EXE} is still running after a window close and a forced close`);
        }
      }
      const watchMs = eventsSince(dir, mark).some((e) => e.kind === 'exit') ? this.timing.cleanExitWatchMs : this.timing.restartWatchMs;
      if (!(await this.waitUntil(() => this.isRunning(), watchMs, signal))) return;
      if (attempt >= 3) throw new Error(`${BATTLENET_EXE} keeps restarting itself after being closed`);
      this.log.info('Battle.net restarted itself after closing; letting it finish starting before closing it again');
      await this.waitUntil(
        async () => {
          const now = logMark(dir);
          return now.file !== mark.file && eventsSince(dir, { file: null, size: 0 }).some((e) => e.kind === 'main-window');
        },
        this.timing.restartSettleMs,
        signal,
      );
    }
  }

  /**
   * Refuses when the client's own state says the product cannot start (its Play button reads Update),
   * sends the launch command, then watches the client's log for the game start it logs for --exec
   * ("LaunchBinary: uid=<codename>", "InstallState (<codename>): GameLaunching=1", "gameRunning=1";
   * builds before 2.52.12 logged "Launch request <code>"). An --exec the client did not act on fails
   * the launch: for a product that needs an update or a repair the client only selects the game page
   * and logs nothing else (seen 2026-09-24), and it drops the command for a game it sees running, one
   * started from its window or found running when it started (seen 2026-10-10), so a game the log shows
   * running is refused up front. battlenet://game/<code> only selects the game's page in a running
   * client (seen 2026-09-13); --exec="launch <code>" is the default.
   */
  async launchGame(game: { launcherGameId: string; name: string }, opts: { signal?: AbortSignal | undefined } = {}): Promise<{ command: string }> {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(game.launcherGameId)) throw new Error(`Not a Battle.net product codename: ${game.launcherGameId}`);
    const install = await this.requireInstall();
    const codes = this.codesFor(game.launcherGameId, this.productDb());
    if (!codes) throw new Error(`No launch code is known for ${game.name} (${game.launcherGameId}); it is not in One Launch's product table or in product.db.`);
    const logDir = this.logDir();
    const events = currentRunEvents(logDir);
    const state = productStates(events).get(game.launcherGameId);
    if (productNeedsUpdate(state)) {
      // Thrown messages reach the dialog as "Battle.net: <message>", so they start with the game.
      throw new GameNotPlayableError(`${game.name} needs an update before it can start. Update it in the Battle.net window, then press Play again.`);
    }
    if (state?.playable === false) {
      const what = `${state.operation ?? 'unknown state'}${state.status ? `, ${state.status.toLowerCase()}` : ''}`;
      throw new GameNotPlayableError(`${game.name} is not playable right now (${what}). Finish that in the Battle.net window, then press Play again.`);
    }
    if (gameRunning(events, game.launcherGameId)) {
      throw new GameNotPlayableError(`${game.name} is already running. Close it, then press Play again.`);
    }
    const form = this.deps.launchForm();
    const cmd = launchCommand(codes, form);
    const mark = logMark(logDir);
    this.log.info('launching game', { codename: game.launcherGameId, name: game.name, form, verifiedCodes: codes.verified });
    let command: string;
    if (cmd.kind === 'uri') {
      await this.deps.openExternal(cmd.url);
      command = cmd.url;
    } else {
      await this.deps.processes.start(install.exePath, [cmd.arg], { cwd: install.installDir });
      command = `"${install.exePath}" ${cmd.arg}`;
    }
    let started = false;
    let stopped = false;
    try {
      started = await this.waitUntil(
        async () => gameStarted(eventsSince(logDir, mark), game.launcherGameId, codes.programCode),
        this.timing.launchConfirmMs,
        opts.signal,
        this.timing.logPollMs,
      );
    } catch (err) {
      if (!(err instanceof SwitchAbortedError)) throw err;
      stopped = true;
    }
    this.log.info('launch command sent', { codename: game.launcherGameId, form, started, stopped });
    if (stopped) return { command: `${command} (stopped watching for the game start)` };
    if (started) return { command: `${command} (Battle.net started the game)` };
    if (cmd.kind === 'uri') {
      return { command: `${command} (this link only opens the game page: press Play there, or switch the Battle.net launch setting to the launch command)` };
    }
    throw new Error(
      `${game.name} did not start within ${this.timing.launchConfirmMs / 1000} s of the launch command. Look at the Battle.net window: the game may need an update or a repair, or the client may be busy updating itself.`,
    );
  }

  // --- switching -------------------------------------------------------------

  /** What a close does, for the confirmation: a game already running keeps running when the client exits on its own. */
  private closeMessage(game: RunningGame | null): string {
    return game ? `Battle.net is running ${game.name}. Switching closes Battle.net; the game keeps running.` : 'Battle.net is running. Switching closes it.';
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
    const startExe = this.startExe(install);
    const running = await this.isRunning();
    const config = this.readConfig();
    const current = await this.currentSession(running);
    const stored = account.id ? this.deps.sessions.get(account.id) : null;
    const prefsFile = this.readUserPrefs(current.owner?.launcherUid ?? current.loggedUid);
    const prefs = prefsFile?.prefs ?? null;
    const warnings: string[] = [];
    const notes: string[] = [];
    const logDir = this.logDir();

    const inPlace = current.owner !== null && current.owner.id === account.id && (running || current.remembered);
    const strategy: SwitchStrategy = inPlace || (stored !== null && stored.staleReason === null) ? 'remembered' : 'credentials';
    const alreadyActive = inPlace && running;
    const usesStored = strategy === 'remembered' && !inPlace;
    const login = account.login;
    const expectedUid = stored?.launcherUid ?? account.launcherUid ?? null;

    const steps: SwitchPlanStep[] = [];
    const step = (s: Omit<SwitchPlanStep, 'changes' | 'skipped'> & Partial<Pick<SwitchPlanStep, 'changes' | 'skipped'>>): void => {
      steps.push({ changes: [], skipped: false, ...s });
    };

    const hides = prefs?.hideOnClose === true;
    const prompts = prefs?.displayExitPrompt === true;
    step({
      id: STEP.close,
      kind: 'process',
      title: 'Close Battle.net',
      target: BATTLENET_EXE,
      skipped: !running || alreadyActive,
      detail: alreadyActive
        ? 'Skipped: the client is already signed in as this account, so it is left running.'
        : running
          ? `Send ${BATTLENET_EXE} a window close (which exits the client${hides ? ', except that this account has "close to system tray" on' : ''}${prompts ? ' after the exit prompt' : ''}) and wait up to ${this.timing.shutdownMs / 1000} s for every ${BATTLENET_EXE} process to be gone, since the client writes its config files at the end of its shutdown. If it is still running after that, force-close every ${BATTLENET_EXE} process and nothing it started. Agent.exe is left alone. A game already running keeps running.`
          : `Skipped: ${BATTLENET_EXE} is not running.`,
    });

    const outgoing = current.owner;
    const outgoingStored = outgoing?.id ? this.deps.sessions.get(outgoing.id) : null;
    const outgoingChanged = outgoing !== null && outgoingStored?.fingerprint !== current.fingerprint;
    const captureNeeded = outgoing !== null && !alreadyActive && (running || (current.remembered && (!inPlace || outgoingChanged)));
    step({
      id: STEP.capture,
      kind: 'backup',
      title: inPlace ? "Save this account's session" : 'Save the outgoing session',
      target: UNIFIED_AUTH_PATH,
      skipped: !captureNeeded,
      detail: alreadyActive
        ? 'Skipped: the client stays running, so its token is not re-read.'
        : outgoing === null
          ? current.remembered
            ? `Skipped: the client remembers a session (fingerprint ${shortFingerprint(current.fingerprint)}) that no One Launch account owns, so it is left alone and not saved. To keep it, capture it from that account's page before switching.`
            : 'Skipped: the client is not remembering any session.'
          : !captureNeeded
            ? `Skipped: ${outgoing.displayName}'s stored snapshot already matches what the client remembers.`
            : running
              ? `After the client has closed, read the UnifiedAuth value and, if the last run's log names ${outgoing.displayName} and the value changed, store it, encrypted, as the account's snapshot. Nothing of the client's changes.`
              : inPlace
                ? `The UnifiedAuth value holds ${outgoing.displayName}'s session but differs from the stored snapshot (${outgoingStored ? 'the client rotates the token at every sign-in' : 'no snapshot yet'}), so store it, encrypted, as the account's snapshot. Nothing of the client's changes.`
                : `The UnifiedAuth value holds ${outgoing.displayName}'s session${outgoingChanged ? ' and it changed since it was last saved (the client rotates it at every sign-in)' : ''}; store it, encrypted, as the account's snapshot if it changed. Nothing of the client's changes.`,
    });

    step({
      id: STEP.backup,
      kind: 'backup',
      title: 'Back up Battle.net.config and the UnifiedAuth value',
      target: this.deps.backups.previewPath('battlenet'),
      skipped: alreadyActive || inPlace,
      detail:
        alreadyActive || inPlace
          ? 'Skipped: nothing will be modified.'
          : `Copy ${config.text !== null ? config.path : '(no Battle.net.config to copy)'} into a new snapshot folder and record ${plural(current.tokens.length, 'UnifiedAuth value')} in it, vault-encrypted, so a failed switch can be rolled back. The newest ${this.deps.backupsToKeep()} snapshots are kept.`,
    });

    const registryChanges: SwitchChange[] = [];
    if (inPlace) {
      step({
        id: STEP.registry,
        kind: 'registry',
        title: "Put the account's session token in place",
        target: UNIFIED_AUTH_PATH,
        skipped: true,
        detail: `No change: UnifiedAuth already holds ${account.displayName}'s token (fingerprint ${shortFingerprint(current.fingerprint)}).`,
      });
    } else if (usesStored && stored) {
      const storedName = this.storedValueName(account.id);
      const existing = storedName ? (current.tokens.find((t) => t.name.toLowerCase() === storedName.toLowerCase()) ?? null) : null;
      registryChanges.push({
        where: `UnifiedAuth\\${storedName ?? '(name from the snapshot)'}`,
        before: describeToken(existing),
        after: `(stored snapshot, fingerprint ${shortFingerprint(stored.fingerprint)}, captured ${stored.capturedAt})`,
      });
      for (const t of current.tokens) {
        if (storedName && t.name.toLowerCase() === storedName.toLowerCase()) continue;
        registryChanges.push({ where: `UnifiedAuth\\${t.name}`, before: describeToken(t), after: '(removed)' });
      }
      step({
        id: STEP.registry,
        kind: 'registry',
        title: "Put the account's session token in place",
        target: UNIFIED_AUTH_PATH,
        detail: `Decrypt ${account.displayName}'s session snapshot from the vault and write it as the REG_BINARY value under UnifiedAuth (reg add /t REG_BINARY). Any other value there (the outgoing token, saved in the step above when it belongs to a One Launch account) is removed, the way the client's own logout removes it. The bytes are a DPAPI blob bound to this Windows user and are never shown or logged. Identity, EncryptionKey, Launch Options, and every file under the client's folders stay untouched.`,
        changes: registryChanges,
      });
    } else {
      for (const t of current.tokens) registryChanges.push({ where: `UnifiedAuth\\${t.name}`, before: describeToken(t), after: '(removed)' });
      step({
        id: STEP.registry,
        kind: 'registry',
        title: 'Sign the client out',
        target: UNIFIED_AUTH_PATH,
        skipped: current.tokens.length === 0,
        detail:
          current.tokens.length === 0
            ? 'No change: the client has no remembered session, so it will open on its login page.'
            : `Remove the UnifiedAuth value (reg delete), which is what the client's own logout does, so it opens on its login page instead of signing in as ${outgoing ? outgoing.displayName : 'the previous account'}. "Keep me logged in" (Client.AutoLogin) is not touched, so the next sign-in is remembered.`,
        changes: registryChanges,
      });
    }

    let fileWrite: ReturnType<typeof planSavedAccountNames> | null = null;
    let fileSkip: string | null = null;
    if (config.text === null) {
      fileSkip = `Skipped: ${config.path} does not exist. One Launch never creates it; the client writes it at its next exit.`;
    } else if (config.error) {
      fileSkip = `Skipped: ${config.path} could not be parsed (${config.error}), so it is left alone.`;
    } else if (config.roundTrips === false) {
      fileSkip = `Skipped: ${config.path} does not round-trip through One Launch's JSON writer byte for byte, so it is left alone rather than rewritten with a different layout.`;
    } else {
      try {
        fileWrite = planSavedAccountNames(config.text, login);
        if (fileWrite.noop) fileSkip = `No change: ${login} is already first in Client.SavedAccountNames.`;
      } catch (err) {
        fileSkip = `Skipped: ${errorText(err)}`;
      }
    }
    step({
      id: STEP.file,
      kind: 'file',
      title: 'Put the login first in the saved-accounts list',
      target: config.path,
      skipped: alreadyActive || fileSkip !== null,
      detail: alreadyActive
        ? 'Skipped: the client stays running as this account.'
        : (fileSkip ??
          `Move ${login} to the front of Client.SavedAccountNames${fileWrite && !fileWrite.before.some((s) => sameLogin(s, login)) ? ' (it is not in the list yet, so it is added)' : ''}, rewriting the file with the same layout (4-space indent, CRLF, "\\/" escapes) via a temp file and rename; every other key stays byte for byte. The client moves the signed-in login to the front at every sign-in and at start only accepts the UnifiedAuth token of the login that is first (2026-09-13: every switch with another login first was asked for a password; the one with the target first signed in silently).`),
      changes: fileWrite && !fileSkip ? fileWrite.changes : [],
    });

    step({
      id: STEP.start,
      kind: 'launch',
      title: 'Start Battle.net',
      target: `"${startExe}"`,
      skipped: alreadyActive && running,
      detail:
        alreadyActive && running
          ? 'Skipped: the client is already running as this account.'
          : `${startExe.toLowerCase().endsWith(BATTLENET_LAUNCHER_EXE.toLowerCase()) ? `Start ${BATTLENET_LAUNCHER_EXE} with no arguments, as the Start Menu shortcut does (it applies any pending update, then starts the client with --from-launcher).` : `Start ${BATTLENET_EXE} with no arguments.`} ${
              strategy === 'remembered'
                ? `The client signs in as ${login} on its own from the UnifiedAuth token.`
                : `With no token the client opens on its login page. The "Welcome back" email there comes from the login page's own web session (a cookie One Launch does not touch), so it may name the previous account; "Switch account" on that page lists the saved logins.`
            }`,
    });

    step({
      id: STEP.wait,
      kind: 'wait',
      title: 'Wait for the client to come up',
      target: BATTLENET_EXE,
      skipped: alreadyActive && running,
      detail: `Poll the process list until ${BATTLENET_EXE} is running, up to ${this.timing.startupMs / 1000} s.`,
    });

    step({
      id: STEP.verify,
      kind: 'wait',
      title: 'Confirm the client signed in',
      target: logDir,
      skipped: alreadyActive && running,
      detail:
        alreadyActive && running
          ? 'Skipped: the client is already signed in as this account.'
          : strategy === 'remembered'
            ? `Read the new run's log (battle.net-<timestamp>.log; no tokens in it) until "Logged into Battle.net successfully" names ${
                expectedUid ? `the account id ${idTail(expectedUid)}` : 'an account id, which is then recorded on the account'
              }, up to ${this.timing.signInMs / 1000} s. A "Login failed" line means the token was rejected: the snapshot is marked stale and the next step hands over to you.`
            : `Skipped on this path: with no token the client waits on its login page, so the switch hands over to you at once (next step).`,
    });

    step({
      id: STEP.manual,
      kind: 'wait',
      title: 'Wait for you to sign in',
      target: logDir,
      skipped: strategy === 'remembered',
      detail:
        strategy === 'remembered'
          ? `Runs only if the client rejects the stored token or does not sign in within ${this.timing.signInMs / 1000} s. The client stays on its login page; you sign in there once as ${login}${
              account.hasSecret ? ' (the password can be copied from One Launch)' : ''
            } with "Keep me logged in" on, and One Launch continues with the game as soon as the log reports the sign-in, up to ${this.timing.manualSignInMs / 60_000} min.`
          : `The client opens on its login page, showing the last account it signed in as. Click "Switch account" there, pick or type ${login}, and sign in${
              account.hasSecret ? ' (the password can be copied from One Launch)' : ''
            } with "Keep me logged in" on. One Launch continues with the game as soon as the log reports the sign-in, up to ${this.timing.manualSignInMs / 60_000} min. Signing in as a different Battle.net account than the one linked to ${account.displayName} ends the switch and rolls everything back.`,
    });

    step({
      id: STEP.recapture,
      kind: 'backup',
      title: 'Save the new session',
      target: UNIFIED_AUTH_PATH,
      skipped: strategy === 'remembered',
      detail:
        strategy === 'remembered'
          ? 'Runs only after a manual sign-in: the fresh UnifiedAuth value replaces the stale snapshot.'
          : `Once the sign-in is reported, read the UnifiedAuth value the client wrote at that sign-in (up to ${this.timing.captureMs / 1000} s), store it, encrypted, as ${account.displayName}'s session snapshot, and record the account id on the account. Later switches use the remembered path.`,
    });

    if (config.text === null) {
      warnings.push(
        `${config.path} does not exist. One Launch never creates it; the saved-accounts step is skipped and the client will write the file at its next exit.`,
      );
    } else if (config.error) {
      warnings.push(`${config.path} could not be parsed (${config.error}). The saved-accounts step is skipped; the rest of the switch does not depend on it.`);
    } else if (config.roundTrips === false) {
      warnings.push(
        `${config.path} has a layout One Launch cannot reproduce exactly, so the saved-accounts step is skipped rather than rewriting the file differently.`,
      );
    }
    if (config.client && config.client.autoLogin !== null && config.client.autoLogin.toLowerCase() !== 'true') {
      warnings.push(
        `"Keep me logged in" (Client.AutoLogin) is ${config.client.autoLogin} in Battle.net.config, so the client will not sign in on its own from a token. One Launch never changes that setting: turn it on on the client's login page, and the next sign-in is remembered.`,
      );
    }
    if (hides)
      warnings.push(
        `The current account's Battle.net preferences close to the system tray instead of exiting (${prefsFile?.path ?? 'per-account config'}: HideOnClose). The close step will wait ${this.timing.shutdownMs / 1000} s and then force-close the client.`,
      );
    if (prompts)
      warnings.push(
        `The current account's Battle.net preferences show an exit prompt on close (DisplayExitPrompt). Confirm it in the client window, or the close step force-closes the client after ${this.timing.shutdownMs / 1000} s.`,
      );
    if (usesStored && fileWrite === null && !inPlace) {
      warnings.push(
        `${login} cannot be put first in Client.SavedAccountNames (see the saved-accounts step), and the client only accepts the token of the login that is first, so it will ask for the password.`,
      );
    }
    if (current.tokens.length > 1)
      warnings.push(
        `UnifiedAuth holds ${current.tokens.length} values; the client is expected to keep one. The value matching a stored snapshot is treated as the session, the others as leftovers.`,
      );
    if (alreadyActive) {
      notes.push(`Battle.net is running and signed in as ${account.displayName}. The real switch would change nothing and would leave the client running.`);
    } else if (inPlace) {
      notes.push(`Battle.net already remembers ${account.displayName}'s session, so it is only started.`);
    } else if (running) {
      warnings.push(
        `Battle.net is running${current.owner ? ` as ${current.owner.displayName}` : current.loggedUid ? ' as an account not linked to One Launch' : ' on its login page'}. It will be closed.`,
      );
    }
    if (running && !inPlace && current.loggedUid && current.owner === null) {
      warnings.push(
        `The client's current sign-in (Battle.net account ${idTail(current.loggedUid)}) is not linked to any One Launch account, so its session will not be saved.`,
      );
    }
    if (stored?.staleReason && !inPlace) {
      warnings.push(
        `The stored session for ${account.displayName} was rejected by the client (${stored.staleReason}). You will sign in once by hand and One Launch will store the fresh session.`,
      );
    }
    if (strategy === 'credentials' && !stored && !inPlace) {
      warnings.push(
        `No session snapshot is stored for ${account.displayName} yet. The client will open on its login page; sign in once with "Keep me logged in" on and One Launch captures the session for later switches.${
          account.hasSecret ? '' : ' No password is stored in One Launch, so have it ready.'
        }`,
      );
    }
    if (!inPlace && current.remembered && outgoing === null) {
      warnings.push(
        `The client currently remembers a session that no One Launch account owns (fingerprint ${shortFingerprint(current.fingerprint)}). It will be removed. The backup taken before this switch keeps a copy and is left out of the usual clean-up, so restoring it from Settings › Backups brings that sign-in back.`,
      );
    }
    if (stored && account.launcherUid && stored.launcherUid && stored.launcherUid.toLowerCase() !== account.launcherUid.toLowerCase()) {
      warnings.push(
        `The account id on this account (${idTail(account.launcherUid)}) differs from the one recorded with its session snapshot (${idTail(stored.launcherUid)}). The snapshot's id is used to confirm the sign-in.`,
      );
    }

    const plan: SwitchPlan = {
      launcher: 'battlenet',
      account: { id: account.id, displayName: account.displayName, login: account.login, launcherUid: expectedUid },
      strategy,
      current: { mostRecentLogin: current.owner?.login ?? null, autoLoginUser: config.client?.savedAccountNames[0] ?? null, running },
      steps,
      warnings,
      notes,
      executable: true,
      generatedAt: new Date().toISOString(),
    };
    return {
      plan,
      ctx: { install, startExe, config, current, stored, strategy, inPlace, alreadyActive, running, prefs, loginFirst: fileWrite?.noop === true },
    };
  }

  /** The registry value name recorded in an account's snapshot, without decrypting the token itself. */
  private storedValueName(accountId: string | null): string | null {
    if (!accountId) return null;
    try {
      const json = this.deps.sessions.decrypt(accountId);
      return json ? parseBlob(json).unifiedAuth.name : null;
    } catch {
      return null;
    }
  }

  /**
   * The real switch. Order: close → save the outgoing token → snapshot → write UnifiedAuth →
   * rotate SavedAccountNames → start → confirm from the log. A rejected or missing session hands
   * over to the user for one manual sign-in, after which the fresh token is captured. Anything
   * that fails after the first modification is rolled back from the snapshot, with the client
   * left closed.
   */
  private async runSwitch(account: AccountRef, opts: SwitchOptions): Promise<SwitchResult> {
    const startedAt = new Date().toISOString();
    const { plan, ctx } = await this.buildSwitchPlan(account);
    const { install, startExe, config } = ctx;
    const login = account.login;
    const logDir = this.logDir();

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
      launcher: 'battlenet',
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
    let handedOver = false;
    const stopIfAborted = (): void => {
      if (opts.signal?.aborted) throw new SwitchAbortedError();
    };
    let expectedUid = plan.account.launcherUid?.toLowerCase() ?? null;
    /** Fingerprint of what we left under UnifiedAuth, so a client rewrite can be told apart from our own write. */
    let writtenFingerprint: string | null = ctx.current.fingerprint;
    /** The target login is first in SavedAccountNames, so a rejection means the token itself is bad. */
    let listReady = false;

    /** Runs once the client is closed: the token then belongs to the last run's sign-in, which its log names. */
    const saveOutgoing = async (): Promise<void> => {
      const i = index.get(STEP.capture);
      if (i === undefined || steps[i]!.status === 'skipped') return;
      mark(STEP.capture, 'running');
      try {
        const fresh = await this.currentSession(false);
        const owner = fresh.owner;
        if (!fresh.token) {
          mark(STEP.capture, 'done', 'The client left no remembered session behind (signed out).');
          return;
        }
        if (!owner || !owner.id) {
          mark(STEP.capture, 'done', 'The remembered session belongs to no One Launch account; left alone.');
          return;
        }
        const known = this.deps.sessions.get(owner.id);
        if (known && known.fingerprint === fresh.fingerprint) {
          mark(STEP.capture, 'done', `${owner.displayName}'s stored session is already current.`);
          return;
        }
        this.storeSession({ ...owner, id: owner.id }, { v: 1, unifiedAuth: fresh.token }, owner.launcherUid ?? fresh.loggedUid);
        mark(STEP.capture, 'done', `Saved ${owner.displayName}'s session (fingerprint ${shortFingerprint(fresh.fingerprint)}).`);
      } catch (err) {
        // Best effort: a missed refresh costs one manual sign-in later, never the switch.
        this.log.warn('could not save the outgoing battlenet session', { error: errorText(err) });
        mark(STEP.capture, 'done', `Not saved: ${errorText(err)}`);
      }
    };
    const takeSnapshot = async (): Promise<void> => {
      mark(STEP.backup, 'running');
      const tokens = await this.readTokens();
      // The client is closed by now, so the token is final: one that nobody owns is about to be removed, and this snapshot is its only copy.
      const unowned = !ctx.inPlace && (await this.holdsUnownedSession());
      const snapshot = this.deps.backups.snapshot({
        launcher: 'battlenet',
        reason: `Before switching to ${account.displayName}`,
        files: config.text !== null ? [{ source: config.path, relative: 'Battle.net.config' }] : [],
        meta: { unifiedAuth: this.encryptTokens(tokens) },
        ...(unowned ? { pinned: UNOWNED_SESSION_PIN } : {}),
      });
      backupId = snapshot.id;
      opts.onBackup?.(snapshot.id);
      mark(STEP.backup, 'done', snapshot.path);
    };
    /** The stored token is decrypted here and nowhere else, written once, and dropped. */
    const writeRegistry = async (): Promise<void> => {
      mark(STEP.registry, 'running');
      let blob: BattlenetSessionBlob | null = null;
      if (plan.strategy === 'remembered' && account.id) {
        const json = this.deps.sessions.decrypt(account.id);
        if (!json) throw new SwitchBlockedError(`No session snapshot is stored for ${account.displayName}.`);
        blob = parseBlob(json);
      }
      const existing = await this.readTokens();
      let changes = 0;
      if (blob) {
        const same = existing.find((t) => t.name.toLowerCase() === blob!.unifiedAuth.name.toLowerCase());
        if (!same || same.hex !== blob.unifiedAuth.hex) {
          modified = true;
          await this.deps.registry.setBinary('HKCU', UNIFIED_AUTH_KEY, blob.unifiedAuth.name, blob.unifiedAuth.hex);
          changes++;
        }
      }
      for (const t of existing) {
        if (blob && t.name.toLowerCase() === blob.unifiedAuth.name.toLowerCase()) continue;
        modified = true;
        await this.deps.registry.deleteValue('HKCU', UNIFIED_AUTH_KEY, t.name);
        changes++;
      }
      writtenFingerprint = blob ? fingerprintOf(blob.unifiedAuth.hex) : null;
      if (changes === 0) {
        mark(STEP.registry, 'skipped', blob ? 'Already in place.' : 'Already signed out.');
      } else {
        mark(
          STEP.registry,
          'done',
          blob ? `UnifiedAuth now holds the snapshot (fingerprint ${shortFingerprint(writtenFingerprint)}).` : 'UnifiedAuth cleared.',
        );
      }
    };
    const writeFile = (): void => {
      const i = index.get(STEP.file);
      if (i === undefined || steps[i]!.status === 'skipped') {
        listReady = ctx.loginFirst;
        return;
      }
      mark(STEP.file, 'running');
      if (config.text === null || !existsSync(config.path)) {
        mark(STEP.file, 'skipped', 'Battle.net.config is missing; One Launch never creates it.');
        return;
      }
      // Re-read: the client rewrote the file at its exit, after the plan was built.
      const text = readFileSync(config.path, 'utf8');
      let write: ReturnType<typeof planSavedAccountNames>;
      try {
        write = planSavedAccountNames(text, login);
      } catch (err) {
        if (err instanceof BattlenetConfigError) {
          mark(STEP.file, 'skipped', `Left alone: ${err.message}`);
          return;
        }
        throw err;
      }
      if (write.noop) {
        listReady = true;
        mark(STEP.file, 'skipped', `${login} is already first in Client.SavedAccountNames.`);
        return;
      }
      modified = true;
      writeFileAtomic(config.path, write.text);
      listReady = true;
      mark(STEP.file, 'done', `${login} is now first of ${plural(write.after.length, 'saved account')}.`);
    };
    /** Something other than this switch started the client. Before the writes nothing is lost by stopping; after them the catch block rolls back. */
    const startedMeanwhile = (at: string): Error => {
      mark(at, 'running');
      return new Error(
        `Battle.net was started by something else while One Launch was switching accounts, so the switch ${modified ? 'was stopped' : 'stopped before changing anything'}. Try again.`,
      );
    };
    let logAt: LogMark = logMark(logDir);
    const startClient = async (): Promise<void> => {
      mark(STEP.start, 'running');
      stopIfAborted();
      logAt = logMark(logDir);
      launcherStarted = true;
      await this.deps.processes.start(startExe, [], { cwd: install.installDir });
      mark(STEP.start, 'done', 'Client started.');
      mark(STEP.wait, 'running');
      if (!(await this.waitUntil(() => this.isRunning(), this.timing.startupMs, opts.signal))) {
        throw new Error(`${BATTLENET_EXE} did not appear within ${this.timing.startupMs / 1000} s`);
      }
      mark(STEP.wait, 'done', `${BATTLENET_EXE} is running.`);
    };
    /** Polls the client log. During a manual wait a failed attempt (wrong password) is not final. */
    const waitForSignIn = async (timeoutMs: number, manual: boolean): Promise<SignInWait> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (opts.signal?.aborted) return { kind: 'cancelled' };
        const last = lastSignIn(eventsSince(logDir, logAt));
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
          ? `Battle.net signed in as ${who}, which is another One Launch account, instead of ${account.displayName}. Sign in to the client as ${login}.`
          : `Battle.net signed in as ${who} instead of ${account.displayName} (${idTail(expectedUid)}). Sign in to the client as ${login}, or fix the account ID on the account page.`,
      );
    };
    /** A first confirmed sign-in is where the account's Battle.net id comes from. Throws when another account holds it. */
    const linkIfNew = (signedInAs: string): string => {
      if (!account.id || !signedInAs || expectedUid !== null) return '';
      this.deps.accounts.setLauncherUid(account.id, signedInAs);
      expectedUid = signedInAs;
      this.log.info('battlenet account id linked', { accountId: account.id });
      return ` Linked to Battle.net account ${idTail(signedInAs)}.`;
    };
    const confirmSignIn = async (): Promise<SignInWait> => {
      if (plan.strategy === 'credentials') {
        // No token: the client waits on its login page. Look once (it may already be signed in), then hand over.
        const r = await waitForSignIn(1, false);
        if (r.kind === 'signed-in') mark(STEP.verify, 'done', `Signed in as ${login}.${linkIfNew(r.accountId)}`);
        else if (r.kind === 'wrong-account') mark(STEP.verify, 'failed', 'Signed in as a different account.');
        else mark(STEP.verify, 'skipped', 'Handed over to you: the client is on its login page.');
        return r.kind === 'failed' ? { kind: 'timeout' } : r;
      }
      mark(STEP.verify, 'running');
      const r = await waitForSignIn(this.timing.signInMs, false);
      if (r.kind === 'signed-in') mark(STEP.verify, 'done', `Signed in as ${login}.${linkIfNew(r.accountId)}`);
      else if (r.kind === 'wrong-account') mark(STEP.verify, 'failed', 'Signed in as a different account.');
      else if (r.kind === 'failed') mark(STEP.verify, 'failed', `The client rejected the session: ${r.reason || 'no reason given'}.`);
      else if (r.kind === 'timeout') mark(STEP.verify, 'failed', 'The client did not report a sign-in in time.');
      else mark(STEP.verify, 'failed', 'Cancelled.');
      return r;
    };
    const waitForManualSignIn = async (why: SignInWait): Promise<SignInWait> => {
      const until = new Date(Date.now() + this.timing.manualSignInMs).toISOString();
      const cause = plan.strategy === 'credentials' ? 'new' : why.kind === 'failed' ? 'expired' : 'other';
      const attention = attentionFor(login, cause, why.kind === 'failed' ? why.reason : null, account.hasSecret && Boolean(opts.getPassword), until);
      mark(STEP.manual, 'running', attention.title);
      this.log.warn('battlenet switch waiting for manual sign-in', { accountId: account.id, cause, backupId });
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
    /** After a confirmed sign-in: store the token the client wrote at that sign-in. */
    const captureFresh = async (waitMs: number): Promise<void> => {
      if (!account.id) return;
      mark(STEP.recapture, 'running');
      const deadline = Date.now() + waitMs;
      for (;;) {
        const tokens = await this.readTokens();
        const fresh = tokens.find((t) => fingerprintOf(t.hex) !== writtenFingerprint) ?? null;
        if (fresh) {
          this.storeSession({ ...account, id: account.id }, { v: 1, unifiedAuth: fresh }, expectedUid);
          this.deps.sessions.markVerified(account.id);
          mark(STEP.recapture, 'done', `Stored ${account.displayName}'s session (fingerprint ${shortFingerprint(fingerprintOf(fresh.hex))}).`);
          return;
        }
        if (Date.now() >= deadline || opts.signal?.aborted) {
          const kept = tokens[0] ?? null;
          if (kept && this.deps.sessions.get(account.id)?.fingerprint === fingerprintOf(kept.hex)) {
            this.deps.sessions.markVerified(account.id);
            mark(STEP.recapture, 'done', 'The stored session is current.');
          } else {
            mark(STEP.recapture, 'done', 'The client has not written a new token yet; it is saved at the next switch.');
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
          ? `Stopped waiting for the sign-in as ${login}. Battle.net was left on its login page; signing in there finishes the switch, and the session is saved at the next one.`
          : `Stopped while Battle.net was starting as ${login}. Nothing was rolled back: the client carries on signing in on its own.`,
      });
    const needsSignInResult = (): SwitchResult =>
      result(false, {
        backupId,
        restored: null,
        cancelled: false,
        needsSignIn: true,
        error: `One Launch waited ${this.timing.manualSignInMs / 60_000} min for the sign-in as ${login} and gave up. Battle.net is still on its login page: sign in there, and the session is saved at the next switch.`,
      });

    this.log.info('battlenet switch started', {
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
      // A running client rewrites its token at the next sign-in and its config at exit, so nothing is read or written against one.
      if (!ctx.alreadyActive && (await this.isRunning())) throw startedMeanwhile(STEP.close);

      await saveOutgoing();
      if (!ctx.alreadyActive && !ctx.inPlace) {
        await takeSnapshot();
        await writeRegistry();
        writeFile();
      }

      if (await this.isRunning()) {
        if (!ctx.alreadyActive) throw startedMeanwhile(STEP.start);
        mark(STEP.start, 'skipped', 'The client is already running.');
        mark(STEP.wait, 'skipped', 'The client is already running.');
      } else {
        await startClient();
      }

      if (ctx.alreadyActive && ctx.running) {
        mark(STEP.verify, 'skipped', 'The client is already signed in as this account.');
      } else {
        let r = await confirmSignIn();
        if (r.kind === 'cancelled') return cancelledResult();
        if (r.kind === 'wrong-account') throw wrongAccount(r);
        if (r.kind === 'signed-in' && account.id && plan.strategy === 'remembered') {
          // The client rotates the token at every sign-in; keep the snapshot current.
          await captureFresh(0);
        }
        if (r.kind !== 'signed-in') {
          if (r.kind === 'failed' && account.id && plan.strategy === 'remembered' && listReady)
            this.deps.sessions.markStale(account.id, r.reason || 'rejected by the client');
          r = await waitForManualSignIn(r);
          if (r.kind === 'cancelled') return cancelledResult();
          if (r.kind === 'wrong-account') throw wrongAccount(r);
          if (r.kind !== 'signed-in') return needsSignInResult();
          await captureFresh(this.timing.captureMs);
        }
        readyAt = new Date(Date.now() + this.timing.readyGraceMs).toISOString();
      }

      this.log.info('battlenet switch finished', { accountId: account.id, backupId, modified });
      return result(true, { backupId, restored: null, error: null, needsSignIn: false, cancelled: false, readyAt });
    } catch (err) {
      const cancelled = err instanceof SwitchAbortedError;
      const message = cancelled ? `Stopped before Battle.net was started as ${login}.` : errorText(err);
      if (current) mark(current, 'failed', cancelled ? 'Stopped.' : message);
      if (cancelled) this.log.info('battlenet switch stopped', { accountId: account.id, backupId, modified, launcherStarted });
      else if (!modified && isRefusal(err)) this.log.warn('battlenet switch refused', { accountId: account.id, code: refusalCode(err), error: err });
      else this.log.error('battlenet switch failed', { accountId: account.id, backupId, modified, error: err });
      if (cancelled && launcherStarted) return cancelledResult();
      if (!modified) {
        return result(false, { backupId, restored: null, error: cancelled ? `${message} Nothing had been changed.` : message, needsSignIn: false, cancelled });
      }
      if (!backupId)
        return result(false, { backupId, restored: false, error: `${message} (no backup was available to restore)`, needsSignIn: false, cancelled });
      try {
        // The client rewrites the token at sign-in and the config at exit, so make sure it is down first. Never interrupted: no signal.
        if (await this.isRunning()) await this.shutdown().catch((e: unknown) => this.log.warn('could not close the client before rollback', { error: e }));
        const restored = await this.applyRestore(backupId);
        this.log.warn('battlenet switch rolled back from backup', { backupId, files: restored.files.length, registry: restored.registry.length });
        return result(false, { backupId, restored: true, error: message, needsSignIn: false, cancelled });
      } catch (restoreErr) {
        this.log.error('battlenet rollback failed', { backupId, error: restoreErr });
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

  // --- backup meta -------------------------------------------------------------

  /** Registry values for the snapshot manifest: names in the clear, bytes vault-encrypted. */
  private encryptTokens(tokens: readonly TokenValue[]): string {
    return JSON.stringify(tokens.map((t) => ({ name: t.name, enc: this.deps.vault.encrypt(t.hex).toString('base64') })));
  }

  private decryptTokens(meta: unknown): TokenValue[] {
    if (typeof meta !== 'string') return [];
    const raw: unknown = JSON.parse(meta);
    if (!Array.isArray(raw)) throw new Error('Snapshot meta has an unexpected shape');
    return raw.map((item) => {
      const o = item as { name?: unknown; enc?: unknown };
      if (typeof o.name !== 'string' || typeof o.enc !== 'string') throw new Error('Snapshot meta has an unexpected shape');
      return { name: o.name, hex: this.deps.vault.decrypt(Buffer.from(o.enc, 'base64')).toLowerCase() };
    });
  }

  // --- restore ---------------------------------------------------------------

  async restoreBackup(id: string): Promise<RestoreResult> {
    await this.requireInstall();
    if (await this.isRunning()) {
      throw new LauncherRunningError(
        'Close Battle.net before restoring: it rewrites its token at sign-in and Battle.net.config at exit, which would undo the restore.',
      );
    }
    // The state being replaced is itself worth keeping: a restore of the wrong snapshot can then be undone.
    const config = this.configPath();
    this.deps.backups.snapshot({
      launcher: 'battlenet',
      reason: `Before restoring ${id}`,
      files: existsSync(config) ? [{ source: config, relative: 'Battle.net.config' }] : [],
      meta: { unifiedAuth: this.encryptTokens(await this.readTokens()) },
      protect: id,
      ...((await this.holdsUnownedSession()) ? { pinned: UNOWNED_SESSION_PIN } : {}),
    });
    return this.applyRestore(id);
  }

  /** Whether the client, as it is now, remembers a session that no One Launch account owns. Only meaningful while the client is closed. */
  private async holdsUnownedSession(): Promise<boolean> {
    const session = await this.currentSession(false);
    return session.remembered && !session.owner?.id;
  }

  /**
   * UnifiedAuth exactly as recorded (snapshot values written, any other value removed), then the
   * files. The token meta is decrypted first, so a vault failure stops the restore before anything
   * has been touched.
   */
  private async applyRestore(id: string): Promise<RestoreResult> {
    const meta = this.deps.backups.meta('battlenet', id);
    const wanted = 'unifiedAuth' in meta ? this.decryptTokens(meta['unifiedAuth']) : null;
    const { restored } = this.deps.backups.restore('battlenet', id, [this.configPath()]);
    const lines: string[] = [];
    if (wanted !== null) {
      const existing = await this.readTokens();
      for (const t of wanted) {
        await this.deps.registry.setBinary('HKCU', UNIFIED_AUTH_KEY, t.name, t.hex);
        lines.push(`UnifiedAuth\\${t.name} = ${describeToken(t)}`);
      }
      for (const t of existing) {
        if (wanted.some((w) => w.name.toLowerCase() === t.name.toLowerCase())) continue;
        await this.deps.registry.deleteValue('HKCU', UNIFIED_AUTH_KEY, t.name);
        lines.push(`UnifiedAuth\\${t.name} (removed)`);
      }
    }
    this.log.warn('battlenet backup restored', { id, files: restored.length, registry: lines.length });
    return { launcher: 'battlenet', id, files: restored, registry: lines };
  }

  // --- health ------------------------------------------------------------------

  async healthCheck(known?: KnownLauncherState): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    const add = (id: string, label: string, status: HealthStatus, detail: string): void => {
      checks.push({ id, label, status, detail });
    };
    const report = (): HealthReport => ({ launcher: 'battlenet', status: worst(checks), checks, checkedAt: new Date().toISOString() });

    const install = known ? known.install : await this.detectInstall();
    let seenRunning = known?.running ?? null;
    const isRunning = async (): Promise<boolean> => (seenRunning ??= await this.isRunning());
    const chosenGone = chosenFolderCheck(this.chosenInstallDir(), install, BATTLENET_EXE);
    if (!install) {
      add(
        'install',
        'Installation',
        'absent',
        `Battle.net is not installed on this PC. Checked the Uninstall key, the battlenet:// URI handler, and ${this.defaultDir}.`,
      );
      if (chosenGone) checks.push(chosenGone);
      return { ...report(), status: 'absent' };
    }
    add(
      'install',
      'Installation',
      'ok',
      `${install.installDir} (from ${sourceLabel(install.source)}); starts ${this.startExe(install) === install.exePath ? BATTLENET_EXE : BATTLENET_LAUNCHER_EXE}`,
    );
    if (chosenGone) checks.push(chosenGone);

    let running = false;
    try {
      running = await isRunning();
      add('process', 'Process', 'ok', running ? `${BATTLENET_EXE} is running` : `${BATTLENET_EXE} is not running`);
    } catch (err) {
      add('process', 'Process', 'warn', `Could not query the process list: ${errorText(err)}`);
    }

    let games: InstalledGame[] = [];
    try {
      const entries = await this.uninstallEntries();
      games = this.gamesFrom(entries);
      const missing = entries.length - games.length;
      add(
        'uninstall',
        'Installed products',
        entries.length === 0 ? 'warn' : 'ok',
        entries.length === 0
          ? 'No Blizzard products in the Uninstall key. No Battle.net games are installed, or the Agent has never installed one.'
          : `${plural(entries.length, 'product')} in the Uninstall key: ${entries.map((e) => `${e.name} (${e.codename})`).join(', ')}${missing > 0 ? `; ${missing} without an install folder` : ''}`,
      );
    } catch (err) {
      add('uninstall', 'Installed products', 'fail', `Could not read the Uninstall key: ${errorText(err)}`);
    }

    const db = this.productDb();
    if (!existsSync(this.productDbPath())) {
      add('product-db', 'product.db', 'warn', `${this.productDbPath()} not found; launch codes come from the built-in table only.`);
    } else {
      const unknown = games.filter((g) => !this.codesFor(g.launcherGameId, db));
      const unverified = games.filter((g) => this.codesFor(g.launcherGameId, db)?.verified === false);
      add(
        'product-db',
        'product.db',
        unknown.length > 0 ? 'warn' : 'ok',
        `${plural(db.length, 'install record')}; launch codes: ${
          games
            .map((g) => {
              const c = this.codesFor(g.launcherGameId, db);
              return `${g.launcherGameId} → ${c ? `${c.programCode} / ${c.tactCode}` : 'unknown'}`;
            })
            .join(', ') || 'none needed'
        }${unknown.length > 0 ? `; no code known for ${unknown.map((g) => g.name).join(', ')}` : ''}${unverified.length > 0 ? ` (${unverified.map((g) => g.name).join(', ')}: table value, not verified on this PC)` : ''}`,
      );
    }

    const aggregate = this.aggregatePath();
    if (existsSync(aggregate)) {
      try {
        const list = parseAggregate(readLauncherText(aggregate));
        add(
          'aggregate',
          'aggregate.json',
          'ok',
          `${list.length} ${list.length === 1 ? 'entry' : 'entries'}: ${list.map((e) => `${e.name} → ${e.launchUri ?? e.tactCode}`).join(', ') || 'none'}`,
        );
      } catch (err) {
        add('aggregate', 'aggregate.json', 'warn', `Could not parse ${aggregate}: ${errorText(err)}`);
      }
    }

    const config = this.readConfig();
    if (config.text === null) {
      add('config', 'Battle.net.config', 'warn', `${config.path} not found. The client has not run for this Windows user yet.`);
    } else if (config.error || !config.client) {
      add('config', 'Battle.net.config', 'fail', `Could not parse ${config.path}: ${config.error ?? 'no Client section'}`);
    } else {
      const autoLoginOn = config.client.autoLogin === null || config.client.autoLogin.toLowerCase() === 'true';
      add(
        'config',
        'Battle.net.config',
        autoLoginOn && config.roundTrips ? 'ok' : 'warn',
        `build ${config.client.version ?? '?'}; ${plural(config.client.savedAccountNames.length, 'saved account name')}; AutoLogin=${config.client.autoLogin ?? '(absent)'}${autoLoginOn ? '' : ' (the client will not sign in on its own; turn "Keep me logged in" on in the client)'}; ${
          config.roundTrips ? 'layout reproducible' : 'layout not reproducible, so One Launch will not rewrite it'
        }`,
      );
    }

    let current: CurrentSession | null = null;
    try {
      current = await this.currentSession(running);
      const prefs = this.readUserPrefs(current.owner?.launcherUid ?? current.loggedUid);
      const who = current.remembered
        ? current.owner
          ? `belongs to ${current.owner.displayName}`
          : current.signedOut
            ? 'left over from a run that ended with a logout'
            : 'not linked to any One Launch account'
        : 'no remembered session (signed out)';
      add(
        'token',
        'Session token',
        current.tokens.length > 1 ? 'warn' : 'ok',
        `${plural(current.tokens.length, 'value')} under ${UNIFIED_AUTH_PATH}; ${who}${current.token ? ` (${describeToken(current.token)})` : ''}`,
      );
      if (prefs) {
        const closes = prefs.prefs.hideOnClose === true;
        add(
          'prefs',
          'Close behaviour',
          closes || prefs.prefs.displayExitPrompt === true ? 'warn' : 'ok',
          `${prefs.path}: HideOnClose=${prefs.prefs.hideOnClose ?? '(absent)'}, DisplayExitPrompt=${prefs.prefs.displayExitPrompt ?? '(absent)'}${closes ? ' (a window close hides the client; the switch will have to force-close it)' : ''}`,
        );
      }
    } catch (err) {
      add('token', 'Session token', 'warn', `Could not read ${UNIFIED_AUTH_PATH}: ${errorText(err)}`);
    }

    const logDir = this.logDir();
    const last = current?.lastSignIn ?? null;
    if (!existsSync(logDir)) {
      add('log', 'Client log', 'warn', `${logDir} not found. Sign-ins cannot be confirmed until the client has run once.`);
    } else {
      add(
        'log',
        'Client log',
        last === null || last.ok ? 'ok' : 'warn',
        last === null
          ? 'Readable; no sign-in in the current log'
          : last.ok
            ? `Readable; the last run signed in as account ${idTail(last.accountId)}`
            : `Readable; the last sign-in failed (${last.reason})`,
      );
    }

    const sessions = this.deps.sessions.list('battlenet');
    const stale = sessions.filter((s) => s.staleReason !== null).length;
    add(
      'sessions',
      'Session snapshots',
      stale > 0 ? 'warn' : 'ok',
      `${plural(sessions.length, 'snapshot')} stored${stale > 0 ? `, ${stale} marked stale` : ''}`,
    );

    const snapshots = this.deps.backups.list('battlenet').length;
    add('backups', 'Backups', 'ok', snapshots === 0 ? 'No snapshots yet' : `${plural(snapshots, 'snapshot')} available for restore`);

    return report();
  }
}

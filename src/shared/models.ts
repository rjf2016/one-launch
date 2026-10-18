/**
 * Shared domain models. Single source of truth for main, preload, and renderer.
 * Nothing in this file may import from Electron or Node.
 */

export type LauncherId = 'steam' | 'epic' | 'battlenet' | 'riot';

export const LAUNCHER_IDS = ['steam', 'epic', 'battlenet', 'riot'] as const satisfies readonly LauncherId[];

export const LAUNCHER_DISPLAY_NAMES: Readonly<Record<LauncherId, string>> = {
  steam: 'Steam',
  epic: 'Epic Games',
  battlenet: 'Battle.net',
  riot: 'Riot Games',
};

/** The program a switch closes and starts, as it reads mid-sentence. Riot Games is the company; the client is what closes. */
export const LAUNCHER_CLIENT_NAMES: Readonly<Record<LauncherId, string>> = {
  steam: 'Steam',
  epic: 'Epic Games Launcher',
  battlenet: 'Battle.net',
  riot: 'the Riot Client',
};

/** The file Locate in Settings asks for. Battle.net's shortcuts point at "Battle.net Launcher.exe" next to it, which is accepted too. */
export const LAUNCHER_EXE_NAMES: Readonly<Record<LauncherId, string>> = {
  steam: 'steam.exe',
  epic: 'EpicGamesLauncher.exe',
  battlenet: 'Battle.net.exe',
  riot: 'RiotClientServices.exe',
};

export function isLauncherId(value: unknown): value is LauncherId {
  return typeof value === 'string' && (LAUNCHER_IDS as readonly string[]).includes(value);
}

/** An account as exposed to the renderer. Never carries the secret. */
export interface Account {
  id: string;
  launcher: LauncherId;
  displayName: string;
  login: string;
  hasSecret: boolean;
  /** A session snapshot is stored for this account (Epic, Battle.net, Riot), so a switch can sign in silently. */
  hasSession: boolean;
  launcherUid: string | null;
  tags: string[];
  notes: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Field limits shared by renderer validation and main-process enforcement. */
export const ACCOUNT_LIMITS = {
  displayName: 120,
  login: 256,
  launcherUid: 64,
  password: 1024,
  notes: 20_000,
  tagCount: 32,
  tagLength: 40,
} as const;

/** Payload for creating an account. The password travels once, over IPC, and is encrypted on arrival. */
export interface AccountCreateInput {
  launcher: LauncherId;
  displayName: string;
  login: string;
  password?: string | null;
  launcherUid?: string | null;
  tags?: string[];
  notes?: string;
}

/** Editable non-secret fields. Passwords have their own set/clear flow (spec section 6). */
export interface AccountPatch {
  displayName?: string;
  login?: string;
  launcherUid?: string | null;
  tags?: string[];
  notes?: string;
}

/** Trim, drop empties, dedupe case-insensitively (first spelling wins), and cap count/length. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().slice(0, ACCOUNT_LIMITS.tagLength);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= ACCOUNT_LIMITS.tagCount) break;
  }
  return out;
}

export type ArtworkKind = 'grid' | 'hero' | 'logo';

export const ARTWORK_KINDS = ['grid', 'hero', 'logo'] as const satisfies readonly ArtworkKind[];

/** Where a game's images came from. `launcher` is the game's own icon from its launcher's install, the stand-in while no source online has a cover. */
export type ArtworkSource = 'steamgriddb' | 'steamcdn' | 'manual' | 'launcher';

/** Cached images for one game as renderer-loadable URLs on the app's own artwork protocol. */
export interface GameArtwork {
  source: ArtworkSource;
  grid: string | null;
  hero: string | null;
  logo: string | null;
  fetchedAt: string | null;
}

export interface Game {
  id: string;
  launcher: LauncherId;
  launcherGameId: string;
  name: string;
  installPath: string | null;
  installed: boolean;
  lastSeenAt: string;
  /** The launcher wants to update this game before it can run. */
  needsUpdate: boolean;
  /** Last played as reported by the launcher's own files (Steam: appmanifest LastPlayed). */
  lastPlayedAt: string | null;
  artwork: GameArtwork | null;
  /** Why the last artwork lookup found nothing, when it failed. Cleared on success. */
  artworkError: string | null;
  /** The account this game was last launched with through One Launch (launch_history, result ok). */
  lastLaunch: { accountId: string; accountName: string | null; launchedAt: string } | null;
}

/** One launcher's share of a library scan. `installed` is false when the launcher was not found; `error` is set when its scan failed. */
export interface LibraryScanResult {
  launcher: LauncherId;
  added: number;
  updated: number;
  removed: number;
  installed: boolean;
  error: string | null;
}

export type LaunchResult = 'ok' | 'failed' | 'cancelled';

export interface LaunchHistoryEntry {
  id: string;
  gameId: string;
  accountId: string;
  launchedAt: string;
  result: LaunchResult;
}

/** A game + account pair launched successfully before, newest first, one entry per pair. */
export interface RecentLaunch {
  gameId: string;
  gameName: string;
  launcher: LauncherId;
  accountId: string;
  accountName: string;
  launchedAt: string;
}

/** Background artwork queue, polled by the renderer. */
export interface ArtworkStatus {
  queued: number;
  running: number;
  /** Games processed since the app started. */
  completed: number;
  failed: number;
  /** A SteamGridDB key is stored in the vault. */
  hasApiKey: boolean;
  /**
   * Bumps whenever the games or artwork tables change (scan, fetch, manual override). The renderer
   * reloads the library when it moves, so background work shows up without a push channel.
   */
  revision: number;
  /** A library scan has finished since the app started, even one that failed. Until then an empty library is still being scanned, not empty. */
  scanned: boolean;
}

/**
 * Keys for secrets that live in the vault (not account passwords, which live on the account row).
 * Adding a key here is the only way the renderer can address a secret.
 */
export type SecretKey = 'steamgriddb.apiKey' | 'diagnostics.roundtrip' | 'vault.probe';

export const SECRET_KEYS = ['steamgriddb.apiKey', 'diagnostics.roundtrip', 'vault.probe'] as const satisfies readonly SecretKey[];

/** The secrets the renderer may set or delete. vault.probe belongs to main: a wrong value there reads as a lost vault key. */
export type RendererSecretKey = Exclude<SecretKey, 'vault.probe'>;

export const RENDERER_SECRET_KEYS = ['steamgriddb.apiKey', 'diagnostics.roundtrip'] as const satisfies readonly RendererSecretKey[];

/** The web pages the renderer may ask main to open in the system browser (`app:openUrl`). Main holds the URLs; the renderer only names a target. */
export const OPEN_URL_TARGETS = ['steamgriddb-api-key'] as const;
export type OpenUrlTarget = (typeof OPEN_URL_TARGETS)[number];

export function isSecretKey(value: unknown): value is SecretKey {
  return typeof value === 'string' && (SECRET_KEYS as readonly string[]).includes(value);
}

/** Plain (non-secret) settings. Values are strings; parse at the edge. */
export type SettingKey =
  | 'dryRun'
  | 'logLevel'
  | 'artwork.autoFetch'
  | 'backups.keep'
  | 'epic.launchUri'
  | 'battlenet.launch'
  | 'steam.autoLogin'
  | 'riot.pressPlay'
  | 'steam.path'
  | 'epic.path'
  | 'battlenet.path'
  | 'riot.path'
  | 'window.bounds'
  | 'window.closeToTray'
  | 'firstRun.dismissed'
  | 'updates.auto'
  | 'whatsNew.enabled'
  | 'whatsNew.lastSeen';

export const SETTING_KEYS = [
  'dryRun',
  'logLevel',
  'artwork.autoFetch',
  'backups.keep',
  'epic.launchUri',
  'battlenet.launch',
  'steam.autoLogin',
  'riot.pressPlay',
  'steam.path',
  'epic.path',
  'battlenet.path',
  'riot.path',
  'window.bounds',
  'window.closeToTray',
  'firstRun.dismissed',
  'updates.auto',
  'whatsNew.enabled',
  'whatsNew.lastSeen',
] as const satisfies readonly SettingKey[];

/**
 * The launcher folder the user pointed One Launch at, tried before the registry. One Launch starts
 * the executable in it, so it is only ever written by main, from a file the user picked in main's
 * own dialog (launchers:locate); settings:set refuses it.
 */
export const LAUNCHER_PATH_SETTINGS = {
  steam: 'steam.path',
  epic: 'epic.path',
  battlenet: 'battlenet.path',
  riot: 'riot.path',
} as const satisfies Record<LauncherId, SettingKey>;

/** Settings main owns; the renderer may read but not write them. */
export const MAIN_ONLY_SETTING_KEYS: readonly SettingKey[] = ['window.bounds', 'steam.path', 'epic.path', 'battlenet.path', 'riot.path'];

/**
 * How launchGame starts a Battle.net game. 'exec' (default) runs Battle.net.exe --exec="launch <program code>";
 * 'uri' sends battlenet://game/<tact code>, which in a running client only opens the game's page (seen 2026-09-13).
 */
export type BattlenetLaunchForm = 'exec' | 'uri';

export const BATTLENET_LAUNCH_FORMS = ['exec', 'uri'] as const satisfies readonly BattlenetLaunchForm[];

export function isBattlenetLaunchForm(value: unknown): value is BattlenetLaunchForm {
  return typeof value === 'string' && (BATTLENET_LAUNCH_FORMS as readonly string[]).includes(value);
}

/**
 * Which com.epicgames.launcher:// form launchGame sends. 'catalog' is the CatalogNamespace:CatalogItemId:AppName
 * triple the launcher writes into its own desktop shortcuts; 'appname' is the older AppName-only form.
 */
export type EpicLaunchUriForm = 'catalog' | 'appname';

export const EPIC_LAUNCH_URI_FORMS = ['catalog', 'appname'] as const satisfies readonly EpicLaunchUriForm[];

export function isEpicLaunchUriForm(value: unknown): value is EpicLaunchUriForm {
  return typeof value === 'string' && (EPIC_LAUNCH_URI_FORMS as readonly string[]).includes(value);
}

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && (SETTING_KEYS as readonly string[]).includes(value);
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export interface VaultStatus {
  available: boolean;
  /** 'dpapi' on Windows when safeStorage is usable; 'none' otherwise. */
  backend: 'dpapi' | 'none';
}

/** VaultStatus plus whether stored ciphertext still decrypts with this PC's key. Null until something has been stored. */
export interface VaultHealthStatus extends VaultStatus {
  readable: boolean | null;
}

/** What a vault reset removed. */
export interface VaultResetSummary {
  passwords: number;
  sessions: number;
  secrets: number;
}

/** Every mark counts from the process's creation; when Windows gives no creation time, processToNodeMs is null and the marks count from the start of the main process's JavaScript instead. */
export interface StartupMetrics {
  /** ms from process creation until the main process's JavaScript started: the exe, Chromium and any antivirus scan, which the app cannot shorten. */
  processToNodeMs: number | null;
  /** ms until the window was on screen, in its background colour, before the page loaded. */
  windowShownMs: number | null;
  /** ms until the renderer's first non-empty paint. */
  readyToShowMs: number | null;
  /** ms until the renderer finished loading its bundle; the interface is drawn a frame later. */
  didFinishLoadMs: number | null;
}

/** 'fake': an unpackaged run against in-process fake launchers (ONELAUNCH_FAKE_LAUNCHERS); nothing on the real machine is read or written. */
export type PlatformSource = 'real' | 'fake';

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  isPackaged: boolean;
  dataDir: string;
  logDir: string;
  dbPath: string;
  startup: StartupMetrics;
  platformSource: PlatformSource;
}

export type UpdateUnavailableReason = 'development' | 'custom-data-folder' | 'not-installed' | 'all-users-install';

export type UpdateFailedStep = 'check' | 'download' | 'verify';

export type UpdateStatus =
  | { state: 'unavailable'; reason: UpdateUnavailableReason }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; checkedAt: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'failed'; step: UpdateFailedStep; message: string };

// ---------------------------------------------------------------------------
// Launcher adapters (spec section 8). Everything below is renderer-visible and secret-free.
// ---------------------------------------------------------------------------

export interface LauncherInstall {
  launcher: LauncherId;
  installDir: string;
  exePath: string;
  /** Where the location came from, for diagnostics. 'user' is the folder chosen with Locate in Settings; 'launcher-file' a file the launcher itself keeps (Riot's RiotClientInstalls.json). */
  source: 'user' | 'registry-hkcu' | 'registry-hklm' | 'launcher-file' | 'default-path';
}

/** A game found by reading launcher files on disk. Not yet a library row; that mapping is Phase 3. */
export interface InstalledGame {
  launcher: LauncherId;
  launcherGameId: string;
  name: string;
  installPath: string;
  /** The library folder the game lives in (Steam has several). */
  libraryPath: string;
  sizeOnDiskBytes: number | null;
  lastPlayedAt: string | null;
  /** The launcher wants to update this game before it can run. */
  needsUpdate: boolean;
}

/** An account the launcher itself remembers (Steam: an entry in loginusers.vdf). Names and IDs only. */
export interface RememberedAccount {
  launcher: LauncherId;
  /**
   * The launcher's own account id. Empty for launchers that remember logins but not ids
   * (Battle.net's saved account names); the login identifies the entry then.
   */
  launcherUid: string;
  login: string;
  personaName: string;
  /** The launcher has kept a session/password for this account, so a switch needs no credentials. */
  rememberPassword: boolean;
  /** The account the launcher will sign in as on next start (Steam: AutoLogin/MostRecent). */
  mostRecent: boolean;
  lastLoginAt: string | null;
  /**
   * The remembered session is old enough that Steam may have expired it (spec: timestamps only; the
   * token store is never read). A switch then needs a stored password or a one-time manual sign-in.
   */
  sessionMayBeExpired: boolean;
  /** One Launch account already matching this entry (by launcher uid, then login), if any. */
  linkedAccountId: string | null;
}

/** `absent`: the launcher is not installed on this PC, which is not a problem to fix. */
export type HealthStatus = 'ok' | 'warn' | 'fail' | 'absent';

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthReport {
  launcher: LauncherId;
  status: HealthStatus;
  checks: HealthCheck[];
  checkedAt: string;
}

export type SwitchStepKind = 'process' | 'backup' | 'file' | 'registry' | 'launch' | 'wait';

export interface SwitchChange {
  /** Location within the target, e.g. a line number or a registry value name. Empty when not applicable. */
  where: string;
  before: string;
  after: string;
}

export interface SwitchPlanStep {
  /** Stable per-adapter step id, e.g. "close", "backup". The real switch reports progress against it. */
  id: string;
  kind: SwitchStepKind;
  /** Short imperative title, e.g. "Close Steam". */
  title: string;
  /** Exact target: file path, registry value, process image, or command line with secrets elided. */
  target: string;
  /** Human-readable explanation. */
  detail: string;
  /** Concrete before/after values for file and registry steps. Empty when the step is not a data change. */
  changes: SwitchChange[];
  /** True when the step is a no-op for the current state (already closed, already set, ...). */
  skipped: boolean;
}

export type SwitchStrategy = 'remembered' | 'credentials';

/** What switchAccount({ dryRun: true }) returns: every process, file, and registry key it would touch. */
export interface SwitchPlan {
  launcher: LauncherId;
  account: { id: string | null; displayName: string; login: string; launcherUid: string | null };
  strategy: SwitchStrategy;
  current: {
    /** Login of the account the launcher is currently set to sign in as, if known. */
    mostRecentLogin: string | null;
    /** Value of the launcher's auto-login registry setting, if any. */
    autoLoginUser: string | null;
    running: boolean;
  };
  steps: SwitchPlanStep[];
  /** What the user should weigh before the switch runs: the dialog stops on these. */
  warnings: string[];
  /** What the switch will not need to do (the launcher already remembers the account); shown with the plan, never a reason to stop. */
  notes: string[];
  /** False when the plan cannot run as-is (e.g. credentials path without a stored password). */
  executable: boolean;
  generatedAt: string;
}

export interface LauncherStatus {
  launcher: LauncherId;
  displayName: string;
  /** False until the adapter for this launcher ships (Epic: Phase 4, Battle.net: Phase 5). */
  implemented: boolean;
  install: LauncherInstall | null;
  /** The folder the user chose with Locate, whether or not the launcher is still in it (`install.source` says which location is in use). */
  chosenPath: string | null;
  running: boolean | null;
  health: HealthReport | null;
  /** Set when the adapter threw; the launcher "needs attention" (spec section 8.1 rule 3). */
  attention: { message: string } | null;
}

export interface BackupSnapshot {
  id: string;
  launcher: LauncherId;
  createdAt: string;
  reason: string;
  /** Relative paths inside the snapshot folder. */
  files: string[];
  bytes: number;
  /** Why this snapshot is kept out of the usual clean-up (it holds a sign-in that no One Launch account owns), or null for an ordinary one. */
  pinned: string | null;
  path: string;
}

// ---------------------------------------------------------------------------
// Real switching and launching (Phase 2 step 3).
// ---------------------------------------------------------------------------

/** A game the launcher reports as running right now. */
export interface RunningGame {
  launcher: LauncherId;
  launcherGameId: string;
  name: string;
  /** How we know: the launcher's own flag, or a process running under the game's install folder. */
  source: 'launcher' | 'process';
}

/** Everything the UI needs before asking the user to confirm a switch. Read-only. */
export interface LaunchPreflight {
  plan: SwitchPlan;
  /** The app-wide dry-run setting. When true, start() refuses and the UI shows the plan instead. */
  dryRun: boolean;
  launcherRunning: boolean;
  runningGame: RunningGame | null;
  /** True when the launcher is already set up for this account; no restart will happen. */
  alreadyActive: boolean;
  /** True when continuing would close the launcher (and any game). The UI must ask first. */
  needsConfirmation: boolean;
  /** The adapter's own sentence for what closing means (game closes, or keeps running). Set when needsConfirmation. */
  closeMessage: string | null;
  /** Set when the switch cannot run at all (credentials path, missing password, launcher missing). */
  blocked: string | null;
}

export type JobStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface JobStep {
  /** The adapter's plan step id ("close", "backup", ...), or "launch" for the game launch. The renderer groups steps into phases by it. */
  id: string;
  title: string;
  status: JobStepStatus;
  detail: string;
}

/**
 * needs-sign-in: Steam asked for a manual sign-in and the wait for it ran out. Nothing is rolled
 * back; finishing the sign-in in the Steam window completes the switch.
 * cancelled: the user stopped waiting. Steam is left where it was.
 */
export type LaunchJobState = 'running' | 'done' | 'failed' | 'needs-sign-in' | 'cancelled';

/**
 * The switch is waiting for the user to do something in the launcher's own window (Steam Guard
 * code, expired session). The job stays running until they finish, the wait times out, or they cancel.
 */
export interface LaunchAttention {
  kind: 'sign-in';
  title: string;
  /** Why the launcher needs the user, in one sentence. */
  message: string;
  /** What to do in the launcher window, in order; a checkbox the launcher must keep ticked is named in “ ” so the dialog can set it off. */
  steps?: string[];
  /** The launcher's own reason text, e.g. Steam's "Account Logon Denied". */
  reason: string | null;
  /** The account has a stored password the UI can offer to copy. */
  canCopyPassword: boolean;
  /** When the wait gives up, ISO time. */
  until: string;
}

export interface LaunchJob {
  id: string;
  state: LaunchJobState;
  launcher: LauncherId;
  account: { id: string; displayName: string; login: string };
  game: { id: string; name: string; launcherGameId: string } | null;
  steps: JobStep[];
  /** Set while the switch needs the user in the launcher window; null otherwise. */
  attention: LaunchAttention | null;
  /** The account switch itself completed (the launcher signed in as the account), whatever happened to the launch after it. */
  switched: boolean;
  /** What the user must still do in the launcher window for the game to start, when the launcher only opened its page (Riot); null when the launcher started the game. */
  handOff: string | null;
  /** Snapshot taken before any change, when one was taken. */
  backupId: string | null;
  /** After a failure: whether the backup was put back. Null when nothing had been changed. */
  restored: boolean | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RestoreResult {
  launcher: LauncherId;
  id: string;
  /** Files written back, absolute paths. */
  files: string[];
  /** Registry values put back, as "name = value" or "name (removed)". */
  registry: string[];
}

/**
 * A switch the last run did not finish, read from the switch journal at startup.
 * `writing`: One Launch went away while changing the launcher's files. `signing-in`: the files were
 * written and the launcher was starting or signing in. `rollback-failed`: the switch failed and
 * putting the snapshot back failed too.
 */
export type SwitchRecoveryPhase = 'writing' | 'signing-in' | 'rollback-failed';

export interface SwitchRecovery {
  jobId: string;
  launcher: LauncherId;
  /** Null when the account has been deleted since. */
  accountName: string | null;
  startedAt: string;
  /** The snapshot taken before the switch's first write. */
  backupId: string;
  /** False when that snapshot has been pruned or deleted; a restore is then not on offer. */
  snapshotAvailable: boolean;
  phase: SwitchRecoveryPhase;
}

// ---------------------------------------------------------------------------
// Session snapshots (Phase 4). Launchers without a native account switcher (Epic) sign in from a
// remembered-session blob in one of their files; One Launch keeps one such blob per account,
// vault-encrypted. Nothing below ever carries the blob itself, only a fingerprint of it.
// ---------------------------------------------------------------------------

/** A stored session snapshot as the renderer sees it. */
export interface LauncherSession {
  accountId: string;
  launcher: LauncherId;
  /** The launcher's own account id, learned when the session was captured or confirmed. */
  launcherUid: string | null;
  /** SHA-256 of the session blob, so the UI and plans can refer to it without exposing it. */
  fingerprint: string;
  capturedAt: string;
  /** Last time a switch confirmed the launcher signed in with this snapshot. */
  verifiedAt: string | null;
  /** Set when the launcher rejected the snapshot (expired token); a manual sign-in refreshes it. */
  staleReason: string | null;
}

/** What the launcher's own files say right now. Read-only. */
export interface LauncherSessionState {
  launcher: LauncherId;
  /** The launcher has a remembered session on disk. */
  remembered: boolean;
  /** Fingerprint of that session, when there is one. */
  fingerprint: string | null;
  /** The launcher account id that session belongs to, when the launcher's log names it. */
  launcherUid: string | null;
  /** The One Launch account that session is known to belong to, if any. */
  linkedAccountId: string | null;
  launcherRunning: boolean;
  /** The launcher's last sign-in attempt in its current log. */
  lastSignIn: { ok: boolean; reason: string | null } | null;
}
